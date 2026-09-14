/**
 * Sportradar NFL v7 and NCAA Football v7 JSON to the Gridiron model.
 *
 * Written from Sportradar's public documentation (developer.sportradar.com,
 * checked 2026-09-14) and hand-written fixtures. Not verified against real
 * responses. Conventions, each from the documented facts:
 *
 * - Game ids are UUIDs. parseGameId allows only [A-Za-z0-9_:.], so a game id is
 *   written "nfl-sr:<uuid with hyphens as underscores>". The "sr:" namespace
 *   cannot collide with ESPN's numeric ids, and the UUID is recovered exactly.
 * - location {alias, id, yardline} counts the yard line from that team's own
 *   goal line: DEN 35 is 35 yards from Denver's goal line. The spot is placed
 *   from the team and yard line, and progress follows from the team in
 *   possession. Provenance is "label", the value for a team-relative yard line.
 * - Lateral position stays null. NFL plays carry hash_mark, but its frame of
 *   reference is undocumented, and no feed has x/y coordinates.
 * - Plays are ordered by sequence ascending. home_points and away_points on a
 *   play are the score after it.
 * - Play kinds use only play_type, details[].result ("touchdown", "good") and
 *   scoring_play. Detail categories are not enumerated in the documentation,
 *   so completions, incompletions, sacks, interceptions and fumbles cannot be
 *   told apart: a non-scoring pass stays "other". A touchdown is attributed to
 *   the side whose points rose on that play; a touchdown by the team without
 *   possession at the snap is a return touchdown.
 * - "complete" is a final score whose stats are still being verified; "closed"
 *   is validated final. Both are final; the status detail says which.
 * - Nothing here fills a gap: a missing value stays null.
 */
import type {
  BallSpot,
  Conversion,
  CoverageCapabilities,
  Division,
  Drive,
  GameDetail,
  GameId,
  GameStatus,
  GameStatusKind,
  GameSummary,
  LeagueId,
  PlayEvent,
  PlayKind,
  PlayState,
  Score,
  ScoreEvent,
  Situation,
  Team,
} from '../../../shared/model.js';
import { ADMIN_KINDS, UNKNOWN_SPOT, gameId as toGameId, isLiveOrPaused, parseGameId, teamKey } from '../../../shared/model.js';
import { progressFromSchematicYard, type Side } from '../../../shared/field.js';
import { clockToSeconds, easternDateKey, fingerprint } from '../../../shared/util.js';
import { findGaps } from '../espn/normalize.js';
import { arr, bool, num, obj, str } from '../espn/raw.js';

export const PROVIDER_ID = 'sportradar';
export const PROVIDER_NAME = 'Sportradar';

export class SportradarShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SportradarShapeError';
  }
}

export interface SportradarDiagnostics {
  invalidGames: number;
  itemsWithoutId: number;
  unknownItems: number;
  unattributedPushEvents: number;
}

export const newSportradarDiagnostics = (): SportradarDiagnostics => ({ invalidGames: 0, itemsWithoutId: 0, unknownItems: 0, unattributedPushEvents: 0 });

// ---------------------------------------------------------------- identity

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE = 'sr:';

export const isSportradarUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const encodeId = (providerId: string) => `${NAMESPACE}${providerId.replace(/-/g, '_')}`;

export const sportradarGameId = (league: LeagueId, uuid: string): GameId => toGameId(league, encodeId(uuid));
export const sportradarTeamKey = (league: LeagueId, providerTeamId: string) => teamKey(league, encodeId(providerTeamId));

/** The league and Sportradar UUID behind a Gridiron game id, or null for any other id. */
export function parseSportradarGameId(id: string): { league: LeagueId; uuid: string } | null {
  const parsed = parseGameId(id);
  if (!parsed || !parsed.providerEventId.startsWith(NAMESPACE)) return null;
  const uuid = parsed.providerEventId.slice(NAMESPACE.length).replace(/_/g, '-');
  return UUID.test(uuid) ? { league: parsed.league, uuid } : null;
}

// ---------------------------------------------------------------- status

const STATUS_KIND: Record<string, GameStatusKind> = {
  scheduled: 'scheduled',
  created: 'scheduled',
  'time-tbd': 'scheduled',
  'flex-schedule': 'scheduled',
  'if necessary': 'scheduled',
  inprogress: 'in_progress',
  halftime: 'halftime',
  delayed: 'delayed',
  suspended: 'suspended',
  complete: 'final',
  closed: 'final',
  postponed: 'postponed',
  cancelled: 'canceled',
  unnecessary: 'canceled',
};

/** Words for statuses whose meaning the kind alone does not carry. */
const STATUS_DETAIL: Record<string, string> = {
  'time-tbd': 'Kickoff time to be determined',
  'flex-schedule': 'Flexible scheduling: kickoff time may change',
  'if necessary': 'Played only if necessary',
  unnecessary: 'Not needed; will not be played',
  complete: 'Final score; stats still being verified',
};

export function normalizeStatus(status: string | null, quarter: number | null, clock: string | null, regulationPeriods = 4): GameStatus {
  const code = status === null ? null : status.trim().toLowerCase();
  const kind: GameStatusKind = code !== null && STATUS_KIND[code] ? STATUS_KIND[code] : 'unknown';
  const clockRelevant = kind === 'in_progress' || kind === 'delayed' || kind === 'suspended';
  const shownClock = clockRelevant ? clock : null;
  return {
    kind,
    period: kind === 'scheduled' || quarter === null || !Number.isInteger(quarter) || quarter < 1 ? null : quarter,
    regulationPeriods,
    clock: shownClock,
    clockSeconds: clockToSeconds(shownClock),
    detail: code === null ? null : (STATUS_DETAIL[code] ?? (kind === 'unknown' ? status : null)),
    providerCode: status,
  };
}

const scoreHidden = (kind: GameStatusKind) => kind === 'scheduled' || kind === 'postponed' || kind === 'canceled';

// ---------------------------------------------------------------- teams & context

export interface GameContext {
  league: LeagueId;
  uuid: string;
  gameId: GameId;
  home: Team;
  away: Team;
}

function normalizeTeam(raw: unknown, league: LeagueId, where: string): Team {
  const t = obj(raw);
  const providerId = str(t?.id);
  if (!t || !providerId) throw new SportradarShapeError(`${where} has no team id`);
  const alias = str(t.alias);
  const name = str(t.name);
  const market = str(t.market);
  const abbreviation = alias ?? name ?? providerId;
  return {
    key: sportradarTeamKey(league, providerId),
    league,
    providerId,
    abbreviation,
    displayName: market && name ? `${market} ${name}` : (name ?? market ?? abbreviation),
    shortName: name ?? abbreviation,
    location: market,
    color: null,
    alternateColor: null,
    logo: null,
    logoDark: null,
    rank: null,
    record: null,
    conferenceId: null,
  };
}

/** Which side a {id, alias} reference names: the id decides, the alias only when no id is given. */
function sideOfRef(raw: unknown, ctx: GameContext): Side | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id);
  if (id !== null) return id === ctx.home.providerId ? 'home' : id === ctx.away.providerId ? 'away' : null;
  const alias = str(r.alias)?.toUpperCase() ?? null;
  if (alias === null || ctx.home.abbreviation.toUpperCase() === ctx.away.abbreviation.toUpperCase()) return null;
  return alias === ctx.home.abbreviation.toUpperCase() ? 'home' : alias === ctx.away.abbreviation.toUpperCase() ? 'away' : null;
}

const validIso = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && Number.isFinite(Date.parse(s)) ? s : null;
};

/** YYYYMMDD of a scheduled time in US Eastern, the day Gridiron files a game under. */
export function easternDayOf(scheduled: string | null): string | null {
  if (scheduled === null) return null;
  const t = Date.parse(scheduled);
  return Number.isFinite(t) ? easternDateKey(new Date(t)) : null;
}

// ---------------------------------------------------------------- spots & situations

/** A ball spot from a location {id, alias, yardline} and the team with the ball. */
export function spotFromLocation(location: unknown, offense: Side | null, ctx: GameContext, phase: BallSpot['phase'], sourceTime: string | null): BallSpot {
  const loc = obj(location);
  const yard = num(loc?.yardline);
  const team = sideOfRef(loc, ctx);
  if (!loc || yard === null || yard < 0 || yard > 50 || (team === null && yard !== 50)) {
    return { ...UNKNOWN_SPOT, offense, phase, sourceTime };
  }
  const schematicYard = yard === 50 ? 50 : team === 'home' ? 100 - yard : yard;
  const abbreviation = team === null ? '' : ctx[team].abbreviation;
  return {
    label: yard === 50 ? '50' : yard === 0 ? `${abbreviation} goal line` : `${abbreviation} ${yard}`,
    offense,
    progress: offense === null ? null : progressFromSchematicYard(schematicYard, offense),
    schematicYard,
    phase,
    provenance: 'label',
    lateral: null,
    sourceTime,
  };
}

const validDown = (d: number | null) => (d !== null && Number.isInteger(d) && d >= 1 && d <= 4 ? d : null);
const validDistance = (d: number | null, down: number | null) => (down !== null && d !== null && d > 0 && d <= 99 ? d : null);

/** Goal to go exactly when the yards to go reach the goal line. Unknown when either value is. */
const goalToGo = (distance: number | null, progress: number | null) => (distance === null || progress === null ? null : progress + distance >= 100);

function playState(raw: unknown, ctx: GameContext, phase: BallSpot['phase'], sourceTime: string | null): { state: PlayState; possession: Side | null } | null {
  const s = obj(raw);
  if (!s) return null;
  const possession = sideOfRef(s.possession, ctx);
  const down = validDown(num(s.down));
  const distance = validDistance(num(s.yfd), down);
  const spot = spotFromLocation(s.location, possession, ctx, phase, sourceTime);
  return { state: { down, distance, goalToGo: down === null ? null : goalToGo(distance, spot.progress), downDistanceText: null, spot }, possession };
}

/** The boxscore situation: the state before the next snap. */
export function normalizeSituation(raw: unknown, ctx: GameContext, timeouts: Score): Situation | null {
  const read = playState(raw, ctx, 'pre-snap', null);
  if (!read) return null;
  const { state, possession } = read;
  return {
    possession,
    down: state.down,
    distance: state.distance,
    goalToGo: state.goalToGo,
    downDistanceText: null,
    spot: state.spot,
    isRedZone: state.spot.progress === null ? null : state.spot.progress >= 80,
    timeouts: { home: timeouts.home, away: timeouts.away },
    lastPlay: null,
  };
}

// ---------------------------------------------------------------- summaries

function coverageFor(league: LeagueId, coverage: string | null, situation: boolean, plays: number, drives: number): CoverageCapabilities {
  // NCAA football reports coverage; the NFL feed's coverage field is not documented, so its level is unknown.
  const level: CoverageCapabilities['level'] = league === 'cfb' && coverage === 'full' ? 'full' : league === 'cfb' && coverage === 'extended_boxscore' ? 'score-only' : 'unknown';
  return { level, score: true, situation, playByPlay: plays > 0, drives: drives > 0, teamStats: false, provider: PROVIDER_NAME };
}

function baseSummary(league: LeagueId, uuid: string, home: Team, away: Team, divisions: Division[]): Omit<GameSummary, 'startTime' | 'score' | 'status' | 'situation' | 'coverage'> {
  return {
    id: sportradarGameId(league, uuid),
    league,
    providerEventId: encodeId(uuid),
    divisions,
    name: `${away.displayName} at ${home.displayName}`,
    shortName: `${away.abbreviation} @ ${home.abbreviation}`,
    home,
    away,
    broadcasts: [],
    venue: null,
    neutralSite: null,
    conferenceGame: null,
    links: { gamePage: null },
    season: { year: null, type: null, week: null },
    notes: [],
  };
}

const defaultDivisions = (league: LeagueId): Division[] => (league === 'nfl' ? ['NFL'] : []);

/**
 * A game root as boxscore, play-by-play and push payloads share it: id, status,
 * scheduled, clock, quarter and summary.home / summary.away. The situation is
 * read only while the game is live or paused.
 */
export function summaryFromGameRoot(json: unknown, league: LeagueId, where: string, divisions: Division[] = defaultDivisions(league)): { summary: GameSummary; ctx: GameContext; root: Record<string, unknown> } {
  const root = obj(json);
  if (!root) throw new SportradarShapeError(`${where} was not a JSON object`);
  const uuid = str(root.id);
  if (!isSportradarUuid(uuid)) throw new SportradarShapeError(`${where} has no game id (expected a UUID in "id")`);
  const teams = obj(root.summary);
  if (!teams) throw new SportradarShapeError(`${where} has no summary with home and away teams`);
  const home = normalizeTeam(teams.home, league, `${where} summary.home`);
  const away = normalizeTeam(teams.away, league, `${where} summary.away`);
  const ctx: GameContext = { league, uuid, gameId: sportradarGameId(league, uuid), home, away };
  const rawStatus = str(root.status);
  const status = normalizeStatus(rawStatus, num(root.quarter), str(root.clock));
  const homeRaw = obj(teams.home);
  const awayRaw = obj(teams.away);
  const timeouts: Score = { home: num(homeRaw?.remaining_timeouts), away: num(awayRaw?.remaining_timeouts) };
  const situation = isLiveOrPaused(status.kind) ? normalizeSituation(root.situation, ctx, timeouts) : null;
  const summary: GameSummary = {
    ...baseSummary(league, uuid, home, away, divisions),
    startTime: rawStatus?.toLowerCase() === 'time-tbd' ? null : validIso(root.scheduled),
    score: scoreHidden(status.kind) ? { home: null, away: null } : { home: num(homeRaw?.points), away: num(awayRaw?.points) },
    status,
    situation,
    coverage: coverageFor(league, str(root.coverage), situation !== null, 0, 0),
  };
  return { summary, ctx, root };
}

export const normalizeBoxscore = (json: unknown, league: LeagueId, divisions?: Division[]): GameSummary =>
  summaryFromGameRoot(json, league, `Sportradar ${league === 'nfl' ? 'NFL' : 'NCAA football'} boxscore`, divisions).summary;

// ---------------------------------------------------------------- schedules

export interface ScheduleEntry {
  uuid: string;
  status: string | null;
  scheduled: string | null;
  /** US Eastern day of the scheduled time. */
  dateKey: string | null;
  raw: Record<string, unknown>;
}

/** Arrays under a "games" key, at any depth up to four levels. */
function gameLists(value: unknown, depth = 0, out: unknown[][] = []): unknown[][] {
  if (depth > 4) return out;
  if (Array.isArray(value)) {
    for (const item of value) gameLists(item, depth + 1, out);
    return out;
  }
  const o = obj(value);
  if (!o) return out;
  for (const [key, child] of Object.entries(o)) {
    if (key === 'games' && Array.isArray(child)) out.push(child);
    else if (typeof child === 'object' && child !== null) gameLists(child, depth + 1, out);
  }
  return out;
}

/**
 * Games from a schedule feed. The weekly schedule's shape is documented
 * (week.games[]); the season schedule's container is not, so every "games"
 * list is read and each game must have the documented game shape.
 */
export function parseSchedule(json: unknown, diagnostics: SportradarDiagnostics = newSportradarDiagnostics()): ScheduleEntry[] {
  const root = obj(json);
  if (!root) throw new SportradarShapeError('Sportradar schedule was not a JSON object');
  const lists = gameLists(root);
  if (!lists.length) throw new SportradarShapeError('Sportradar schedule had no games list');
  const seen = new Map<string, ScheduleEntry>();
  for (const item of lists.flat()) {
    const g = obj(item);
    const uuid = str(g?.id);
    if (!g || !isSportradarUuid(uuid) || !str(obj(g.home)?.id) || !str(obj(g.away)?.id)) {
      diagnostics.invalidGames++;
      continue;
    }
    const scheduled = validIso(g.scheduled);
    seen.set(uuid, { uuid, status: str(g.status), scheduled, dateKey: easternDayOf(scheduled), raw: g });
  }
  return [...seen.values()];
}

export function summaryFromSchedule(entry: ScheduleEntry, league: LeagueId, divisions: Division[] = defaultDivisions(league)): GameSummary {
  const g = entry.raw;
  const home = normalizeTeam(g.home, league, 'Sportradar schedule game home');
  const away = normalizeTeam(g.away, league, 'Sportradar schedule game away');
  const status = normalizeStatus(entry.status, num(g.quarter), str(g.clock));
  const scoring = obj(g.scoring);
  return {
    ...baseSummary(league, entry.uuid, home, away, divisions),
    startTime: entry.status?.toLowerCase() === 'time-tbd' ? null : entry.scheduled,
    score: scoreHidden(status.kind) ? { home: null, away: null } : { home: num(scoring?.home_points), away: num(scoring?.away_points) },
    status,
    situation: null,
    coverage: coverageFor(league, str(g.coverage), false, 0, 0),
  };
}

// ---------------------------------------------------------------- plays

const EVENT_KIND: Record<string, PlayKind> = {
  timeout: 'timeout',
  tv_timeout: 'timeout',
  two_minute_warning: 'two_minute_warning',
  period_end: 'end_period',
  game_over: 'end_game',
};

const EVENT_LABEL: Record<string, string> = {
  setup: 'Game setup',
  timeout: 'Timeout',
  tv_timeout: 'TV timeout',
  two_minute_warning: 'Two-minute warning',
  comment: 'Comment',
  period_end: 'End of period',
  game_over: 'End of game',
};

const detailResults = (raw: Record<string, unknown>) =>
  arr(raw.details)
    .map((d) => str(obj(d)?.result)?.toLowerCase() ?? null)
    .filter((r): r is string => r !== null);

/**
 * PlayKind from the documented play_type values, details[].result and
 * scoring_play. `scorer` is the side whose points rose on the play; `offense`
 * is the side in possession at the snap.
 */
export function classifyPlay(raw: Record<string, unknown>, offense: Side | null, scorer: Side | null): PlayKind {
  const type = str(raw.play_type)?.toLowerCase() ?? null;
  const results = detailResults(raw);
  const scoring = bool(raw.scoring_play);
  const touchdown = scoring === true && results.includes('touchdown') && scorer !== null && offense !== null;
  switch (type) {
    case 'pass':
      if (touchdown) return scorer === offense ? 'touchdown_pass' : 'touchdown_return';
      return 'other';
    case 'rush':
      if (touchdown) return scorer === offense ? 'touchdown_rush' : 'touchdown_return';
      return 'rush';
    case 'punt':
      if (touchdown && scorer !== offense) return 'touchdown_return';
      return scoring === true ? 'other' : 'punt';
    case 'field_goal':
      if (touchdown && scorer !== offense) return 'touchdown_return';
      if (results.includes('good') && scoring !== false) return 'field_goal_good';
      return 'other';
    case 'extra_point':
      return 'extra_point';
    case 'conversion':
      return 'two_point';
    case 'kickoff':
      return scoring === true ? 'other' : 'kickoff';
    case 'penalty':
      return 'penalty';
    default:
      return 'other'; // free_kick, faircatch_kick and any undocumented type
  }
}

function conversionFor(kind: PlayKind, raw: Record<string, unknown>): Conversion | null {
  if (kind !== 'extra_point' && kind !== 'two_point') return null;
  const result: Conversion['result'] = detailResults(raw).includes('good') ? 'good' : 'unknown';
  return { kind: kind === 'extra_point' ? 'kick' : 'two-point', result };
}

interface RawItem {
  raw: Record<string, unknown>;
  isEvent: boolean;
  period: number | null;
  driveId: string | null;
  sequence: number | null;
  index: number;
}

/** Ascending sequence. An item without a sequence stays just after the item before it in the document. */
export function orderBySequence<T extends { sequence: number | null; index: number }>(items: T[]): T[] {
  let carried = Number.NEGATIVE_INFINITY;
  const keyed = items.map((item) => {
    if (item.sequence !== null) carried = item.sequence;
    return { item, key: item.sequence ?? carried };
  });
  return keyed.sort((a, b) => a.key - b.key || a.item.index - b.item.index).map((k) => k.item);
}

function scoreKindOf(kind: PlayKind, raw: Record<string, unknown>): ScoreEvent['kind'] {
  if (detailResults(raw).includes('touchdown') && (kind === 'touchdown_pass' || kind === 'touchdown_rush' || kind === 'touchdown_return' || kind === 'other')) return 'touchdown';
  if (kind === 'field_goal_good') return 'field_goal';
  if (kind === 'extra_point' || kind === 'two_point') return 'conversion';
  return 'unknown';
}

// ---------------------------------------------------------------- play-by-play

export function normalizePlayByPlay(
  json: unknown,
  league: LeagueId,
  divisions: Division[] = defaultDivisions(league),
  diagnostics: SportradarDiagnostics = newSportradarDiagnostics(),
): GameDetail {
  const where = `Sportradar ${league === 'nfl' ? 'NFL' : 'NCAA football'} play-by-play`;
  const { summary, ctx, root } = summaryFromGameRoot(json, league, where, divisions);
  if (!Array.isArray(root.periods)) throw new SportradarShapeError(`${where} has no periods list`);

  const items: RawItem[] = [];
  const drives: Array<{ drive: Drive; sequence: number | null; index: number }> = [];
  let index = 0;
  for (const p of root.periods) {
    const period = obj(p);
    if (!period) throw new SportradarShapeError(`${where} has a period that is not an object`);
    if (period.pbp !== undefined && !Array.isArray(period.pbp)) throw new SportradarShapeError(`${where} has a period whose pbp is not a list`);
    const number = num(period.number);
    for (const entry of arr(period.pbp)) {
      const o = obj(entry);
      const type = str(o?.type);
      if (!o || (type !== 'drive' && type !== 'play' && type !== 'event')) {
        diagnostics.unknownItems++;
        continue;
      }
      if (type !== 'drive') {
        items.push({ raw: o, isEvent: type === 'event', period: number, driveId: null, sequence: num(o.sequence), index: index++ });
        continue;
      }
      const providerId = str(o.id);
      if (!providerId) {
        diagnostics.itemsWithoutId++;
        continue;
      }
      const driveId = `${ctx.gameId}:drive:${providerId}`;
      if (!drives.some((d) => d.drive.id === driveId)) {
        drives.push({
          sequence: num(o.sequence),
          index: index++,
          drive: {
            id: driveId,
            providerId,
            gameId: ctx.gameId,
            offense: sideOfRef(o.offensive_team, ctx),
            description: null,
            start: null,
            end: null,
            playIds: [],
            offensivePlays: num(o.play_count),
            yards: num(o.net_yards),
            timeElapsed: str(o.duration),
            result: str(o.end_reason),
            isScore: null,
            isCurrent: false,
          },
        });
      }
      for (const ev of arr(o.events)) {
        const e = obj(ev);
        const evType = str(e?.type);
        if (!e || (evType !== 'play' && evType !== 'event')) {
          diagnostics.unknownItems++;
          continue;
        }
        items.push({ raw: e, isEvent: evType === 'event', period: number, driveId, sequence: num(e.sequence), index: index++ });
      }
    }
  }

  const plays: PlayEvent[] = [];
  const scoring: ScoreEvent[] = [];
  const seen = new Set<string>();
  let before: Score = { home: 0, away: 0 };
  for (const item of orderBySequence(items)) {
    const p = item.raw;
    const providerId = str(p.id);
    if (!providerId) {
      diagnostics.itemsWithoutId++;
      continue;
    }
    const id = `${ctx.gameId}:${providerId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const wallclock = validIso(p.wall_clock);
    const eventType = item.isEvent ? (str(p.event_type)?.toLowerCase() ?? null) : null;
    const start = item.isEvent ? null : playState(p.start_situation, ctx, 'pre-snap', wallclock);
    const end = item.isEvent ? null : playState(p.end_situation, ctx, 'post-play', wallclock);
    const offense = start?.possession ?? null;
    const reported: Score = { home: num(p.home_points), away: num(p.away_points) };
    const scoringFlag = item.isEvent ? null : bool(p.scoring_play);
    let scorer: Side | null = null;
    if (scoringFlag === true && reported.home !== null && reported.away !== null && before.home !== null && before.away !== null) {
      const dh = reported.home - before.home;
      const da = reported.away - before.away;
      if (dh > 0 && da <= 0) scorer = 'home';
      else if (da > 0 && dh <= 0) scorer = 'away';
    }
    const kind: PlayKind = item.isEvent ? (EVENT_KIND[eventType ?? ''] ?? 'other') : classifyPlay(p, offense, scorer);
    // A stoppage never changes the score, so one without points keeps the score before it.
    const scoreAfter: Score = item.isEvent && ADMIN_KINDS.has(kind) && reported.home === null && reported.away === null ? { ...before } : reported;
    const playType = item.isEvent ? eventType : (str(p.play_type)?.toLowerCase() ?? null);
    const clock = str(p.clock);
    const description = str(p.description) ?? (item.isEvent ? (EVENT_LABEL[eventType ?? ''] ?? eventType ?? 'Event') : (playType ?? 'Play'));
    const play: PlayEvent = {
      id,
      providerId,
      gameId: ctx.gameId,
      driveId: item.driveId,
      sequence: item.sequence,
      order: plays.length,
      period: item.period,
      clock,
      description,
      providerType: { id: null, text: playType },
      kind,
      offense,
      start: start?.state ?? null,
      end: end?.state ?? null,
      yards: null,
      scoring: scoringFlag,
      scoringTeam: scorer,
      turnover: null,
      penalty: playType === 'penalty' ? true : null,
      possessionChanged: start?.possession && end?.possession ? start.possession !== end.possession : null,
      conversion: conversionFor(kind, p),
      review: null,
      scoreAfter,
      modified: null,
      wallclock,
      revision: fingerprint(
        JSON.stringify([
          playType, description, clock, item.sequence, item.period, item.driveId, p.home_points, p.away_points, p.scoring_play, p.official,
          p.start_situation ?? null, p.end_situation ?? null, p.details ?? null,
        ]),
      ),
    };
    plays.push(play);
    if (scoringFlag === true) {
      scoring.push({
        id: `${ctx.gameId}:score:${providerId}`,
        gameId: ctx.gameId,
        playId: id,
        period: item.period,
        clock,
        team: scorer,
        kind: scoreKindOf(kind, p),
        description,
        scoreAfter,
      });
    }
    if (scoreAfter.home !== null && scoreAfter.away !== null) before = scoreAfter;
  }

  const orderedDrives = orderBySequence(drives.map((d) => ({ ...d }))).map((d) => d.drive);
  for (const play of plays) if (play.driveId) orderedDrives.find((d) => d.id === play.driveId)?.playIds.push(play.id);
  const last = orderedDrives[orderedDrives.length - 1];
  if (last && isLiveOrPaused(summary.status.kind) && last.result === null) last.isCurrent = true;

  const gaps = findGaps(plays);
  if (summary.coverage.level === 'full' && plays.length === 0 && summary.status.kind !== 'scheduled') {
    gaps.push({ afterPlayId: null, beforePlayId: null, reason: 'The provider lists full play-by-play for this game but returned no plays yet.' });
  }

  return {
    gameId: ctx.gameId,
    summary: { ...summary, coverage: coverageFor(league, str(root.coverage), summary.situation !== null, plays.length, orderedDrives.length) },
    drives: orderedDrives,
    plays,
    scoring,
    stats: [],
    leaders: [],
    attendance: null,
    currentDriveId: last?.isCurrent ? last.id : null,
    gaps,
  };
}

// ---------------------------------------------------------------- push

/**
 * A summary from a push message: payload.game has status, quarter, clock and
 * summary. What the message lacks (start time, divisions) is kept from the last
 * summary read over REST for the same game and teams. The situation is the end
 * of the pushed play when there is one, marked post-play; otherwise unknown.
 */
export function summaryFromPush(game: unknown, event: unknown, league: LeagueId, known: GameSummary | null): GameSummary {
  const { summary, ctx } = summaryFromGameRoot(game, league, 'Sportradar push payload.game', known?.divisions);
  const sameTeams = known !== null && known.home.providerId === summary.home.providerId && known.away.providerId === summary.away.providerId;
  const e = obj(event);
  const end = e && isLiveOrPaused(summary.status.kind) ? playState(e.end_situation, ctx, 'post-play', validIso(e.wall_clock)) : null;
  const situation: Situation | null = end
    ? {
        possession: end.possession,
        down: end.state.down,
        distance: end.state.distance,
        goalToGo: end.state.goalToGo,
        downDistanceText: null,
        spot: end.state.spot,
        isRedZone: end.state.spot.progress === null ? null : end.state.spot.progress >= 80,
        timeouts: { home: null, away: null },
        lastPlay: null,
      }
    : null;
  return {
    ...summary,
    home: sameTeams ? { ...known.home, ...pickReported(summary.home) } : summary.home,
    away: sameTeams ? { ...known.away, ...pickReported(summary.away) } : summary.away,
    startTime: summary.startTime ?? (sameTeams ? known.startTime : null),
    situation,
    coverage: sameTeams && summary.coverage.level === 'unknown' ? known.coverage : summary.coverage,
  };
}

/** Team fields a push message actually reported, so known names are not replaced by fallbacks. */
function pickReported(team: Team): Partial<Team> {
  return team.abbreviation === team.providerId ? {} : { abbreviation: team.abbreviation, displayName: team.displayName, shortName: team.shortName, location: team.location ?? undefined };
}
