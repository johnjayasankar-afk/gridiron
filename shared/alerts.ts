/**
 * The alert engine. It watches the PRESENTED state of each game (after any
 * display delay) and turns real changes into moments.
 *
 * Reliability rules:
 * - The first observation of a game, and the first time its play-by-play is
 *   seen, only establish a baseline. History is never announced as new.
 * - Every alert id is derived from the real-world moment (a play id, a score,
 *   a transition), so repeated polls and reconnects cannot duplicate it.
 * - A revised play updates its alerts; a play that no longer qualifies (an
 *   overturned touchdown) withdraws them. A correction never celebrates again.
 * - Plays are classified only from explicit play types and flags. A score change
 *   that no reported scoring play explains becomes "Score changed".
 * - Transitions that need a known "before" (red-zone entry, lead change,
 *   overtime) never fire from an unknown previous state.
 */
import { ADMIN_KINDS, TOUCHDOWN_KINDS, type Alert, type AlertKind, type GameDetail, type GameId, type GameSummary, type PlayEvent, type Side, type TeamKey } from './model.js';
import { isLiveOrPaused } from './model.js';
import { downDistance, leader, scoreText, spotLabel, teamFor } from './format.js';

export interface AlertRules {
  scope: 'all' | 'monitored' | 'favorites';
  enabled: Record<AlertKind, boolean>;
  bigPlayYards: number;
  closeMargin: number;
  lateSeconds: number;
}

export const ALERT_KINDS: AlertKind[] = [
  'touchdown', 'field_goal', 'safety', 'turnover', 'red_zone', 'fourth_down_attempt', 'fourth_down', 'big_play',
  'lead_change', 'tied', 'close_late', 'overtime', 'final', 'kickoff', 'review', 'score_change',
];

export const ALERT_LABELS: Record<AlertKind, string> = {
  touchdown: 'Touchdown',
  field_goal: 'Field goal',
  safety: 'Safety',
  turnover: 'Turnover',
  red_zone: 'Red-zone entry',
  fourth_down_attempt: 'Fourth-down attempt',
  fourth_down: 'Fourth-down situation',
  big_play: 'Big play',
  lead_change: 'Lead change',
  tied: 'Game tied',
  close_late: 'Close game late',
  overtime: 'Overtime begins',
  final: 'Final result',
  kickoff: 'Favorite team kickoff',
  review: 'Review or challenge',
  score_change: 'Score changed (unclassified)',
};

export const DEFAULT_ALERT_RULES: AlertRules = {
  scope: 'all',
  enabled: {
    touchdown: true,
    field_goal: true,
    safety: true,
    turnover: true,
    red_zone: false,
    fourth_down_attempt: true,
    fourth_down: false,
    big_play: true,
    lead_change: true,
    tied: true,
    close_late: true,
    overtime: true,
    final: true,
    kickoff: true,
    review: false,
    score_change: true,
  },
  bigPlayYards: 30,
  closeMargin: 8,
  lateSeconds: 300,
};

export const ALERT_PRIORITY: Record<AlertKind, 1 | 2 | 3> = {
  touchdown: 1,
  turnover: 1,
  lead_change: 1,
  overtime: 1,
  close_late: 1,
  safety: 1,
  field_goal: 2,
  fourth_down_attempt: 2,
  red_zone: 2,
  big_play: 2,
  tied: 2,
  final: 2,
  kickoff: 2,
  fourth_down: 3,
  review: 3,
  score_change: 2,
};

export interface AlertContext {
  favorites: TeamKey[];
  monitored: GameId[];
  muted: GameId[];
}

export interface AlertChange {
  type: 'created' | 'updated';
  alert: Alert;
}

export interface ObserveOptions {
  /** The observation follows a connection gap; anything new is a late update. */
  gap?: boolean;
  /** Play-by-play for this game is being loaded, so a scoring play may still arrive. Defaults to "detail is present". */
  detailExpected?: boolean;
}

interface PlayMemory {
  revision: string;
  alerts: Map<AlertKind, string>;
}

interface GameMemory {
  status: GameSummary['status']['kind'];
  period: number | null;
  score: { home: number | null; away: number | null };
  leader: Side | 'tied' | null;
  redZone: 'inside' | 'outside' | null;
  redZoneCount: number;
  fourthKey: string | null;
  closeLatePeriod: number | null;
  overtime: boolean;
  plays: Map<string, PlayMemory> | null;
  pendingScore: { home: number; away: number; at: number } | null;
  alerts: Map<string, Alert>;
}

/**
 * How long an unexplained score change waits for its scoring play before it is
 * announced on its own. Covers the slowest background detail refresh.
 */
export const SCORE_GRACE_MS = 90_000;

/** More new snaps than this in one update means updates were held up (a slow poll, an outage, a batch), so their moments are late news. */
export const BURST_PLAYS = 3;

const TURNOVER_KINDS = new Set(['interception', 'fumble_lost']);
const GAIN_KINDS = new Set(['rush', 'pass_complete', 'touchdown_rush', 'touchdown_pass', 'punt_return', 'kickoff_return']);
const SNAP_KINDS = new Set(['rush', 'pass_complete', 'pass_incomplete', 'sack', 'touchdown_rush', 'touchdown_pass', 'interception', 'fumble_lost', 'fumble', 'fumble_recovered_own']);

export class AlertEngine {
  private memory = new Map<GameId, GameMemory>();

  constructor(
    private rules: AlertRules = DEFAULT_ALERT_RULES,
    private context: AlertContext = { favorites: [], monitored: [], muted: [] },
  ) {}

  setRules(rules: AlertRules) {
    this.rules = rules;
  }

  setContext(context: AlertContext) {
    this.context = context;
  }

  /** Forget everything; the next observations become a fresh baseline (after a delay change or a mode switch). */
  reset() {
    this.memory.clear();
  }

  forget(gameId: GameId) {
    this.memory.delete(gameId);
  }

  observe(game: GameSummary, detail: GameDetail | null, at: number, options: ObserveOptions | boolean = false): AlertChange[] {
    const opts: ObserveOptions = typeof options === 'boolean' ? { gap: options } : options;
    const gap = opts.gap === true;
    const detailExpected = opts.detailExpected ?? detail !== null;
    const out: AlertChange[] = [];
    let mem = this.memory.get(game.id);
    if (!mem) {
      this.memory.set(game.id, this.baseline(game, detail));
      return out;
    }

    const emit = (kind: AlertKind, key: string, fill: Omit<Alert, 'id' | 'revision' | 'kind' | 'gameId' | 'receivedAt' | 'status' | 'priority' | 'late'> & { late?: boolean }) => {
      const id = `${game.id}:${key}`;
      if (mem!.alerts.has(id)) return;
      const alert: Alert = { id, revision: 1, kind, gameId: game.id, receivedAt: at, status: 'active', priority: ALERT_PRIORITY[kind], ...fill, late: gap || fill.late === true };
      mem!.alerts.set(id, alert);
      if (this.allowed(game, kind)) out.push({ type: 'created', alert });
    };
    const update = (id: string, patch: Partial<Alert>) => {
      const existing = mem!.alerts.get(id);
      if (!existing) return;
      const next: Alert = { ...existing, ...patch, revision: existing.revision + 1 };
      mem!.alerts.set(id, next);
      if (this.allowed(game, next.kind)) out.push({ type: 'updated', alert: next });
    };

    const st = game.status;
    const base = { team: null, period: st.period, clock: st.clock, sourceTime: null, playId: null };

    // ---- status transitions (each needs a known previous state)
    if (mem.status === 'scheduled' && isLiveOrPaused(st.kind)) {
      if (this.isFavoriteGame(game)) emit('kickoff', 'kickoff', { ...base, title: `Kickoff: ${game.away.abbreviation} at ${game.home.abbreviation}`, detail: 'A favorite team’s game has started.' });
    }
    const inOvertime = st.period !== null && st.period > st.regulationPeriods && isLiveOrPaused(st.kind);
    if (inOvertime && !mem.overtime && mem.period !== null && mem.period <= st.regulationPeriods) {
      emit('overtime', 'overtime', { ...base, title: `Overtime: ${scoreText(game)}`, detail: 'Regulation ended tied.' });
    }
    if (inOvertime) mem.overtime = true;
    if (st.kind === 'final' && mem.status !== 'final' && mem.status !== 'unknown') {
      emit('final', 'final', { ...base, title: `Final: ${scoreText(game)}`, detail: st.detail ?? 'Final' });
    }

    // ---- plays
    const newScoringPlays: PlayEvent[] = [];
    if (detail) {
      if (mem.plays === null) {
        mem.plays = new Map(detail.plays.map((p) => [p.id, { revision: p.revision, alerts: new Map() }]));
      } else {
        const present = new Set<string>();
        let unseen = 0;
        for (const p of detail.plays) if (!mem.plays.has(p.id) && !ADMIN_KINDS.has(p.kind)) unseen++;
        const burst = unseen > BURST_PLAYS;
        for (const p of detail.plays) {
          present.add(p.id);
          const known = mem.plays.get(p.id);
          if (!known) {
            const kinds = this.playAlertKinds(game, p);
            const record: PlayMemory = { revision: p.revision, alerts: new Map() };
            mem.plays.set(p.id, record);
            for (const [kind, text] of kinds) {
              const key = `${kind}:${p.providerId}`;
              emit(kind, key, { team: text.team, period: p.period, clock: p.clock, title: text.title, detail: text.detail, sourceTime: p.wallclock, playId: p.id, late: burst });
              record.alerts.set(kind, `${game.id}:${key}`);
            }
            if (p.scoring || kinds.has('touchdown') || kinds.has('field_goal') || kinds.has('safety')) newScoringPlays.push(p);
          } else if (known.revision !== p.revision) {
            known.revision = p.revision;
            const kinds = this.playAlertKinds(game, p);
            for (const [kind, id] of known.alerts) {
              const still = kinds.get(kind);
              if (still) update(id, { title: still.title, detail: `${still.detail} (Play corrected)`, status: 'corrected' });
              else update(id, { status: 'withdrawn', detail: `Play corrected: ${p.description}` });
            }
            for (const [kind, text] of kinds) {
              if (known.alerts.has(kind)) continue;
              const key = `${kind}:${p.providerId}`;
              emit(kind, key, { team: text.team, period: p.period, clock: p.clock, title: text.title, detail: `${text.detail} (Play corrected)`, sourceTime: p.wallclock, playId: p.id, late: true });
              known.alerts.set(kind, `${game.id}:${key}`);
            }
          }
        }
        for (const [id, known] of mem.plays) {
          if (present.has(id)) continue;
          for (const alertId of known.alerts.values()) update(alertId, { status: 'withdrawn', detail: 'The provider removed this play.' });
          mem.plays.delete(id);
        }
      }
    }

    // ---- score
    const { home, away } = game.score;
    const knownBefore = mem.score.home !== null && mem.score.away !== null;
    if (home !== null && away !== null && knownBefore && (home !== mem.score.home || away !== mem.score.away)) {
      const decreased = home < (mem.score.home as number) || away < (mem.score.away as number);
      const now = leader(game);
      if (!decreased) {
        if (now === 'tied' && mem.leader !== 'tied') {
          emit('tied', `tied:${away}-${home}`, { ...base, title: `Tied: ${scoreText(game)}`, detail: 'The game is level.' });
        } else if ((mem.leader === 'home' || mem.leader === 'away') && (now === 'home' || now === 'away') && now !== mem.leader) {
          const team = teamFor(game, now)!;
          emit('lead_change', `lead:${away}-${home}`, { ...base, team: now, title: `${team.abbreviation} takes the lead`, detail: scoreText(game) });
        }
      }
      if (decreased) {
        emit('score_change', `score:${away}-${home}`, { ...base, title: `Score corrected: ${scoreText(game)}`, detail: 'The provider lowered a score. No new points were scored.' });
        mem.pendingScore = null;
      } else if (newScoringPlays.length) {
        mem.pendingScore = null;
      } else if (!detailExpected || game.coverage.level === 'score-only') {
        emit('score_change', `score:${away}-${home}`, {
          ...base,
          title: `Score changed: ${scoreText(game)}`,
          detail: game.coverage.level === 'score-only'
            ? 'This game has score-only coverage, so the scoring play is not reported.'
            : 'Play-by-play is not loaded for this game, so the scoring play is not identified.',
        });
      } else {
        mem.pendingScore = { home, away, at };
      }
    } else if (newScoringPlays.length) {
      mem.pendingScore = null;
    }
    if (mem.pendingScore && at - mem.pendingScore.at >= SCORE_GRACE_MS) {
      const p = mem.pendingScore;
      mem.pendingScore = null;
      emit('score_change', `score:${p.away}-${p.home}`, { ...base, title: `Score changed: ${game.away.abbreviation} ${p.away}, ${game.home.abbreviation} ${p.home}`, detail: 'No matching scoring play has been reported yet.', late: true });
    }
    if (home !== null && away !== null) {
      mem.score = { home, away };
      mem.leader = leader(game);
    }

    // ---- situation
    const sit = game.situation;
    if (sit && isLiveOrPaused(st.kind)) {
      const progress = sit.spot.progress;
      const inside = progress === null ? null : progress >= 80;
      if (inside === true && mem.redZone === 'outside') {
        mem.redZoneCount++;
        const team = teamFor(game, sit.possession);
        emit('red_zone', `redzone:${mem.redZoneCount}:${sit.possession}:${st.period}`, {
          ...base,
          team: sit.possession,
          title: `${team?.abbreviation ?? 'Offense'} in the red zone`,
          detail: `${downDistance(sit) ?? 'Down not reported'} at ${spotLabel(sit.spot, game)}`,
        });
      }
      if (inside !== null) mem.redZone = inside ? 'inside' : 'outside';

      if (sit.down === 4) {
        const key = `${sit.possession}:${progress ?? 'unknown'}:${st.period}`;
        if (key !== mem.fourthKey) {
          mem.fourthKey = key;
          const team = teamFor(game, sit.possession);
          emit('fourth_down', `fourth:${key}`, { ...base, team: sit.possession, title: `4th down: ${team?.abbreviation ?? 'offense'}`, detail: `${downDistance(sit)} at ${spotLabel(sit.spot, game)}` });
        }
      } else if (sit.down !== null) {
        mem.fourthKey = null;
      }
    }

    const late = st.kind === 'in_progress' && st.period !== null && st.period === st.regulationPeriods && st.clockSeconds !== null && st.clockSeconds <= this.rules.lateSeconds;
    const m = home !== null && away !== null ? Math.abs(home - away) : null;
    if (late && m !== null && m <= this.rules.closeMargin && mem.closeLatePeriod !== st.period) {
      mem.closeLatePeriod = st.period;
      emit('close_late', `close:${st.period}`, {
        ...base,
        title: m === 0 ? `Tied late: ${scoreText(game)}` : `${m}-point game late`,
        detail: `${scoreText(game)} · ${st.clock ?? ''} ${st.period !== null && st.period > st.regulationPeriods ? 'in overtime' : 'left in the 4th'}`.trim(),
      });
    }

    mem.status = st.kind;
    mem.period = st.period;
    return out;
  }

  private baseline(game: GameSummary, detail: GameDetail | null): GameMemory {
    const st = game.status;
    const progress = game.situation?.spot.progress ?? null;
    const m = game.score.home !== null && game.score.away !== null ? Math.abs(game.score.home - game.score.away) : null;
    const late = st.kind === 'in_progress' && st.period !== null && st.period === st.regulationPeriods && st.clockSeconds !== null && st.clockSeconds <= this.rules.lateSeconds;
    return {
      status: st.kind,
      period: st.period,
      score: { ...game.score },
      leader: leader(game),
      redZone: progress === null ? null : progress >= 80 ? 'inside' : 'outside',
      redZoneCount: 0,
      fourthKey: game.situation?.down === 4 ? `${game.situation.possession}:${progress ?? 'unknown'}:${st.period}` : null,
      closeLatePeriod: late && m !== null && m <= this.rules.closeMargin ? st.period : null,
      overtime: st.period !== null && st.period > st.regulationPeriods,
      plays: detail ? new Map(detail.plays.map((p) => [p.id, { revision: p.revision, alerts: new Map() }])) : null,
      pendingScore: null,
      alerts: new Map(),
    };
  }

  private isFavoriteGame(game: GameSummary) {
    return this.context.favorites.includes(game.home.key) || this.context.favorites.includes(game.away.key);
  }

  private allowed(game: GameSummary, kind: AlertKind): boolean {
    if (!this.rules.enabled[kind]) return false;
    if (this.context.muted.includes(game.id)) return false;
    if (kind === 'kickoff') return this.isFavoriteGame(game);
    if (this.rules.scope === 'favorites') return this.isFavoriteGame(game);
    if (this.rules.scope === 'monitored') return this.context.monitored.includes(game.id) || this.isFavoriteGame(game);
    return true;
  }

  /** Alert kinds a play qualifies for, from explicit classification only. */
  private playAlertKinds(game: GameSummary, p: PlayEvent): Map<AlertKind, { title: string; detail: string; team: Side | null }> {
    const out = new Map<AlertKind, { title: string; detail: string; team: Side | null }>();
    const offense = teamFor(game, p.offense);
    const conversion = p.conversion
      ? ` · ${p.conversion.kind === 'kick' ? 'Extra point' : 'Two-point try'} ${p.conversion.result === 'good' ? 'good' : p.conversion.result === 'unknown' ? 'result not reported' : p.conversion.result}`
      : '';
    if (TOUCHDOWN_KINDS.has(p.kind) && p.scoring !== false) {
      const side = p.scoringTeam ?? (p.kind === 'touchdown_return' ? null : p.offense);
      const team = teamFor(game, side);
      out.set('touchdown', { team: side, title: `Touchdown ${team?.abbreviation ?? ''}`.trim(), detail: `${p.description}${conversion}` });
    }
    if (p.kind === 'field_goal_good') {
      const side = p.scoringTeam ?? p.offense;
      out.set('field_goal', { team: side, title: `Field goal ${teamFor(game, side)?.abbreviation ?? ''}`.trim(), detail: p.description });
    }
    if (p.kind === 'safety') out.set('safety', { team: p.scoringTeam, title: 'Safety', detail: p.description });
    if (p.turnover === true || TURNOVER_KINDS.has(p.kind)) {
      const gaining = p.offense ? (p.offense === 'home' ? 'away' : 'home') : null;
      const how = p.kind === 'interception' ? 'Interception' : p.kind === 'fumble_lost' ? 'Fumble lost' : 'Turnover';
      out.set('turnover', { team: gaining, title: `${how}: ${teamFor(game, gaining)?.abbreviation ?? 'defense'} ball`, detail: p.description });
    }
    if (p.yards !== null && p.yards >= this.rules.bigPlayYards && GAIN_KINDS.has(p.kind) && !p.penalty) {
      out.set('big_play', { team: p.offense, title: `Big play: +${p.yards} yards${offense ? `, ${offense.abbreviation}` : ''}`, detail: p.description });
    }
    if (p.start?.down === 4 && SNAP_KINDS.has(p.kind)) {
      const converted = TOUCHDOWN_KINDS.has(p.kind) || (p.end?.down === 1 && p.end?.spot.offense === p.offense && !p.possessionChanged);
      const failed = p.possessionChanged === true || TURNOVER_KINDS.has(p.kind);
      out.set('fourth_down_attempt', {
        team: p.offense,
        title: `4th-down try ${converted ? 'converted' : failed ? 'stopped' : ''}`.trim() + (offense ? `: ${offense.abbreviation}` : ''),
        detail: p.description,
      });
    }
    if (p.review) out.set('review', { team: null, title: `Review: ${p.review.outcome === 'unknown' ? 'outcome not reported' : p.review.outcome}`, detail: p.description });
    return out;
  }
}
