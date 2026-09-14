/** Director mode state: the game being followed, the viewer's lock and skips, and a counter for camera cuts. */
import { create } from 'zustand';
import { DIRECTOR_IDLE, setDirectorLock, type DirectorState } from '../../shared/director';
import type { GameId } from '../../shared/model';

/** How long a skipped game is left out. */
export const DIRECTOR_SKIP_MS = 3 * 60_000;

interface DirectorStore {
  state: DirectorState;
  skipped: Map<GameId, number>;
  /** Increases each time the followed game changes, so the field can cut. */
  cuts: number;
  apply: (next: DirectorState) => void;
  lock: (locked: boolean) => void;
  skip: (now: number) => void;
  reset: () => void;
}

export const useDirector = create<DirectorStore>()((set, get) => ({
  state: DIRECTOR_IDLE,
  skipped: new Map(),
  cuts: 0,
  apply: (next) => {
    const cur = get().state;
    if (next.gameId === cur.gameId && next.reason === cur.reason && next.locked === cur.locked && next.momentId === cur.momentId && next.since === cur.since) return;
    set({ state: next, cuts: next.gameId !== cur.gameId ? get().cuts + 1 : get().cuts });
  },
  lock: (locked) => set({ state: setDirectorLock(get().state, locked) }),
  skip: (now) => {
    const { state, skipped } = get();
    if (!state.gameId) return;
    const next = new Map([...skipped].filter(([, until]) => until > now));
    next.set(state.gameId, now + DIRECTOR_SKIP_MS);
    set({ skipped: next, state: { ...state, locked: false } });
  },
  reset: () => set({ state: DIRECTOR_IDLE, skipped: new Map() }),
}));
