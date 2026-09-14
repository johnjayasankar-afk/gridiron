/**
 * Team pages: one team's profile and its schedule for a season.
 *
 * Provider-neutral and safe to import in the browser. As in the rest of the
 * model, null means "not reported", never zero or false. Two values are
 * derived rather than read, and only these two: bye weeks (gaps in the regular
 * season week numbers) and a game's result (the provider's winner flags, or the
 * final score when neither team is flagged).
 */
import type { GameId, GameSummary, LeagueId, TeamKey } from './model.js';

/** Provider season types: 1 preseason, 2 regular season, 3 postseason. */
export type SeasonType = 1 | 2 | 3;

export interface TeamRecord {
  /** Provider summaries such as "1-0". College documents report only a total. */
  total: string | null;
  home: string | null;
  road: string | null;
}

export interface TeamSeasonStats {
  wins: number | null;
  losses: number | null;
  ties: number | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  pointDifferential: number | null;
  /** Signed: 2 is two straight wins, -1 is one loss. */
  streak: number | null;
}

export interface TeamProfile {
  key: TeamKey;
  league: LeagueId;
  providerId: string;
  abbreviation: string;
  displayName: string; // "Buffalo Bills"
  shortName: string; // "Bills" or "Alabama"
  location: string | null;
  name: string | null; // "Bills" or "Crimson Tide"
  color: string | null; // "#00338d"
  alternateColor: string | null;
  logo: string | null;
  logoDark: string | null;
  /** College poll rank, 1-25; null when unranked or not reported. */
  rank: number | null;
  standingSummary: string | null; // "1st in AFC East"
  record: TeamRecord;
  stats: TeamSeasonStats;
}

export interface TeamSeason {
  year: number;
  /** Season type of the requested season, normally 2 (regular season). */
  type: number;
  /** Provider name for that season type, e.g. "Regular Season". */
  label: string;
}

export interface ScheduleOpponent {
  key: TeamKey;
  providerId: string;
  abbreviation: string;
  displayName: string;
  shortName: string;
  logo: string | null;
  /** Poll rank as listed for this game, 1-25; null when unranked or not reported. */
  rank: number | null;
}

export type ScheduleState = 'pre' | 'in' | 'post' | 'unknown';

export interface ScheduleStatus {
  state: ScheduleState;
  completed: boolean;
  /** Provider text, exactly as reported. */
  detail: string | null;
  /** Provider short text, e.g. "Final/OT", "TBD" or "9/17 - 8:15 PM EDT". */
  shortDetail: string | null;
}

export interface ScheduleGame {
  /** The app's game id, the same as the scoreboard's, so /game/<gameId> links work. */
  gameId: GameId;
  providerId: string;
  /** Kickoff as an ISO time. When timeValid is false the kickoff time is not set and only the day is meaningful. */
  date: string;
  timeValid: boolean;
  week: { number: number | null; text: string | null };
  seasonType: SeasonType | null;
  /** As the provider lists it; a neutral site game still lists one team as home. */
  homeAway: 'home' | 'away';
  neutralSite: boolean;
  opponent: ScheduleOpponent;
  venue: string | null;
  status: ScheduleStatus;
  /** Reported score from this team's side, once the game is under way; otherwise null. */
  score: { team: number; opponent: number } | null;
  /** Completed games only. */
  result: 'W' | 'L' | 'T' | null;
  broadcasts: string[];
  notes: string[];
}

export interface TeamPage {
  team: TeamProfile;
  season: TeamSeason;
  /** Every game in the requested schedules, ordered by date, regular season first when dates tie. */
  schedule: ScheduleGame[];
  /** Regular season weeks without a game, between the team's first and last regular season weeks. */
  byeWeeks: number[];
  /** When the provider documents were received. The profile and results are as of this time. */
  fetchedAt: string;
}

/** A week number past a year's worth of weeks is not a real week, and must not drive the gap search. */
const MAX_WEEK = 53;

/**
 * Regular season weeks without a game for this team: the gaps between its
 * first and last regular season weeks. Preseason and postseason weeks have
 * their own numbering and never count. Weeks after the last listed game are
 * not reported as byes, since a schedule can still be incomplete.
 */
export function byeWeeksFrom(schedule: readonly ScheduleGame[]): number[] {
  const weeks = new Set<number>();
  for (const game of schedule) {
    const week = game.week.number;
    if (game.seasonType === 2 && week !== null && Number.isInteger(week) && week >= 0 && week <= MAX_WEEK) weeks.add(week);
  }
  if (weeks.size < 2) return [];
  const first = Math.min(...weeks);
  const last = Math.max(...weeks);
  const byes: number[] = [];
  for (let week = first + 1; week < last; week++) if (!weeks.has(week)) byes.push(week);
  return byes;
}

/**
 * The page as it would have looked at `isoTime`, so a replay never shows a
 * result early: every game dated after that moment is shown as not yet played,
 * with no score, result or status text. Nothing else is recomputed. The
 * profile's record, stats, rank and standing, and the bye weeks, stay exactly
 * as fetched.
 */
export function teamPageAsOf(page: TeamPage, isoTime: string): TeamPage {
  const cutoff = Date.parse(isoTime);
  if (!Number.isFinite(cutoff)) throw new Error(`teamPageAsOf needs an ISO time, got ${JSON.stringify(isoTime)}`);
  return {
    ...page,
    schedule: page.schedule.map((game): ScheduleGame => {
      const kickoff = Date.parse(game.date);
      // A date that cannot be read cannot be shown to be before the cutoff, so that game stays hidden too.
      if (Number.isFinite(kickoff) && kickoff <= cutoff) return game;
      return {
        ...game,
        status: { state: 'pre', completed: false, detail: null, shortDetail: null },
        score: null,
        result: null,
      };
    }),
  };
}

/**
 * A schedule game as a game summary Gridiron already holds reports it (the
 * live board, or the replay lab at its clock): status and score from that
 * summary, from this team's side, and the result read from the final score.
 */
export function withSummary(game: ScheduleGame, summary: GameSummary): ScheduleGame {
  const kind = summary.status.kind;
  const state: ScheduleState = kind === 'scheduled' ? 'pre' : kind === 'final' || kind === 'postponed' || kind === 'canceled' ? 'post' : kind === 'unknown' ? 'unknown' : 'in';
  const completed = kind === 'final';
  const { home, away } = summary.score;
  const atHome = game.homeAway === 'home';
  const score = state !== 'pre' && home !== null && away !== null ? { team: atHome ? home : away, opponent: atHome ? away : home } : null;
  return {
    ...game,
    status: { state, completed, detail: summary.status.detail, shortDetail: summary.status.detail },
    score,
    result: completed && score ? (score.team > score.opponent ? 'W' : score.team < score.opponent ? 'L' : 'T') : null,
  };
}

/** How long after kickoff a game's result may still be unknown at a replay moment. */
const RESULT_WINDOW_MS = 6 * 60 * 60_000;

/**
 * The page at a replay moment. Games the replay holds show the replay's own
 * status and score; games after the moment are not yet played (teamPageAsOf);
 * and a game that kicked off shortly before the moment but is not part of the
 * replay shows no result, because its result may not have been known yet.
 */
export function teamPageAtReplay(page: TeamPage, atMs: number, known: (gameId: GameId) => GameSummary | null): TeamPage {
  const asOf = teamPageAsOf(page, new Date(atMs).toISOString());
  return {
    ...asOf,
    schedule: asOf.schedule.map((game): ScheduleGame => {
      const summary = known(game.gameId);
      if (summary) return withSummary(game, summary);
      const kickoff = Date.parse(game.date);
      if (Number.isFinite(kickoff) && kickoff <= atMs && atMs - kickoff < RESULT_WINDOW_MS) {
        return { ...game, status: { state: 'unknown', completed: false, detail: 'Result not known at the replay clock', shortDetail: 'Result not known yet' }, score: null, result: null };
      }
      return game;
    }),
  };
}
