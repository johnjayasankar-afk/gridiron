import { describe, expect, it } from 'vitest';
import { EMPTY_FRESHNESS, type Freshness, type GameSummary } from '../shared/model';
import type { World } from '../src/state/live';
import type { Filters } from '../src/state/prefs';
import { bestSummary, displaySituation, gameMatches, sortGames, staleGames, type FilterContext, type SortContext } from '../src/state/selectors';
import { detail, game, play, situation } from './helpers/builders';

const connected: Freshness = { ...EMPTY_FRESHNESS, health: 'connected' };
const NO_FILTERS: Filters = { favoritesOnly: false, liveOnly: false, redZone: false, close: false, conference: null, teams: [] };

function world(games: GameSummary[], extra: Partial<World> = {}): World {
  return {
    rev: 1,
    receivedAt: 0,
    afterGap: false,
    mode: 'live',
    replayLabel: null,
    date: '20260913',
    loaded: true,
    games: Object.fromEntries(games.map((g) => [g.id, g])),
    gameDates: {},
    details: {},
    freshness: { nfl: connected, cfb: connected },
    coverage: null,
    ...extra,
  };
}

describe('presented game selectors', () => {
  it('uses the newer report of a game and keeps a stable reference while nothing changes', () => {
    const slate = { ...game({ id: 'nfl-1', home: 7, away: 0 }), receivedAt: 1000, source: 'scoreboard' as const };
    const fresher = { ...slate, score: { home: 14, away: 0 }, receivedAt: 2000, source: 'summary' as const };
    const w = world([slate], { details: { 'nfl-1': { version: 1, detail: detail(fresher, []), freshness: connected, receivedAt: 2000 } } });
    const merged = bestSummary(w, 'nfl-1');
    expect(merged?.score.home).toBe(14);
    expect(bestSummary({ ...w, rev: 2 }, 'nfl-1')).toBe(merged);
  });

  it('marks a spot read from play-by-play as the last known spot', () => {
    expect(displaySituation(game({ id: 'nfl-2', situation: situation({ progress: 40 }) }), null)).toMatchObject({ lastKnown: false });
    const noSituation = game({ id: 'nfl-3', situation: null });
    const fromPlays = displaySituation(noSituation, detail(noSituation, [play({ n: 0, gameId: 'nfl-3', startProgress: 20, endProgress: 32 })]));
    expect(fromPlays.lastKnown).toBe(true);
    expect(fromPlays.situation?.spot.progress).toBe(32);
    expect(displaySituation(game({ kind: 'final', situation: situation() }), null).situation).toBeNull();
  });

  it('falls back to the last reported play when the live report has no spot, but not at halftime', () => {
    const noSpot = situation({ progress: null });
    const live = game({ id: 'nfl-4', situation: noSpot });
    const plays = [play({ n: 0, gameId: 'nfl-4', startProgress: 40, endProgress: 46 })];
    const fallback = displaySituation(live, detail(live, plays));
    expect(fallback.lastKnown).toBe(true);
    expect(fallback.situation?.spot.progress).toBe(46);
    const half = game({ id: 'nfl-5', kind: 'halftime', situation: noSpot });
    expect(displaySituation(half, detail(half, plays)).situation?.spot.schematicYard ?? null).toBeNull();
    expect(displaySituation(live, null)).toEqual({ situation: noSpot, lastKnown: false });
  });
});

describe('slate filters', () => {
  const base: FilterContext = { league: 'all', divisions: ['FBS', 'FCS'], filters: NO_FILTERS, favorites: new Set(), query: '', closeMargin: 8 };
  const redZone = game({ id: 'nfl-4', home: 10, away: 7, situation: situation({ progress: 85 }) });
  const blowout = game({ id: 'nfl-5', home: 35, away: 0, situation: situation({ progress: 30 }) });
  const upcoming = game({ id: 'nfl-6', kind: 'scheduled' });
  const divisionTwo = game({ id: 'cfb-7', league: 'cfb', divisions: ['D2'] });
  const bills = game({ id: 'nfl-8', homeTeam: 'BUF', awayTeam: 'MIA' });
  const chiefs = game({ id: 'nfl-9', homeTeam: 'KC', awayTeam: 'DEN' });

  it('applies league, division and live filters', () => {
    expect(gameMatches(divisionTwo, base)).toBe(false);
    expect(gameMatches(redZone, { ...base, league: 'cfb' })).toBe(false);
    expect(gameMatches(upcoming, { ...base, filters: { ...NO_FILTERS, liveOnly: true } })).toBe(false);
  });

  it('filters red zone and close games only from known values', () => {
    expect(gameMatches(redZone, { ...base, filters: { ...NO_FILTERS, redZone: true } })).toBe(true);
    expect(gameMatches(blowout, { ...base, filters: { ...NO_FILTERS, redZone: true } })).toBe(false);
    expect(gameMatches(redZone, { ...base, filters: { ...NO_FILTERS, close: true } })).toBe(true);
    expect(gameMatches(blowout, { ...base, filters: { ...NO_FILTERS, close: true } })).toBe(false);
    expect(gameMatches(upcoming, { ...base, filters: { ...NO_FILTERS, close: true } })).toBe(false);
  });

  it('matches favorites, conferences, board teams and multi-word searches', () => {
    expect(gameMatches(bills, { ...base, filters: { ...NO_FILTERS, favoritesOnly: true }, favorites: new Set(['nfl-MIA']) })).toBe(true);
    expect(gameMatches(chiefs, { ...base, filters: { ...NO_FILTERS, favoritesOnly: true }, favorites: new Set(['nfl-MIA']) })).toBe(false);
    expect(gameMatches(bills, { ...base, filters: { ...NO_FILTERS, conference: '8' } })).toBe(false);
    const board = { ...base, filters: { ...NO_FILTERS, teams: ['nfl-BUF'] }, pinned: new Set(['nfl-9']) };
    expect(gameMatches(bills, board)).toBe(true);
    expect(gameMatches(chiefs, board)).toBe(true);
    expect(gameMatches(chiefs, { ...board, pinned: new Set<string>() })).toBe(false);
    expect(gameMatches(bills, { ...base, query: 'buf team' })).toBe(true);
    expect(gameMatches(bills, { ...base, query: 'buf chiefs' })).toBe(false);
  });
});

describe('slate sorting', () => {
  const close = game({ id: 'nfl-10', startTime: '2026-09-13T17:00:00Z', home: 21, away: 20 });
  const lopsided = game({ id: 'nfl-11', startTime: '2026-09-13T20:25:00Z', home: 3, away: 30 });
  const later = game({ id: 'nfl-12', startTime: '2026-09-13T17:00:00Z', kind: 'scheduled' });
  const ctx: SortContext = { mode: 'kickoff', watchOrder: new Map(), pinned: [], favorites: new Set() };
  const ids = (games: GameSummary[]) => games.map((g) => g.id);

  it('orders by kickoff, then keeps pinned games first in their pinned order', () => {
    expect(ids(sortGames([lopsided, later, close], ctx))).toEqual(['nfl-10', 'nfl-12', 'nfl-11']);
    expect(ids(sortGames([lopsided, later, close], { ...ctx, pinned: ['nfl-11', 'nfl-12'] }))).toEqual(['nfl-11', 'nfl-12', 'nfl-10']);
  });

  it('sorts closest live games first and follows Watch next order', () => {
    expect(ids(sortGames([lopsided, later, close], { ...ctx, mode: 'closest' }))).toEqual(['nfl-10', 'nfl-11', 'nfl-12']);
    expect(ids(sortGames([lopsided, later, close], { ...ctx, mode: 'watch', watchOrder: new Map([['nfl-11', 0]]) }))).toEqual(['nfl-11', 'nfl-10', 'nfl-12']);
  });
});

describe('stale games', () => {
  const live = game({ id: 'nfl-20' });
  const scheduled = game({ id: 'nfl-21', kind: 'scheduled' });

  it('marks live games stale when their feed, their play-by-play or the connection is behind', () => {
    expect([...staleGames(world([live, scheduled], { freshness: { nfl: { ...EMPTY_FRESHNESS, health: 'stale' }, cfb: connected } }), false)]).toEqual(['nfl-20']);
    const detailDown = world([live], { details: { 'nfl-20': { version: 1, detail: null, freshness: { ...EMPTY_FRESHNESS, health: 'unavailable' }, receivedAt: 0 } } });
    expect(staleGames(detailDown, false).has('nfl-20')).toBe(true);
    expect(staleGames(world([live]), true).has('nfl-20')).toBe(true);
    expect(staleGames(world([live, scheduled]), false).size).toBe(0);
  });
});
