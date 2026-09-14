/**
 * Director mode: follow the one game worth watching right now, the way a
 * whip-around broadcast would, using reported information only.
 *
 * Every pick carries its reason. Hysteresis keeps the director from flapping:
 * a better situation elsewhere takes over only after a minimum time on the
 * current game, and a breaking moment (a touchdown, a turnover, a lead change)
 * can cut in sooner, but only once per moment and never when the current game
 * has its own breaking moment. Late updates never cut in.
 */
import type { Alert, AlertKind, GameId } from './model.js';
import type { WatchItem } from './watch.js';

export interface DirectorState {
  gameId: GameId | null;
  reason: string | null;
  /** Presentation time the director started following this game. */
  since: number;
  /** The breaking moment that caused the current pick, so it never triggers twice. */
  momentId: string | null;
  /** The viewer asked to stay on this game. */
  locked: boolean;
}

export const DIRECTOR_IDLE: DirectorState = { gameId: null, reason: null, since: 0, momentId: null, locked: false };

export interface DirectorOptions {
  /** Minimum time on a game before a better situation elsewhere can take over. */
  minDwellMs: number;
  /** Minimum time on a game before a breaking moment elsewhere can cut in. */
  breakingDwellMs: number;
  /** How recent a moment must be to count as breaking. */
  breakingWindowMs: number;
}

export const DIRECTOR_DEFAULTS: DirectorOptions = { minDwellMs: 45_000, breakingDwellMs: 12_000, breakingWindowMs: 25_000 };

export interface DirectorInput {
  now: number;
  /** Watch next ranking, best first. */
  watch: WatchItem[];
  /** Moments this session, newest first. */
  moments: Alert[];
  /** Games in progress (or paused) right now. */
  live: ReadonlySet<GameId>;
  muted: ReadonlySet<GameId>;
  /** Games the viewer skipped, with the time the skip ends. */
  skipped: ReadonlyMap<GameId, number>;
}

export const BREAKING_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>(['touchdown', 'turnover', 'safety', 'lead_change', 'overtime']);

export const watchReason = (w: WatchItem) => [w.label, w.reasons[0]].filter(Boolean).join(' · ');

const breakingReason = (m: Alert) => `Just happened · ${m.title}`;

function isBreaking(m: Alert, now: number, windowMs: number): boolean {
  return m.status === 'active' && !m.late && BREAKING_KINDS.has(m.kind) && now - m.receivedAt <= windowMs && now >= m.receivedAt;
}

export function directorNext(state: DirectorState, input: DirectorInput, options: DirectorOptions = DIRECTOR_DEFAULTS): DirectorState {
  const { now } = input;
  const eligible = (id: GameId) => input.live.has(id) && !input.muted.has(id) && (input.skipped.get(id) ?? 0) <= now;
  const current = state.gameId;
  const ranked = input.watch.filter((w) => !w.stale && eligible(w.gameId));
  const best = ranked[0] ?? null;
  const breaking = input.moments.find((m) => isBreaking(m, now, options.breakingWindowMs) && eligible(m.gameId)) ?? null;

  const follow = (gameId: GameId, reason: string, momentId: string | null): DirectorState =>
    gameId === current ? { ...state, reason, momentId: momentId ?? state.momentId } : { gameId, reason, since: now, momentId, locked: false };

  // A game that is still live stays put while locked, even if it was muted or skipped afterwards.
  if (state.locked && current !== null && input.live.has(current)) {
    const item = ranked.find((w) => w.gameId === current);
    return item ? { ...state, reason: watchReason(item) } : state;
  }

  // Nothing to follow yet, or the current game ended, was muted or skipped.
  if (current === null || !eligible(current)) {
    if (breaking) return follow(breaking.gameId, breakingReason(breaking), breaking.id);
    if (best) return follow(best.gameId, watchReason(best), null);
    const anyLive = [...input.live].sort().find(eligible);
    return anyLive ? follow(anyLive, 'Live', null) : { ...DIRECTOR_IDLE };
  }

  const dwell = now - state.since;

  // A breaking moment elsewhere cuts in after a short look at the current game.
  if (breaking && breaking.gameId !== current && breaking.id !== state.momentId && dwell >= options.breakingDwellMs) {
    const currentBreaking = input.moments.some((m) => m.gameId === current && isBreaking(m, now, options.breakingWindowMs));
    if (!currentBreaking) return follow(breaking.gameId, breakingReason(breaking), breaking.id);
  }

  // A strictly better situation elsewhere takes over after the minimum dwell.
  const currentItem = ranked.find((w) => w.gameId === current) ?? null;
  if (best && best.gameId !== current && dwell >= options.minDwellMs && best.tier < (currentItem?.tier ?? Number.POSITIVE_INFINITY)) {
    return follow(best.gameId, watchReason(best), null);
  }

  // Stay, keeping the reason current. A breaking reason holds for its window.
  if (state.momentId && input.moments.some((m) => m.id === state.momentId && isBreaking(m, now, options.breakingWindowMs))) return state;
  return { ...state, reason: currentItem ? watchReason(currentItem) : 'Live', momentId: null };
}

/** Lock or unlock the current pick. */
export const setDirectorLock = (state: DirectorState, locked: boolean): DirectorState => (state.gameId ? { ...state, locked } : state);
