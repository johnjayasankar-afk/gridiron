/** View models shared by the slate, focus, wall, summary strip and Director mode. */
import { useMemo } from 'react';
import type { AlertRules } from '../../shared/alerts';
import { ALERT_LABELS } from '../../shared/alerts';
import type { Alert, Division, GameId, GameSummary } from '../../shared/model';
import { watchNext, type WatchItem } from '../../shared/watch';
import { useNow } from '../lib/motion';
import { useFeed } from './feed';
import { useLive, usePresentedWorld, type World } from './live';
import { DEFAULT_FILTERS, usePrefs, type FavoriteTeam, type Filters, type LeagueFilter, type SortMode } from './prefs';
import { gameMatches, sectionOf, slateGames, sortGames, staleGames, watchOrderOf, type SlateSection } from './selectors';
import { useUi } from './ui';

export interface SlateModel {
  world: World;
  /** Every game on the presented day, before filters. */
  all: GameSummary[];
  /** Games in the chosen league and divisions, before the optional filters. */
  inScope: GameSummary[];
  shown: GameSummary[];
  sections: Record<SlateSection, GameSummary[]>;
  watch: WatchItem[];
  watchById: Map<GameId, WatchItem>;
  stale: Set<GameId>;
  favorites: Set<string>;
}

export interface SlateModelInput {
  world: World;
  league: LeagueFilter;
  divisions: Division[];
  filters: Filters;
  favorites: FavoriteTeam[];
  sort: SortMode;
  pinned: GameId[];
  rules: AlertRules;
  query: string;
  connectionDown: boolean;
  moments: Alert[];
  now: number;
}

const MAJOR = new Set(['touchdown', 'turnover', 'lead_change']);

export function buildSlateModel(input: SlateModelInput): SlateModel {
  const { world, league, divisions, filters, sort, pinned, rules, query, connectionDown, moments, now } = input;
  const favorites = new Set(input.favorites.map((f) => f.key));
  const all = slateGames(world);
  const stale = staleGames(world, connectionDown);
  const scope = { league, divisions, favorites, closeMargin: rules.closeMargin, query: '', pinned: new Set(pinned), filters: DEFAULT_FILTERS };
  const inScope = all.filter((g) => gameMatches(g, scope));
  const recentMajor = new Map<GameId, { at: number; label: string }>();
  for (const m of moments) {
    if (m.status !== 'active' || !MAJOR.has(m.kind) || now - m.receivedAt > 3 * 60_000 || recentMajor.has(m.gameId)) continue;
    recentMajor.set(m.gameId, { at: m.receivedAt, label: ALERT_LABELS[m.kind] });
  }
  const watch = watchNext(inScope, { favorites: [...favorites], recentMajor, staleGames: stale, now, closeMargin: rules.closeMargin, lateSeconds: rules.lateSeconds });
  const shown = sortGames(
    inScope.filter((g) => gameMatches(g, { ...scope, filters, query })),
    { mode: sort, watchOrder: watchOrderOf(watch), pinned, favorites },
  );
  const sections: Record<SlateSection, GameSummary[]> = { live: [], upcoming: [], final: [], other: [] };
  for (const g of shown) sections[sectionOf(g)].push(g);
  return { world, all, inScope, shown, sections, watch, watchById: new Map(watch.map((w) => [w.gameId, w])), stale, favorites };
}

/** The current slate model outside React, for drivers such as Director mode. */
export function currentSlateModel(now = Date.now()): SlateModel {
  const p = usePrefs.getState();
  const live = useLive.getState();
  return buildSlateModel({
    world: live.presented.world,
    league: p.league,
    divisions: p.divisions,
    filters: p.filters,
    favorites: p.favorites,
    sort: p.sort,
    pinned: p.pinned,
    rules: p.alertRules,
    query: useUi.getState().slateQuery,
    connectionDown: live.connection.status === 'reconnecting' || live.connection.status === 'offline',
    moments: useFeed.getState().moments,
    now,
  });
}

/** Slate order for moving between games: live, then upcoming, final and the rest. */
export const navigationOrder = (model: SlateModel): GameId[] => [...model.sections.live, ...model.sections.upcoming, ...model.sections.final, ...model.sections.other].map((g) => g.id);

export function useSlateModel(): SlateModel {
  const world = usePresentedWorld();
  const league = usePrefs((s) => s.league);
  const divisions = usePrefs((s) => s.divisions);
  const filters = usePrefs((s) => s.filters);
  const favorites = usePrefs((s) => s.favorites);
  const sort = usePrefs((s) => s.sort);
  const pinned = usePrefs((s) => s.pinned);
  const rules = usePrefs((s) => s.alertRules);
  const query = useUi((s) => s.slateQuery);
  const connectionDown = useLive((s) => s.connection.status === 'reconnecting' || s.connection.status === 'offline');
  const moments = useFeed((s) => s.moments);
  const now = useNow(20_000);

  return useMemo(
    () => buildSlateModel({ world, league, divisions, filters, favorites, sort, pinned, rules, query, connectionDown, moments, now }),
    [world, league, divisions, filters, favorites, sort, pinned, rules, query, connectionDown, moments, now],
  );
}
