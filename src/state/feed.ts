/**
 * The moments feed: every alert this session, the toasts on screen, per-card
 * event badges and the (deliberately limited) screen-reader announcement.
 * Moments that arrive close together are grouped into one toast, so a burst of
 * updates never buries the screen.
 */
import { create } from 'zustand';
import type { AlertChange } from '../../shared/alerts';
import type { Alert, GameId } from '../../shared/model';

export interface Toast {
  id: string;
  alertIds: string[];
  games: GameId[];
  titles: string[];
  title: string;
  detail: string;
  tone: 'score' | 'attention' | 'info' | 'correction' | 'group';
  gameId: GameId | null;
  late: boolean;
  createdAt: number;
  priority: 1 | 2 | 3;
}

export interface ApplyOptions {
  now: number;
  toastFor: (alert: Alert) => boolean;
  announceFor: (alert: Alert) => boolean;
  describeGame: (gameId: GameId) => string;
}

interface FeedState {
  moments: Alert[];
  unread: number;
  badges: Record<GameId, Alert>;
  toasts: Toast[];
  toasted: Record<string, true>;
  announcement: { text: string; at: number } | null;
  apply: (changes: AlertChange[], options: ApplyOptions) => Toast[];
  dismissToast: (id: string) => void;
  markRead: () => void;
  clear: () => void;
  clearToasts: () => void;
}

const MAX_MOMENTS = 250;
const MAX_TOASTS = 4;
/** Toasts created within this window of each other are merged once there are three or more. */
const GROUP_WINDOW_MS = 2500;

const toneFor = (a: Alert): Toast['tone'] => {
  if (a.status !== 'active') return 'correction';
  if (a.kind === 'touchdown' || a.kind === 'field_goal' || a.kind === 'safety' || a.kind === 'final') return 'score';
  if (a.kind === 'turnover' || a.kind === 'red_zone' || a.kind === 'fourth_down' || a.kind === 'fourth_down_attempt' || a.kind === 'close_late' || a.kind === 'overtime') return 'attention';
  return 'info';
};

function groupToasts(parts: Toast[], now: number): Toast {
  const alertIds = parts.flatMap((t) => t.alertIds);
  const games = [...new Set(parts.flatMap((t) => t.games))];
  const titles = parts.flatMap((t) => t.titles);
  const late = parts.every((t) => t.late);
  const where = `${games.length} ${games.length === 1 ? 'game' : 'games'}`;
  return {
    id: `group:${now}:${alertIds[0]}`,
    alertIds,
    games,
    titles,
    title: late ? `${alertIds.length} late updates across ${where}` : `${alertIds.length} moments across ${where}`,
    detail: titles.slice(0, 3).join(' · ') + (titles.length > 3 ? ` and ${titles.length - 3} more` : ''),
    tone: 'group',
    gameId: games.length === 1 ? games[0] : null,
    late,
    createdAt: now,
    priority: Math.min(...parts.map((t) => t.priority)) as 1 | 2 | 3,
  };
}

export const useFeed = create<FeedState>()((set, get) => ({
  moments: [],
  unread: 0,
  badges: {},
  toasts: [],
  toasted: {},
  announcement: null,

  apply(changes, options) {
    if (!changes.length) return [];
    const state = get();
    let moments = state.moments;
    let unread = state.unread;
    const badges = { ...state.badges };
    const toasted = { ...state.toasted };
    const fresh: Toast[] = [];
    let announce: Alert | null = null;

    for (const change of changes) {
      const a = change.alert;
      const where = options.describeGame(a.gameId);
      if (change.type === 'created') {
        if (moments.some((m) => m.id === a.id)) continue;
        moments = [a, ...moments].slice(0, MAX_MOMENTS);
        unread++;
        badges[a.gameId] = a;
        if (options.toastFor(a)) {
          fresh.push({ id: `t:${a.id}`, alertIds: [a.id], games: [a.gameId], titles: [a.title], title: a.title, detail: `${where} · ${a.detail}`, tone: toneFor(a), gameId: a.gameId, late: a.late, createdAt: options.now, priority: a.priority });
          toasted[a.id] = true;
        }
        if (!a.late && options.announceFor(a) && (!announce || a.priority < announce.priority)) announce = a;
      } else {
        moments = moments.map((m) => (m.id === a.id ? a : m));
        if (badges[a.gameId]?.id === a.id) badges[a.gameId] = a;
        if (toasted[a.id] && a.status !== 'active') {
          const title = a.status === 'withdrawn' ? `Corrected: ${a.title} withdrawn` : `Play corrected: ${a.title}`;
          fresh.push({ id: `t:${a.id}:r${a.revision}`, alertIds: [a.id], games: [a.gameId], titles: [title], title, detail: `${where} · ${a.detail}`, tone: 'correction', gameId: a.gameId, late: false, createdAt: options.now, priority: 2 });
        }
      }
    }

    let toasts = state.toasts;
    if (fresh.length) {
      const corrections = fresh.filter((t) => t.tone === 'correction');
      const momentsNow = fresh.filter((t) => t.tone !== 'correction');
      const recent = toasts.filter((t) => options.now - t.createdAt < GROUP_WINDOW_MS && t.tone !== 'correction');
      const burst = [...recent, ...momentsNow];
      if (momentsNow.length && burst.length >= 3) toasts = [...toasts.filter((t) => !recent.includes(t)), groupToasts(burst, options.now), ...corrections];
      else toasts = [...toasts, ...fresh];
      toasts = toasts.slice(-MAX_TOASTS);
    }

    set({
      moments,
      unread,
      badges,
      toasts,
      toasted,
      announcement: announce ? { text: `${announce.title}. ${options.describeGame(announce.gameId)}.`, at: options.now } : state.announcement,
    });
    return fresh;
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  markRead: () => set({ unread: 0 }),
  clear: () => set({ moments: [], unread: 0, badges: {}, toasts: [], toasted: {}, announcement: null }),
  clearToasts: () => set({ toasts: [] }),
}));
