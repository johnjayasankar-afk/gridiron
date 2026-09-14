/**
 * Preferences that persist in this browser: layout, favorites, boards, alert
 * rules, theme, effects and the spoiler delay. Nothing here is sent anywhere,
 * except that turning on push alerts sends the favorite teams and chosen alert
 * kinds to the server that delivers them.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_ALERT_RULES, type AlertRules } from '../../shared/alerts';
import { clampDelaySeconds } from '../../shared/delay';
import type { AlertKind, Density, Division, GameId, LayoutMode, LeagueId, TeamKey } from '../../shared/model';
import { DEFAULT_PUSH_KINDS, PUSH_KINDS } from '../../shared/push';
import type { FieldStyle } from '../field/style';

export type Theme = 'light' | 'dark' | 'system';
export type Effects = 'full' | 'reduced' | 'flat';
export type SortMode = 'watch' | 'kickoff' | 'favorites' | 'closest';
export type LeagueFilter = 'all' | LeagueId;
export type DayMode = 'live' | 'today' | 'date';
export type WallSize = 4 | 9 | 16;
export type FocusSize = 1 | 2 | 4;

export interface FavoriteTeam {
  key: TeamKey;
  league: LeagueId;
  abbreviation: string;
  name: string;
  logo: string | null;
  color: string | null;
}

export interface Filters {
  favoritesOnly: boolean;
  liveOnly: boolean;
  redZone: boolean;
  close: boolean;
  conference: string | null;
  /** Set by a team board: only games involving these teams (plus pinned games). Resolved against whichever day is shown. */
  teams: TeamKey[];
}

export interface SavedBoard {
  id: string;
  name: string;
  /** Team-based boards resolve their games for whichever day is selected. */
  teams: TeamKey[];
  /** Game-based boards pin specific events. */
  games: GameId[];
  focus: GameId[];
  league: LeagueFilter;
  divisions: Division[];
  layout: LayoutMode;
  density: Density;
  filters: Filters;
  createdAt: number;
  updatedAt: number;
}

export interface PushPrefs {
  /** Push alerts are on for this browser; the server holds the subscription. */
  enabled: boolean;
  kinds: AlertKind[];
}

export interface PrefsData {
  theme: Theme;
  effects: Effects;
  /** How fields are drawn: holographic light or classic turf. */
  fieldStyle: FieldStyle;
  /** Show win probability, sportsbook lines and market prices. */
  showOdds: boolean;
  /** How odds are written: American, decimal, or the chance they imply. */
  oddsFormat: 'american' | 'decimal' | 'percent';
  density: Density;
  layout: LayoutMode;
  focusSize: FocusSize;
  focusGames: GameId[];
  pinned: GameId[];
  favorites: FavoriteTeam[];
  league: LeagueFilter;
  divisions: Division[];
  dayMode: DayMode;
  date: string | null;
  sort: SortMode;
  filters: Filters;
  wallSize: WallSize;
  alertRules: AlertRules;
  mutedGames: GameId[];
  snoozeUntil: number | null;
  quiet: boolean;
  sound: boolean;
  notifications: boolean;
  announce: AlertKind[];
  push: PushPrefs;
  delaySeconds: number;
  railOpen: boolean;
  autoFocus: boolean;
  /** Director mode: an automatic slot that follows the most important live situation. */
  director: { focus: boolean; wall: boolean };
  boards: SavedBoard[];
  activeBoardId: string | null;
  recentSearches: string[];
}

export const DEFAULT_FILTERS: Filters = { favoritesOnly: false, liveOnly: false, redZone: false, close: false, conference: null, teams: [] };

export const DEFAULT_PREFS: PrefsData = {
  theme: 'dark',
  effects: typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full',
  fieldStyle: 'holo',
  showOdds: true,
  oddsFormat: 'american',
  density: 'comfortable',
  layout: 'slate',
  focusSize: 4,
  focusGames: [],
  pinned: [],
  favorites: [],
  league: 'all',
  divisions: ['FBS', 'FCS'],
  dayMode: 'live',
  date: null,
  sort: 'watch',
  filters: DEFAULT_FILTERS,
  wallSize: 9,
  alertRules: DEFAULT_ALERT_RULES,
  mutedGames: [],
  snoozeUntil: null,
  quiet: false,
  sound: false,
  notifications: false,
  announce: ['touchdown', 'turnover', 'final'],
  push: { enabled: false, kinds: [...DEFAULT_PUSH_KINDS] },
  delaySeconds: 0,
  railOpen: true,
  autoFocus: false,
  director: { focus: false, wall: false },
  boards: [],
  activeBoardId: null,
  recentSearches: [],
};

interface PrefsActions {
  set: (patch: Partial<PrefsData>) => void;
  setFilter: (patch: Partial<Filters>) => void;
  toggleFavorite: (team: FavoriteTeam) => void;
  togglePin: (id: GameId) => void;
  setFocusGames: (ids: GameId[]) => void;
  addToFocus: (id: GameId) => void;
  removeFromFocus: (id: GameId) => void;
  replaceFocus: (index: number, id: GameId) => void;
  swapFocus: (a: number, b: number) => void;
  toggleMute: (id: GameId) => void;
  setAlertRules: (rules: AlertRules) => void;
  setDelay: (seconds: number) => void;
  saveBoard: (name: string) => SavedBoard;
  duplicateBoard: (id: string) => SavedBoard | null;
  renameBoard: (id: string, name: string) => void;
  deleteBoard: (id: string) => SavedBoard | null;
  restoreBoard: (board: SavedBoard) => void;
  applyBoard: (board: SavedBoard) => void;
  resetLayout: () => void;
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const without = <T>(list: T[], item: T) => list.filter((x) => x !== item);

export const usePrefs = create<PrefsData & PrefsActions>()(
  persist(
    (set, get) => ({
      ...DEFAULT_PREFS,
      set: (patch) => set(patch),
      setFilter: (patch) => set({ filters: { ...get().filters, ...patch } }),
      toggleFavorite: (team) => {
        const has = get().favorites.some((f) => f.key === team.key);
        set({ favorites: has ? get().favorites.filter((f) => f.key !== team.key) : [...get().favorites, team] });
      },
      togglePin: (id) => {
        const pinned = get().pinned;
        set({ pinned: pinned.includes(id) ? without(pinned, id) : [...pinned, id] });
      },
      setFocusGames: (ids) => set({ focusGames: [...new Set(ids)].slice(0, 4) }),
      addToFocus: (id) => {
        const focus = get().focusGames;
        if (focus.includes(id)) return;
        const size = get().focusSize;
        const next = focus.length >= 4 ? [...focus.slice(1), id] : [...focus, id];
        set({ focusGames: next, focusSize: next.length > size ? (next.length > 2 ? 4 : (next.length as FocusSize)) : size });
      },
      removeFromFocus: (id) => set({ focusGames: without(get().focusGames, id) }),
      replaceFocus: (index, id) => {
        const focus = [...get().focusGames];
        const existing = focus.indexOf(id);
        if (existing >= 0) focus[existing] = focus[index];
        focus[index] = id;
        set({ focusGames: focus.filter(Boolean).slice(0, 4) });
      },
      swapFocus: (a, b) => {
        const focus = [...get().focusGames];
        if (!focus[a] || !focus[b]) return;
        [focus[a], focus[b]] = [focus[b], focus[a]];
        set({ focusGames: focus });
      },
      toggleMute: (id) => {
        const muted = get().mutedGames;
        set({ mutedGames: muted.includes(id) ? without(muted, id) : [...muted, id] });
      },
      setAlertRules: (rules) => set({ alertRules: rules }),
      setDelay: (seconds) => set({ delaySeconds: clampDelaySeconds(seconds) }),
      saveBoard: (name) => {
        const s = get();
        const now = Date.now();
        const board: SavedBoard = {
          id: uid(),
          name: name.trim().slice(0, 60) || 'Untitled board',
          teams: s.filters.teams.length ? s.filters.teams : s.favorites.map((f) => f.key),
          games: s.pinned,
          focus: s.focusGames,
          league: s.league,
          divisions: s.divisions,
          layout: s.layout,
          density: s.density,
          filters: s.filters,
          createdAt: now,
          updatedAt: now,
        };
        set({ boards: [...s.boards, board], activeBoardId: board.id });
        return board;
      },
      duplicateBoard: (id) => {
        const source = get().boards.find((b) => b.id === id);
        if (!source) return null;
        const now = Date.now();
        const copy: SavedBoard = { ...source, id: uid(), name: `${source.name} copy`.slice(0, 60), createdAt: now, updatedAt: now };
        set({ boards: [...get().boards, copy] });
        return copy;
      },
      renameBoard: (id, name) =>
        set({ boards: get().boards.map((b) => (b.id === id ? { ...b, name: name.trim().slice(0, 60) || b.name, updatedAt: Date.now() } : b)) }),
      deleteBoard: (id) => {
        const board = get().boards.find((b) => b.id === id) ?? null;
        set({ boards: get().boards.filter((b) => b.id !== id), activeBoardId: get().activeBoardId === id ? null : get().activeBoardId });
        return board;
      },
      restoreBoard: (board) => {
        if (get().boards.some((b) => b.id === board.id)) return;
        set({ boards: [...get().boards, board] });
      },
      applyBoard: (board) =>
        set({
          pinned: board.games,
          focusGames: board.focus.slice(0, 4),
          league: board.league,
          divisions: board.divisions.length ? board.divisions : DEFAULT_PREFS.divisions,
          layout: board.layout,
          density: board.density,
          filters: { ...DEFAULT_FILTERS, ...board.filters, teams: board.teams },
          activeBoardId: board.id,
        }),
      resetLayout: () =>
        set({
          layout: 'slate',
          density: 'comfortable',
          focusGames: [],
          focusSize: 4,
          wallSize: 9,
          sort: 'watch',
          filters: DEFAULT_FILTERS,
          league: 'all',
          railOpen: true,
          activeBoardId: null,
        }),
    }),
    {
      name: 'gridiron.prefs.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => {
        const { set: _s, setFilter: _f, toggleFavorite: _t, togglePin: _p, setFocusGames: _sf, addToFocus: _a, removeFromFocus: _r, replaceFocus: _rf, swapFocus: _sw, toggleMute: _m, setAlertRules: _ar, setDelay: _d, saveBoard: _sb, duplicateBoard: _db, renameBoard: _rb, deleteBoard: _del, restoreBoard: _res, applyBoard: _ap, resetLayout: _rl, ...data } = s;
        return data;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PrefsData>;
        const pushKinds = Array.isArray(p.push?.kinds) ? p.push.kinds.filter((k) => PUSH_KINDS.includes(k)) : null;
        return {
          ...current,
          ...p,
          filters: { ...DEFAULT_FILTERS, ...(p.filters ?? {}) },
          director: { ...DEFAULT_PREFS.director, ...(p.director ?? {}) },
          alertRules: {
            ...DEFAULT_ALERT_RULES,
            ...(p.alertRules ?? {}),
            enabled: { ...DEFAULT_ALERT_RULES.enabled, ...(p.alertRules?.enabled ?? {}) },
          },
          push: { enabled: p.push?.enabled === true, kinds: pushKinds ?? [...DEFAULT_PUSH_KINDS] },
          showOdds: typeof p.showOdds === 'boolean' ? p.showOdds : DEFAULT_PREFS.showOdds,
          oddsFormat: p.oddsFormat === 'decimal' || p.oddsFormat === 'percent' ? p.oddsFormat : 'american',
          delaySeconds: clampDelaySeconds(p.delaySeconds ?? 0),
        };
      },
    },
  ),
);
