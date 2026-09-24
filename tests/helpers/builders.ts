/** Small builders for hand-written test scenarios. Every value is explicit in the test that uses it. */
import { schematicYardFromProgress, type Side } from '../../shared/field';
import type { BallSpot, Conversion, GameDetail, GameStatusKind, GameSummary, LeagueId, PlayEvent, PlayKind, Situation, Team } from '../../shared/model';
import { UNKNOWN_SPOT } from '../../shared/model';

export function team(abbreviation: string, league: LeagueId = 'nfl'): Team {
  return {
    key: `${league}-${abbreviation}`,
    league,
    providerId: abbreviation,
    abbreviation,
    displayName: `${abbreviation} Team`,
    shortName: abbreviation,
    location: null,
    color: '#1f6b4a',
    alternateColor: null,
    logo: null,
    logoDark: null,
    rank: null,
    record: null,
    conferenceId: null,
  };
}

export function spot(progress: number | null, offense: Side | null, phase: BallSpot['phase'] = 'pre-snap'): BallSpot {
  if (progress === null || offense === null) return { ...UNKNOWN_SPOT, offense, phase };
  return { label: null, offense, progress, schematicYard: schematicYardFromProgress(progress, offense), phase, provenance: 'label', lateral: null, sourceTime: null };
}

export function situation(o: { possession?: Side | null; progress?: number | null; down?: number | null; distance?: number | null; goalToGo?: boolean | null } = {}): Situation {
  const possession = o.possession === undefined ? 'away' : o.possession;
  const progress = o.progress === undefined ? 25 : o.progress;
  return {
    possession,
    down: o.down === undefined ? 1 : o.down,
    distance: o.distance === undefined ? 10 : o.distance,
    goalToGo: o.goalToGo ?? false,
    downDistanceText: null,
    spot: spot(progress, possession),
    isRedZone: progress === null ? null : progress >= 80,
    timeouts: { home: 3, away: 3 },
    lastPlay: null,
  };
}

export interface GameOptions {
  id?: string;
  league?: LeagueId;
  kind?: GameStatusKind;
  period?: number | null;
  clock?: string | null;
  home?: number | null;
  away?: number | null;
  startTime?: string | null;
  situation?: Situation | null;
  coverage?: 'full' | 'score-only';
  divisions?: GameSummary['divisions'];
  homeTeam?: string;
  awayTeam?: string;
  lines?: GameSummary['lines'];
}

export function game(o: GameOptions = {}): GameSummary {
  const league = o.league ?? 'nfl';
  const kind = o.kind ?? 'in_progress';
  const live = kind === 'in_progress' || kind === 'halftime' || kind === 'end_of_period';
  return {
    id: o.id ?? `${league}-1`,
    league,
    providerEventId: (o.id ?? `${league}-1`).split('-')[1],
    divisions: o.divisions ?? (league === 'nfl' ? ['NFL'] : ['FBS']),
    startTime: o.startTime ?? '2026-09-13T17:00:00Z',
    name: 'Away at Home',
    shortName: 'AWY @ HOM',
    home: team(o.homeTeam ?? 'HOM', league),
    away: team(o.awayTeam ?? 'AWY', league),
    score: { home: o.home === undefined ? (kind === 'scheduled' ? null : 0) : o.home, away: o.away === undefined ? (kind === 'scheduled' ? null : 0) : o.away },
    status: {
      kind,
      period: o.period === undefined ? (kind === 'scheduled' ? null : 1) : o.period,
      regulationPeriods: 4,
      clock: o.clock === undefined ? (live ? '15:00' : null) : o.clock,
      clockSeconds: null,
      detail: null,
      providerCode: null,
    },
    situation: o.situation === undefined ? (live ? situation() : null) : o.situation,
    broadcasts: [],
    venue: null,
    neutralSite: false,
    conferenceGame: false,
    links: { gamePage: null },
    season: { year: 2026, type: 2, week: 1 },
    notes: [],
    coverage: { level: o.coverage ?? 'full', score: true, situation: live, playByPlay: o.coverage !== 'score-only', drives: o.coverage !== 'score-only', teamStats: o.coverage !== 'score-only', provider: 'test' },
    ...(o.lines === undefined ? {} : { lines: o.lines }),
  };
}

/** A sportsbook reading: the home spread, the total, and both moneylines. */
export function bettingLines(spread: number, total: number, home: number, away: number): GameSummary['lines'] {
  const price = (line: number, odds: number) => ({ open: null, latest: { line, odds } });
  return {
    provider: 'Book',
    favorite: spread < 0 ? 'home' : 'away',
    details: null,
    overUnder: total,
    spread: { home: price(spread, -110), away: price(-spread, -110) },
    total: { over: price(total, -110), under: price(total, -110) },
    moneyline: { home: { open: null, latest: home }, away: { open: null, latest: away } },
  } as GameSummary['lines'];
}

export interface PlayOptions {
  n: number;
  gameId?: string;
  kind?: PlayKind;
  description?: string;
  offense?: Side | null;
  startProgress?: number | null;
  endProgress?: number | null;
  endOffense?: Side | null;
  down?: number | null;
  distance?: number | null;
  period?: number;
  clock?: string;
  home?: number;
  away?: number;
  scoring?: boolean;
  scoringTeam?: Side | null;
  turnover?: boolean;
  conversion?: Conversion | null;
  penalty?: boolean;
  yards?: number | null;
  revision?: string;
  driveId?: string | null;
}

export function play(o: PlayOptions): PlayEvent {
  const gameId = o.gameId ?? 'nfl-1';
  const offense = o.offense === undefined ? 'away' : o.offense;
  const endOffense = o.endOffense === undefined ? offense : o.endOffense;
  const startProgress = o.startProgress === undefined ? 25 : o.startProgress;
  const endProgress = o.endProgress === undefined ? startProgress : o.endProgress;
  return {
    id: `${gameId}:p${o.n}`,
    providerId: `p${o.n}`,
    gameId,
    driveId: o.driveId === undefined ? `${gameId}:drive:1` : o.driveId,
    sequence: o.n,
    order: o.n,
    period: o.period ?? 1,
    clock: o.clock ?? '10:00',
    description: o.description ?? `Play ${o.n}`,
    providerType: { id: null, text: null },
    kind: o.kind ?? 'rush',
    offense,
    start: { down: o.down === undefined ? 1 : o.down, distance: o.distance === undefined ? 10 : o.distance, goalToGo: false, downDistanceText: null, spot: spot(startProgress, offense) },
    end: { down: null, distance: null, goalToGo: false, downDistanceText: null, spot: spot(endProgress, endOffense, 'post-play') },
    yards: o.yards === undefined ? null : o.yards,
    scoring: o.scoring ?? false,
    scoringTeam: o.scoringTeam ?? null,
    turnover: o.turnover ?? false,
    penalty: o.penalty ?? false,
    possessionChanged: offense !== null && endOffense !== null ? offense !== endOffense : null,
    conversion: o.conversion ?? null,
    review: null,
    scoreAfter: { home: o.home ?? 0, away: o.away ?? 0 },
    modified: null,
    wallclock: null,
    revision: o.revision ?? `r${o.n}`,
  };
}

export function detail(summary: GameSummary, plays: PlayEvent[]): GameDetail {
  return {
    gameId: summary.id,
    summary,
    drives: [
      {
        id: `${summary.id}:drive:1`, providerId: '1', gameId: summary.id, offense: 'away', description: null, start: null, end: null,
        playIds: plays.map((p) => p.id), offensivePlays: plays.length, yards: null, timeElapsed: null, result: null, isScore: null, isCurrent: true,
      },
    ],
    plays,
    scoring: [],
    stats: [],
    leaders: [],
    attendance: null,
    currentDriveId: `${summary.id}:drive:1`,
    gaps: [],
  };
}
