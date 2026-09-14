/**
 * Derived views of the presented world, shared by cards, the wall, alerts and
 * Watch next so they always agree. Pure functions, cached by object identity so
 * unchanged games keep stable references between updates.
 */
import { margin } from '../../shared/format';
import type { GameDetail, GameId, GameSummary, Situation } from '../../shared/model';
import { isLiveOrPaused } from '../../shared/model';
import { mergeSummaries, situationFromPlays } from '../../shared/situation';
import type { WatchItem } from '../../shared/watch';
import type { World } from './live';
import type { Filters, LeagueFilter, SortMode } from './prefs';

const merged = new WeakMap<GameSummary, WeakMap<GameSummary, GameSummary>>();

/** The newest report of a game, combining the slate and its play-by-play summary. */
export function bestSummary(world: World, id: GameId): GameSummary | null {
  const slate = world.games[id] ?? null;
  const fromDetail = world.details[id]?.detail?.summary ?? null;
  if (!slate || !fromDetail) return slate ?? fromDetail;
  let inner = merged.get(slate);
  if (!inner) {
    inner = new WeakMap();
    merged.set(slate, inner);
  }
  let m = inner.get(fromDetail);
  if (!m) {
    m = mergeSummaries(slate, fromDetail);
    inner.set(fromDetail, m);
  }
  return m;
}

export function detailOf(world: World, id: GameId): GameDetail | null {
  return world.details[id]?.detail ?? null;
}

export function slateGames(world: World): GameSummary[] {
  return Object.keys(world.games)
    .map((id) => bestSummary(world, id))
    .filter((g): g is GameSummary => g !== null);
}

export interface DisplaySituation {
  situation: Situation | null;
  /** The spot is the end of the last reported play rather than a live pre-snap report. */
  lastKnown: boolean;
}

const derived = new WeakMap<GameDetail, Situation | null>();

export function displaySituation(game: GameSummary, detail: GameDetail | null): DisplaySituation {
  if (!isLiveOrPaused(game.status.kind)) return { situation: null, lastKnown: false };
  const reported = game.situation;
  if (reported && reported.spot.schematicYard !== null) return { situation: reported, lastKnown: reported.spot.phase === 'post-play' };
  // The live report can drop the spot between snaps. While play is running, show where the last reported play
  // ended instead, labeled as the last known spot. Not at halftime or a period break, when the ball will move.
  if (detail && game.status.kind === 'in_progress') {
    if (!derived.has(detail)) derived.set(detail, situationFromPlays(detail.plays));
    const fromPlays = derived.get(detail) ?? null;
    if (fromPlays && fromPlays.spot.schematicYard !== null) return { situation: fromPlays, lastKnown: true };
  }
  return { situation: reported ?? null, lastKnown: false };
}

// ---------------------------------------------------------------- filters

export interface FilterContext {
  league: LeagueFilter;
  divisions: string[];
  filters: Filters;
  favorites: ReadonlySet<string>;
  query: string;
  closeMargin: number;
  pinned?: ReadonlySet<GameId>;
}

export const isFavoriteGame = (g: GameSummary, favorites: ReadonlySet<string>) => favorites.has(g.home.key) || favorites.has(g.away.key);

export function searchText(g: GameSummary): string {
  return [
    g.away.displayName, g.away.shortName, g.away.abbreviation, g.away.location,
    g.home.displayName, g.home.shortName, g.home.abbreviation, g.home.location,
    g.venue?.name, g.venue?.city, g.name, g.shortName, ...g.broadcasts.map((b) => b.name),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function gameMatches(g: GameSummary, ctx: FilterContext): boolean {
  if (ctx.league !== 'all' && g.league !== ctx.league) return false;
  if (g.league === 'cfb' && g.divisions.length && !g.divisions.some((d) => ctx.divisions.includes(d))) return false;
  const live = isLiveOrPaused(g.status.kind);
  const f = ctx.filters;
  if (f.liveOnly && !live) return false;
  if (f.favoritesOnly && !isFavoriteGame(g, ctx.favorites)) return false;
  if (f.redZone && !(live && (g.situation?.spot.progress ?? -1) >= 80)) return false;
  if (f.close) {
    const m = margin(g);
    if (!(live && m !== null && m <= ctx.closeMargin)) return false;
  }
  if (f.conference && g.home.conferenceId !== f.conference && g.away.conferenceId !== f.conference) return false;
  if (f.teams.length && !f.teams.includes(g.home.key) && !f.teams.includes(g.away.key) && !ctx.pinned?.has(g.id)) return false;
  const tokens = ctx.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length) {
    const hay = searchText(g);
    if (!tokens.every((t) => hay.includes(t))) return false;
  }
  return true;
}

export const activeFilterCount = (f: Filters) => [f.favoritesOnly, f.liveOnly, f.redZone, f.close, f.conference !== null, f.teams.length > 0].filter(Boolean).length;

// ---------------------------------------------------------------- sections & sorting

export type SlateSection = 'live' | 'upcoming' | 'final' | 'other';

export function sectionOf(g: GameSummary): SlateSection {
  const k = g.status.kind;
  if (isLiveOrPaused(k)) return 'live';
  if (k === 'scheduled') return 'upcoming';
  if (k === 'final') return 'final';
  return 'other';
}

export interface SortContext {
  mode: SortMode;
  watchOrder: ReadonlyMap<GameId, number>;
  pinned: readonly GameId[];
  favorites: ReadonlySet<string>;
}

const byKickoff = (a: GameSummary, b: GameSummary) => (a.startTime ?? '9999').localeCompare(b.startTime ?? '9999') || a.id.localeCompare(b.id);

/** Pinned games keep their pinned order at the top; the rest follow the chosen sort. */
export function sortGames(games: GameSummary[], ctx: SortContext): GameSummary[] {
  const pinIndex = new Map(ctx.pinned.map((id, i) => [id, i]));
  return [...games].sort((a, b) => {
    const pa = pinIndex.get(a.id);
    const pb = pinIndex.get(b.id);
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      return pa - pb;
    }
    switch (ctx.mode) {
      case 'watch': {
        const wa = ctx.watchOrder.get(a.id);
        const wb = ctx.watchOrder.get(b.id);
        if (wa !== undefined || wb !== undefined) {
          if (wa === undefined) return 1;
          if (wb === undefined) return -1;
          return wa - wb;
        }
        return byKickoff(a, b);
      }
      case 'favorites':
        return Number(isFavoriteGame(b, ctx.favorites)) - Number(isFavoriteGame(a, ctx.favorites)) || byKickoff(a, b);
      case 'closest': {
        const ma = isLiveOrPaused(a.status.kind) ? margin(a) : null;
        const mb = isLiveOrPaused(b.status.kind) ? margin(b) : null;
        if (ma === null && mb === null) return byKickoff(a, b);
        if (ma === null) return 1;
        if (mb === null) return -1;
        return ma - mb || byKickoff(a, b);
      }
      default:
        return byKickoff(a, b);
    }
  });
}

export function watchOrderOf(items: WatchItem[]): Map<GameId, number> {
  return new Map(items.map((w, i) => [w.gameId, i]));
}

// ---------------------------------------------------------------- freshness

/** Games whose information is known to be behind: their league feed or their play-by-play is stale or unavailable. */
export function staleGames(world: World, connectionDown: boolean): Set<GameId> {
  const out = new Set<GameId>();
  for (const id of Object.keys(world.games)) {
    const g = world.games[id];
    if (!isLiveOrPaused(g.status.kind)) continue;
    const league = world.freshness[g.league];
    const detail = world.details[id];
    if (connectionDown || league.health === 'stale' || league.health === 'unavailable') out.add(id);
    else if (detail && (detail.freshness.health === 'stale' || detail.freshness.health === 'unavailable')) out.add(id);
  }
  return out;
}

export function describeGame(world: World, id: GameId): string {
  const g = bestSummary(world, id);
  return g ? `${g.away.abbreviation} at ${g.home.abbreviation}` : 'Game';
}
