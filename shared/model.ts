/**
 * Gridiron's normalized domain model.
 *
 * Nothing in here knows about a provider. Every value a provider may omit is
 * typed as nullable, and null always means "not reported", never "zero" or
 * "false". Presentation code reads only these types.
 */
import type { Side, SpotProvenance } from './field.js';

export type { Side } from './field.js';

// ---------------------------------------------------------------- identity

export type LeagueId = 'nfl' | 'cfb';

export interface League {
  id: LeagueId;
  name: string;
  shortName: string;
}

export const LEAGUES: Record<LeagueId, League> = {
  nfl: { id: 'nfl', name: 'National Football League', shortName: 'NFL' },
  cfb: { id: 'cfb', name: 'College Football', shortName: 'College' },
};

/** Coverage tiers. College divisions come from the provider's own group metadata. */
export type Division = 'NFL' | 'FBS' | 'FCS' | 'D2' | 'D3';

export const DIVISION_LABEL: Record<Division, string> = {
  NFL: 'NFL',
  FBS: 'FBS',
  FCS: 'FCS',
  D2: 'Division II',
  D3: 'Division III',
};

/** League-namespaced ids so an NFL event and a college event can never collide. */
export type GameId = string; // `${LeagueId}-${providerEventId}`
export type TeamKey = string; // `${LeagueId}-${providerTeamId}`

export const gameId = (league: LeagueId, providerEventId: string): GameId => `${league}-${providerEventId}`;
export const teamKey = (league: LeagueId, providerTeamId: string): TeamKey => `${league}-${providerTeamId}`;

export function parseGameId(id: string): { league: LeagueId; providerEventId: string } | null {
  const m = /^(nfl|cfb)-([A-Za-z0-9_:.]{1,64})$/.exec(id);
  return m ? { league: m[1] as LeagueId, providerEventId: m[2] } : null;
}

// ---------------------------------------------------------------- teams

export interface Team {
  key: TeamKey;
  league: LeagueId;
  providerId: string;
  abbreviation: string;
  displayName: string; // "Cincinnati Bengals"
  shortName: string; // "Bengals" or "Texas"
  location: string | null;
  color: string | null; // "#fb4f14"
  alternateColor: string | null;
  logo: string | null;
  logoDark: string | null;
  rank: number | null; // college poll rank, 1-25; null when unranked or not reported
  record: string | null; // "2-0"
  conferenceId: string | null;
}

// ---------------------------------------------------------------- status

export type GameStatusKind =
  | 'scheduled'
  | 'in_progress'
  | 'halftime'
  | 'end_of_period'
  | 'delayed'
  | 'suspended'
  | 'final'
  | 'postponed'
  | 'canceled'
  | 'unknown';

export interface GameStatus {
  kind: GameStatusKind;
  /** Provider period number. 1-4 are quarters; anything above the regulation count is overtime. */
  period: number | null;
  regulationPeriods: number;
  /** Provider's display clock, exactly as reported. Never counted down locally. */
  clock: string | null;
  clockSeconds: number | null;
  /** Provider's short description, e.g. "2nd - 12:34", "Halftime", "Final/OT". */
  detail: string | null;
  providerCode: string | null;
}

/** Is the game in a state where plays can still happen? Distinct from "has started". */
export const isActiveStatus = (k: GameStatusKind) =>
  k === 'in_progress' || k === 'halftime' || k === 'end_of_period' || k === 'delayed';
export const isLiveOrPaused = (k: GameStatusKind) => isActiveStatus(k) || k === 'suspended';
export const isOver = (k: GameStatusKind) => k === 'final' || k === 'canceled';

// ---------------------------------------------------------------- situation

export interface BallSpot {
  /** Provider's team-relative label, e.g. "BUF 35". */
  label: string | null;
  /** Team with the ball when this spot applies. */
  offense: Side | null;
  /** Yards from the offense's own goal line, 0-100; null when not reported. */
  progress: number | null;
  /** Position along the drawn field, 0 at the away goal line and 100 at the home goal line. */
  schematicYard: number | null;
  /** A spot before the next snap, or the result of a play. */
  phase: 'pre-snap' | 'post-play' | 'unknown';
  provenance: SpotProvenance;
  /**
   * Validated lateral position across the field, 0 (away-side sideline in the schematic) to 1.
   * No current provider reports it, so this is null and the marker sits on the centre axis.
   */
  lateral: number | null;
  /** Provider timestamp for the spot when one exists. */
  sourceTime: string | null;
}

export const UNKNOWN_SPOT: BallSpot = {
  label: null,
  offense: null,
  progress: null,
  schematicYard: null,
  phase: 'unknown',
  provenance: 'unknown',
  lateral: null,
  sourceTime: null,
};

export interface Situation {
  possession: Side | null;
  down: number | null;
  distance: number | null;
  goalToGo: boolean | null;
  /** Provider's text, e.g. "3rd & 7 at BUF 35". */
  downDistanceText: string | null;
  spot: BallSpot;
  isRedZone: boolean | null;
  timeouts: { home: number | null; away: number | null };
  lastPlay: PlayBrief | null;
}

export interface PlayBrief {
  id: string | null;
  kind: PlayKind;
  description: string;
  yards: number | null;
  team: Side | null;
}

export interface Score {
  home: number | null;
  away: number | null;
}

// ---------------------------------------------------------------- summaries

export interface Broadcast {
  name: string;
  medium: 'tv' | 'streaming' | 'radio' | 'unknown';
  national: boolean | null;
}

export interface CoverageCapabilities {
  level: 'full' | 'score-only' | 'unknown';
  score: boolean;
  situation: boolean;
  playByPlay: boolean;
  drives: boolean;
  teamStats: boolean;
  provider: string;
}

// ---------------------------------------------------------------- odds and win probability

/** A value as the sportsbook first posted it and as it stands now. After kickoff "latest" is the last line reported. */
export interface OpenLatest<T> {
  open: T | null;
  latest: T | null;
}

/** A spread or total line with its American odds. */
export interface LinePrice {
  /** Points: a team's spread (negative when favored) or a game total. */
  line: number;
  odds: number | null;
}

/** One sportsbook's lines for a game, exactly as the provider reports them. */
export interface BettingLines {
  /** The sportsbook, as named by the provider, e.g. "DraftKings". */
  provider: string;
  /** The provider's summary, e.g. "KC -2.5". */
  details: string | null;
  favorite: Side | null;
  /** American odds to win outright. */
  moneyline: { home: OpenLatest<number>; away: OpenLatest<number> } | null;
  spread: { home: OpenLatest<LinePrice>; away: OpenLatest<LinePrice> } | null;
  total: { over: OpenLatest<LinePrice>; under: OpenLatest<LinePrice> } | null;
}

/** A team's chance of winning from the provider's model, after a play. Never computed by Gridiron. */
export interface WinProbability {
  /** Home team's chance of winning, 0 to 1. */
  home: number;
  /** Chance of a tie, 0 to 1. */
  tie: number;
  /** Namespaced id of the play the value follows, when reported. */
  playId: string | null;
  /** Whose model it is, e.g. "ESPN". */
  source: string;
}

export interface WinProbabilityPoint {
  playId: string;
  home: number;
  tie: number;
}

/** The provider's pre-game prediction: each team's chance of winning, 0 to 1. */
export interface MatchupPredictor {
  home: number;
  away: number;
  source: string;
}

/** One exchange contract: its price in dollars is the market's implied chance, 0 to 1. */
export interface MarketQuote {
  /** The price shown: the bid and ask midpoint while they are close, otherwise the last trade. */
  price: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
}

/** Prediction market prices for a game, read by the Gridiron server from a public exchange. */
export interface MarketPrices {
  /** The exchange, e.g. "Kalshi". */
  source: string;
  /** Each team's contract to win the game. */
  moneyline: { home: MarketQuote | null; away: MarketQuote | null } | null;
  /** The contract that `team` wins by more than `line` points, nearest the sportsbook spread. */
  spread: { team: Side; line: number; quote: MarketQuote } | null;
  /** The contract that more than `line` points are scored, nearest the sportsbook total. */
  total: { line: number; over: MarketQuote } | null;
  /** When any of these prices last changed (ISO time). */
  changedAt: string;
  /** The exchange has not answered recently, so the prices may be out of date. */
  stale: boolean;
}

/** An exchange price at one moment. */
export interface MarketPricePoint {
  /** ISO time the price was recorded: the end of its minute or hour. */
  at: string;
  /** The middle of a close best bid and ask, otherwise the last trade, in dollars (0 to 1). */
  price: number;
}

/** One team's contract to win across time, as the exchange recorded it. */
export interface MarketHistory {
  /** The exchange, e.g. "Kalshi". */
  source: string;
  /** Whose contract these prices are for. */
  team: Side;
  /** Oldest first: hourly until an hour before kickoff, then minute by minute. */
  points: MarketPricePoint[];
  /** Captured earlier for the replay lab, rather than read from the exchange now. */
  captured: boolean;
}

export interface GameSummary {
  id: GameId;
  league: LeagueId;
  providerEventId: string;
  divisions: Division[];
  startTime: string | null;
  name: string;
  shortName: string;
  home: Team;
  away: Team;
  score: Score;
  status: GameStatus;
  situation: Situation | null;
  broadcasts: Broadcast[];
  venue: { name: string | null; city: string | null; state: string | null } | null;
  neutralSite: boolean | null;
  conferenceGame: boolean | null;
  links: { gamePage: string | null };
  season: { year: number | null; type: number | null; week: number | null };
  notes: string[];
  coverage: CoverageCapabilities;
  /** Sportsbook lines, when the provider reports them. */
  lines?: BettingLines | null;
  /** The latest win probability from the provider's model, when reported. */
  winProbability?: WinProbability | null;
  /** The provider's pre-game matchup prediction, when reported. */
  predictor?: MatchupPredictor | null;
  /** Prediction market prices, when the server reads an exchange and finds this game. */
  market?: MarketPrices | null;
  /** Server receipt time of the provider response this summary came from. */
  receivedAt?: number;
  /** Which provider document produced it. The newer of the two wins. */
  source?: 'scoreboard' | 'summary';
}

// ---------------------------------------------------------------- plays & drives

export type PlayKind =
  | 'rush'
  | 'pass_complete'
  | 'pass_incomplete'
  | 'sack'
  | 'interception'
  | 'fumble'
  | 'fumble_lost'
  | 'fumble_recovered_own'
  | 'punt'
  | 'punt_return'
  | 'punt_blocked'
  | 'kickoff'
  | 'kickoff_return'
  | 'field_goal_good'
  | 'field_goal_missed'
  | 'field_goal_blocked'
  | 'touchdown_rush'
  | 'touchdown_pass'
  | 'touchdown_return'
  | 'extra_point'
  | 'two_point'
  | 'safety'
  | 'penalty'
  | 'timeout'
  | 'two_minute_warning'
  | 'end_period'
  | 'end_half'
  | 'end_regulation'
  | 'end_game'
  | 'coin_toss'
  | 'other';

export const TOUCHDOWN_KINDS: ReadonlySet<PlayKind> = new Set(['touchdown_rush', 'touchdown_pass', 'touchdown_return']);
export const ADMIN_KINDS: ReadonlySet<PlayKind> = new Set([
  'timeout', 'two_minute_warning', 'end_period', 'end_half', 'end_regulation', 'end_game', 'coin_toss',
]);

export interface PlayState {
  down: number | null;
  distance: number | null;
  goalToGo: boolean | null;
  downDistanceText: string | null;
  spot: BallSpot;
}

export interface Conversion {
  kind: 'kick' | 'two-point';
  result: 'good' | 'failed' | 'blocked' | 'unknown';
}

export interface PlayEvent {
  /** Namespaced stable id: `${gameId}:${providerPlayId}`. */
  id: string;
  providerId: string;
  gameId: GameId;
  driveId: string | null;
  /** Provider sequence number when reported. It is not always monotonic. */
  sequence: number | null;
  /** Gridiron's deterministic order within the game, 0-based. */
  order: number;
  period: number | null;
  clock: string | null;
  description: string;
  providerType: { id: string | null; text: string | null };
  kind: PlayKind;
  offense: Side | null;
  start: PlayState | null;
  end: PlayState | null;
  /** Provider's yardage for the play, when reported. */
  yards: number | null;
  scoring: boolean | null;
  scoringTeam: Side | null;
  turnover: boolean | null;
  penalty: boolean | null;
  possessionChanged: boolean | null;
  conversion: Conversion | null;
  review: { outcome: 'upheld' | 'reversed' | 'stands' | 'unknown' } | null;
  scoreAfter: Score;
  /** Provider revision timestamp, when reported. */
  modified: string | null;
  /** Provider wall-clock time of the play, when reported. */
  wallclock: string | null;
  /** Content fingerprint; changes when a revised play arrives with the same id. */
  revision: string;
}

export interface DriveEdge {
  period: number | null;
  clock: string | null;
  label: string | null;
  spot: BallSpot;
}

export interface Drive {
  id: string;
  providerId: string;
  gameId: GameId;
  offense: Side | null;
  description: string | null;
  start: DriveEdge | null;
  end: DriveEdge | null;
  playIds: string[];
  offensivePlays: number | null;
  yards: number | null;
  timeElapsed: string | null;
  result: string | null;
  isScore: boolean | null;
  isCurrent: boolean;
}

export interface ScoreEvent {
  id: string;
  gameId: GameId;
  playId: string | null;
  period: number | null;
  clock: string | null;
  team: Side | null;
  kind: 'touchdown' | 'field_goal' | 'safety' | 'conversion' | 'unknown';
  description: string;
  scoreAfter: Score;
}

export interface TeamStat {
  key: string;
  label: string;
  home: string | null;
  away: string | null;
}

/** A stretch of history the provider did not supply. Never filled in. */
export interface HistoryGap {
  afterPlayId: string | null;
  beforePlayId: string | null;
  reason: string;
}

export interface LeaderAthlete {
  name: string;
  shortName: string | null;
  position: string | null;
  jersey: string | null;
  /** Provider headshot URL, restricted to the provider's image host. */
  headshot: string | null;
}

export interface GameLeader {
  category: 'passing' | 'rushing' | 'receiving';
  /** Provider's category name, e.g. "Passing Yards". */
  label: string;
  athlete: LeaderAthlete;
  /** The provider's stat line exactly as reported, e.g. "23/37, 361 YDS, 3 TD, 1 INT". */
  line: string;
}

export interface TeamLeaders {
  side: Side;
  leaders: GameLeader[];
}

export interface GameDetail {
  gameId: GameId;
  summary: GameSummary;
  drives: Drive[];
  plays: PlayEvent[];
  scoring: ScoreEvent[];
  stats: TeamStat[];
  /** Game leaders as the provider reports them; empty when not reported. */
  leaders: TeamLeaders[];
  attendance: number | null;
  currentDriveId: string | null;
  gaps: HistoryGap[];
  /** The home team's win probability after each play, in play order, from the provider's model. Absent or empty when not reported. */
  winProbability?: WinProbabilityPoint[];
  /** The home team's prediction market price across time, when the server reads an exchange that lists this game. */
  marketHistory?: MarketHistory | null;
}

// ---------------------------------------------------------------- freshness & coverage

export type FeedHealth = 'connected' | 'reconnecting' | 'stale' | 'unavailable' | 'idle';

export interface Freshness {
  /** Last time Gridiron asked the provider. */
  lastAttemptAt: string | null;
  /** Last response that parsed and validated. */
  lastSuccessAt: string | null;
  /** Last time the normalized content actually changed. Unchanged data proves only that the feed answered. */
  lastChangeAt: string | null;
  health: FeedHealth;
  error: string | null;
  consecutiveFailures: number;
}

export const EMPTY_FRESHNESS: Freshness = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastChangeAt: null,
  health: 'idle',
  error: null,
  consecutiveFailures: 0,
};

export interface DivisionCoverage {
  division: Division;
  label: string;
  providerGroupId: string | null;
  games: number;
  health: FeedHealth;
}

export interface ConferenceInfo {
  id: string;
  name: string;
  shortName: string;
}

export interface CoverageReport {
  provider: string;
  date: string; // YYYYMMDD in the provider's day (US Eastern)
  divisions: DivisionCoverage[];
  /** Names of the conferences in the day's college games, read from the provider's own group documents. */
  conferences: ConferenceInfo[];
  /** How the division list was discovered, stated plainly for the help panel. */
  discovery: string;
  limitations: string[];
}

export interface SlateSnapshot {
  /** Monotonic server sequence, used for resynchronising after a reconnect. */
  seq: number;
  mode: 'live' | 'replay';
  replayLabel: string | null;
  date: string;
  generatedAt: string;
  games: GameSummary[];
  freshness: Record<LeagueId, Freshness>;
  coverage: CoverageReport;
}

export interface DetailSnapshot {
  seq: number;
  generatedAt: string;
  detail: GameDetail | null;
  freshness: Freshness;
}

// ---------------------------------------------------------------- alerts

export type AlertKind =
  | 'touchdown'
  | 'field_goal'
  | 'safety'
  | 'turnover'
  | 'red_zone'
  | 'fourth_down_attempt'
  | 'fourth_down'
  | 'big_play'
  | 'lead_change'
  | 'tied'
  | 'close_late'
  | 'overtime'
  | 'final'
  | 'kickoff'
  | 'review'
  | 'score_change';

export interface Alert {
  /** Stable across polls: the same real-world moment always produces the same id. */
  id: string;
  revision: number;
  kind: AlertKind;
  gameId: GameId;
  title: string;
  detail: string;
  team: Side | null;
  period: number | null;
  clock: string | null;
  /** When Gridiron received the information (presentation timeline). */
  receivedAt: number;
  /** Provider time for the moment, when reported. */
  sourceTime: string | null;
  /** Arrived after a gap in updates, so it may not have just happened. */
  late: boolean;
  status: 'active' | 'corrected' | 'withdrawn';
  playId: string | null;
  priority: 1 | 2 | 3;
}

// ---------------------------------------------------------------- boards

export type LayoutMode = 'slate' | 'focus' | 'wall';
export type Density = 'comfortable' | 'compact';

export interface Watchboard {
  id: string;
  name: string;
  /** Team-based boards resolve games for the selected day; game-based boards pin specific events. */
  teams: TeamKey[];
  games: GameId[];
  leagues: LeagueId[] | 'all';
  focus: GameId[];
  createdAt: number;
  updatedAt: number;
}
