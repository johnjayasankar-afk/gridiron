/**
 * The tape: the whole day as one recording, on a shared wall clock.
 *
 * Every other view in Gridiron answers "what is happening now". A football
 * Sunday is not one game, it is a dozen running at once, and the interesting
 * thing about it is how they interleave: which game has been worth watching,
 * where the day's big swings landed, and which games are arriving at their
 * endgames together. None of that is visible in a grid of cards, because a grid
 * has no time in it.
 *
 * So the client keeps a recording. Every time the presented world changes, each
 * live game's reported state is written down with the moment it was true. That
 * is the same basis as "While you were away": a snapshot of reported data, kept
 * client side, never sent anywhere.
 *
 * Everything derived here is a MEASUREMENT of what was reported, never a model.
 * "Movement" is the sum of the changes the provider's own win probability made;
 * it is not a claim about how exciting a game was, and the interface says which
 * it is. Nothing here predicts anything, and a game whose provider reported no
 * win probability simply has no movement to show rather than an invented one.
 */
import type { GameId, GameStatusKind, GameSummary, Side } from './model.js';
import { isLiveOrPaused } from './model.js';

export interface TapeSample {
  /** When this state was true, on the wall clock: receipt time live, the replay clock in a replay. */
  at: number;
  home: number | null;
  away: number | null;
  /** The home team's chance as the provider reported it, 0 to 1. Null when none was reported. */
  wp: number | null;
  period: number | null;
  clock: string | null;
  clockSeconds: number | null;
  kind: GameStatusKind;
  possession: Side | null;
  redZone: boolean;
  /**
   * The provider's id for the play this reading followed, when one was
   * reported. It is what makes the tape a way IN rather than only a picture:
   * with it, a moment on a lane is a play on the field, and the game page
   * already opens at one. The provider part only, because the game is the track
   * it is on and the namespaced id repeats it on every sample.
   */
  play: string | null;
}

export interface TapeTrack {
  gameId: GameId;
  samples: TapeSample[];
}

/**
 * A sample is kept when something a viewer could see has changed, or when
 * enough time has passed that a steady stretch still has a point to draw
 * through. Without the first rule a quiet game writes a sample every poll and
 * the recording is mostly noise; without the second, a fifteen minute drive
 * with no scoring leaves a gap the ribbon has to guess across, and this file
 * does not guess.
 */
export const MIN_GAP_MS = 4_000;
export const HEARTBEAT_MS = 90_000;
/** Win probability moves in fractions of a point between plays; below this it is not a change. */
export const WP_EPSILON = 0.002;
/** About a full day per game at a heartbeat a minute and a half, plus every change. */
export const MAX_SAMPLES = 900;

/** `${gameId}:${providerId}` is how a play is named across Gridiron; `?play=` wants the second half. */
export function providerPlay(playId: string | null | undefined, gameId: GameId): string | null {
  if (!playId) return null;
  const prefix = `${gameId}:`;
  return playId.startsWith(prefix) ? playId.slice(prefix.length) : playId;
}

export function sampleFrom(game: GameSummary, at: number): TapeSample {
  const st = game.status;
  return {
    at,
    home: game.score.home,
    away: game.score.away,
    wp: game.winProbability ? game.winProbability.home : null,
    play: providerPlay(game.winProbability?.playId, game.id),
    period: st.period,
    clock: st.clock,
    clockSeconds: st.clockSeconds,
    kind: st.kind,
    possession: game.situation?.possession ?? null,
    redZone: game.situation?.isRedZone === true,
  };
}

/** Whether the second sample says anything the first did not. */
export function differs(a: TapeSample, b: TapeSample): boolean {
  if (a.home !== b.home || a.away !== b.away) return true;
  if (a.kind !== b.kind || a.period !== b.period) return true;
  if (a.possession !== b.possession || a.redZone !== b.redZone) return true;
  if (a.wp === null || b.wp === null) return a.wp !== b.wp;
  return Math.abs(a.wp - b.wp) >= WP_EPSILON;
}

/**
 * Adds a sample to a track, or returns the track unchanged when it adds nothing.
 * Returning the same array matters: the recorder stores tracks in React state
 * and an unchanged array lets everything downstream skip its work.
 */
export function record(track: TapeTrack, next: TapeSample): TapeTrack {
  const samples = track.samples;
  const last = samples[samples.length - 1];
  if (!last) return { ...track, samples: [next] };
  // Before the whole recording: the clock these samples are stamped with has
  // changed, so what is already here is not on the same timeline as this and
  // cannot be drawn beside it. Start again from this sample. Without this rule
  // one sample stamped with the wrong clock refuses every sample that follows
  // it for the rest of the session, and the track is dead with no sign of it.
  if (next.at < samples[0].at) return { ...track, samples: [next] };
  // Behind the last sample but inside the recording: jitter in the reading of
  // the clock rather than a new one, and that moment is already drawn.
  if (next.at < last.at) return track;
  const changed = differs(last, next);
  const waited = next.at - last.at;
  if (!changed && waited < HEARTBEAT_MS) return track;
  if (changed && waited < MIN_GAP_MS) {
    // Too soon to be its own point, but the value is newer: move the last one
    // rather than dropping the change, so a burst never loses the final state.
    const merged = samples.slice(0, -1);
    merged.push({ ...next, at: last.at });
    return { ...track, samples: merged };
  }
  const grown = samples.length >= MAX_SAMPLES ? samples.slice(samples.length - MAX_SAMPLES + 1) : samples.slice();
  grown.push(next);
  return { ...track, samples: grown };
}

export interface TapeStats {
  /** Sum of every change the reported win probability made, in probability points. Null when none was reported. */
  movement: number | null;
  /** The largest single reported change, and where it landed. */
  biggest: { swing: number; sample: TapeSample } | null;
  /** Times the lead changed hands, from the reported score. */
  leadChanges: number;
  /** The closest the score has been since the first sample, in points. Null when no score was reported. */
  closest: number | null;
  /** How long the recording covers, in milliseconds. */
  span: number;
  samples: number;
  /** Whether the game was still live at the last sample. */
  live: boolean;
}

export function tapeStats(track: TapeTrack): TapeStats {
  const s = track.samples;
  const first = s[0];
  const last = s[s.length - 1];
  if (!first || !last) {
    return { movement: null, biggest: null, leadChanges: 0, closest: null, span: 0, samples: 0, live: false };
  }
  let movement: number | null = null;
  let biggest: TapeStats['biggest'] = null;
  let leadChanges = 0;
  let closest: number | null = null;
  let lead: number | null = null;

  for (let i = 0; i < s.length; i++) {
    const cur = s[i];
    const prev = i > 0 ? s[i - 1] : null;
    if (prev && prev.wp !== null && cur.wp !== null) {
      const swing = cur.wp - prev.wp;
      movement = (movement ?? 0) + Math.abs(swing);
      if (!biggest || Math.abs(swing) > Math.abs(biggest.swing)) biggest = { swing, sample: cur };
    }
    if (cur.home !== null && cur.away !== null) {
      const diff = cur.home - cur.away;
      const gap = Math.abs(diff);
      closest = closest === null ? gap : Math.min(closest, gap);
      const side = diff === 0 ? 0 : diff > 0 ? 1 : -1;
      // A tie is not a lead change on its own; the lead changes when the other
      // side goes in front of the side that was in front.
      if (side !== 0) {
        if (lead !== null && side !== lead) leadChanges++;
        lead = side;
      }
    }
  }
  return { movement, biggest, leadChanges, closest, span: last.at - first.at, samples: s.length, live: isLiveOrPaused(last.kind) };
}

/** What the game was at a moment: the last sample at or before it, or null before the recording starts. */
export function stateAt(track: TapeTrack, at: number): TapeSample | null {
  const s = track.samples;
  if (!s.length || at < s[0].at) return null;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].at <= at) lo = mid;
    else hi = mid - 1;
  }
  return s[lo];
}

/** The window every track fits inside, or null when nothing has been recorded. */
export function tapeSpan(tracks: TapeTrack[]): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const t of tracks) {
    const s = t.samples;
    if (!s.length) continue;
    from = Math.min(from, s[0].at);
    to = Math.max(to, s[s.length - 1].at);
  }
  return from === Infinity ? null : { from, to };
}

export interface TapeRank {
  gameId: GameId;
  stats: TapeStats;
  /** Why it is placed here, in the order the interface should read them. */
  reasons: string[];
}

/**
 * The day's games in the order the recording puts them, with the measurement
 * that placed each one named.
 *
 * Live games come before finished ones, because the tape is something you read
 * during the day. Inside each group the order is the movement the provider's
 * win probability actually made, which is a measurement and is described as
 * one. Games with no reported win probability sort by lead changes, then by
 * how close they have been, and never claim a movement they do not have.
 */
export function rankByMovement(tracks: TapeTrack[]): TapeRank[] {
  const ranked = tracks
    .map((track) => {
      const stats = tapeStats(track);
      const reasons: string[] = [];
      if (stats.movement !== null) reasons.push(`${Math.round(stats.movement * 100)} points of win probability movement`);
      if (stats.leadChanges > 0) reasons.push(`${stats.leadChanges} lead change${stats.leadChanges === 1 ? '' : 's'}`);
      if (stats.biggest && Math.abs(stats.biggest.swing) >= 0.1) reasons.push(`biggest swing ${Math.round(Math.abs(stats.biggest.swing) * 100)} points`);
      return { gameId: track.gameId, stats, reasons };
    })
    .filter((r) => r.stats.samples > 0);

  ranked.sort((a, b) => {
    if (a.stats.live !== b.stats.live) return a.stats.live ? -1 : 1;
    const am = a.stats.movement;
    const bm = b.stats.movement;
    if (am !== null && bm !== null && am !== bm) return bm - am;
    if (am !== null && bm === null) return -1;
    if (am === null && bm !== null) return 1;
    if (a.stats.leadChanges !== b.stats.leadChanges) return b.stats.leadChanges - a.stats.leadChanges;
    const ac = a.stats.closest ?? 99;
    const bc = b.stats.closest ?? 99;
    if (ac !== bc) return ac - bc;
    return a.gameId.localeCompare(b.gameId);
  });
  return ranked;
}

export interface DayHighlights {
  /** The game whose reported win probability has moved most, and by how much. */
  mostMovement: { gameId: GameId; movement: number } | null;
  /** The largest single reported change anywhere on the card, and where it landed. */
  biggestSwing: { gameId: GameId; swing: number; sample: TapeSample } | null;
  /** Games that have changed hands most often, from the reported score. */
  mostLeadChanges: { gameId: GameId; leadChanges: number } | null;
}

/**
 * The three things the recording can say about a day without being asked about
 * a particular game. Each is the largest measurement of its kind and nothing
 * more: "most movement" is not "best game", and the interface says which.
 *
 * A measurement that nothing reported is null rather than a zero, so a day with
 * no win probability anywhere says nothing instead of naming an arbitrary game.
 */
export function dayHighlights(tracks: TapeTrack[]): DayHighlights {
  let mostMovement: DayHighlights['mostMovement'] = null;
  let biggestSwing: DayHighlights['biggestSwing'] = null;
  let mostLeadChanges: DayHighlights['mostLeadChanges'] = null;

  for (const track of tracks) {
    const s = tapeStats(track);
    if (s.movement !== null && (!mostMovement || s.movement > mostMovement.movement)) {
      mostMovement = { gameId: track.gameId, movement: s.movement };
    }
    if (s.biggest && (!biggestSwing || Math.abs(s.biggest.swing) > Math.abs(biggestSwing.swing))) {
      biggestSwing = { gameId: track.gameId, swing: s.biggest.swing, sample: s.biggest.sample };
    }
    if (s.leadChanges > 0 && (!mostLeadChanges || s.leadChanges > mostLeadChanges.leadChanges)) {
      mostLeadChanges = { gameId: track.gameId, leadChanges: s.leadChanges };
    }
  }
  return { mostMovement, biggestSwing, mostLeadChanges };
}

export interface Convergence {
  games: GameId[];
  /** The latest clock among them, in seconds, for ordering the notice. */
  soonest: number;
}

/**
 * Games arriving at their endgames together: live, in the last period of
 * regulation or beyond, inside the closing minutes, and within one score.
 *
 * This is the state a football Sunday is actually about and no view names it,
 * because each card can only speak for itself. Every condition is read from
 * reported values, and a game missing any of them is not counted rather than
 * assumed.
 */
export function convergence(games: GameSummary[], lateSeconds = 300, closeMargin = 8): Convergence | null {
  const hits: Array<{ id: GameId; left: number }> = [];
  for (const g of games) {
    const st = g.status;
    if (!isLiveOrPaused(st.kind) || st.kind !== 'in_progress') continue;
    if (g.score.home === null || g.score.away === null) continue;
    if (st.period === null || st.period < st.regulationPeriods) continue;
    if (st.clockSeconds === null) continue;
    const beyond = st.period > st.regulationPeriods;
    if (!beyond && st.clockSeconds > lateSeconds) continue;
    if (Math.abs(g.score.home - g.score.away) > closeMargin) continue;
    hits.push({ id: g.id, left: beyond ? 0 : st.clockSeconds });
  }
  if (hits.length < 2) return null;
  hits.sort((a, b) => a.left - b.left || a.id.localeCompare(b.id));
  return { games: hits.map((h) => h.id), soonest: hits[0].left };
}
