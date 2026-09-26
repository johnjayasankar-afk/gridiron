/**
 * The day's recording, kept on this device.
 *
 * One track per game, written from the PRESENTED world so the tape can never
 * run ahead of the spoiler delay, and stamped with the clock the state was true
 * on: receipt time when live, the replay clock in a replay, so a replayed
 * Sunday draws the shape of a Sunday rather than the six minutes it took to
 * play back.
 *
 * It is kept in session storage so a reload during the afternoon does not throw
 * the day away. Samples are stored as arrays rather than objects because the
 * same thirteen games as objects is about four times the size for nothing.
 * Nothing is ever sent anywhere.
 */
import { create } from 'zustand';
import type { GameId } from '../../shared/model';
import { MAX_SAMPLES, pack, record, unpack, type Packed, type TapeSample, type TapeTrack } from '../../shared/tape';
import type { TapeFile } from '../../shared/tapeFile';

export { pack, unpack, type Packed };

/* v2 carries the play each reading followed. An older tape is simply not read:
   the key changes, so a v1 payload is ignored rather than half understood. */
const STORE_KEY = 'gridiron.tape.v2';
/** Beyond this the oldest game is dropped: a full Saturday of college football is about this many. */
const MAX_TRACKS = 60;

export interface TapeState {
  /** What the recording is of: a live day, or one replay session. Changing it starts a new tape. */
  sourceKey: string;
  tracks: Record<GameId, TapeTrack>;
  /** Insertion order, so the tape does not reshuffle as games are added. */
  order: GameId[];
  write: (gameId: GameId, sample: TapeSample) => void;
  restart: (sourceKey: string) => void;
  /**
   * A tape read from a file, shown instead of this device's own.
   *
   * Kept apart from `tracks` deliberately, and never merged into it. An imported
   * day was recorded by another device, on another clock, possibly behind a
   * different spoiler delay: it is a different object, and a blend of the two
   * would be a drawing of something nobody recorded. The recording carries on in
   * the background while one is open.
   */
  imported: ImportedTape | null;
  openImported: (tape: ImportedTape) => void;
  closeImported: () => void;
}

export interface ImportedTape {
  file: TapeFile;
  tracks: Record<GameId, TapeTrack>;
  order: GameId[];
}



interface Saved {
  sourceKey: string;
  order: GameId[];
  tracks: Record<GameId, Packed[]>;
}

function load(): Pick<TapeState, 'sourceKey' | 'tracks' | 'order'> {
  const empty = { sourceKey: '', tracks: {}, order: [] };
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return empty;
    const saved = JSON.parse(raw) as Saved;
    if (!saved || typeof saved.sourceKey !== 'string' || !Array.isArray(saved.order)) return empty;
    const tracks: Record<GameId, TapeTrack> = {};
    for (const id of saved.order) {
      const packed = saved.tracks[id];
      if (Array.isArray(packed)) tracks[id] = { gameId: id, samples: packed.map(unpack) };
    }
    return { sourceKey: saved.sourceKey, tracks, order: saved.order.filter((id) => tracks[id]) };
  } catch {
    // A quota error, private browsing or a half-written value: start the day again rather than fail.
    return empty;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedAt = 0;
/** Settle time after the last write, and the longest the tape may go unsaved. */
const SAVE_AFTER_MS = 4_000;
const SAVE_AT_LEAST_EVERY_MS = 20_000;

function save() {
  // A plain debounce never fires here. Thirteen games write often enough that
  // the timer was reset before it could run, and in a replay at thirty times
  // speed it is reset several times a second: the tape was never written at
  // all. So it settles after a quiet moment OR after this long regardless.
  const now = Date.now();
  const overdue = now - lastSavedAt >= SAVE_AT_LEAST_EVERY_MS;
  if (saveTimer && !overdue) clearTimeout(saveTimer);
  else if (saveTimer && overdue) return; // one is already due to fire
  saveTimer = setTimeout(() => {
    saveTimer = null;
    lastSavedAt = Date.now();
    try {
      // Read at the moment of writing rather than closing over a snapshot: a
      // timer scheduled earlier would otherwise persist a tape that has since
      // moved on.
      const state = useTape.getState();
      const tracks: Record<GameId, Packed[]> = {};
      for (const id of state.order) {
        const track = state.tracks[id];
        if (track) tracks[id] = track.samples.map(pack);
      }
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ sourceKey: state.sourceKey, order: state.order, tracks } satisfies Saved));
    } catch {
      // Out of quota: drop the record rather than break the page. The tape
      // keeps going in memory and simply will not survive a reload.
      try {
        sessionStorage.removeItem(STORE_KEY);
      } catch {
        /* nothing more to try */
      }
    }
  }, overdue ? 0 : SAVE_AFTER_MS);
}

export const useTape = create<TapeState>()((set, get) => ({
  ...load(),

  write: (gameId, sample) => {
    const state = get();
    const existing = state.tracks[gameId] ?? { gameId, samples: [] };
    const next = record(existing, sample);
    if (next === existing) return;

    let order = state.order;
    let tracks = state.tracks;
    if (!tracks[gameId]) {
      order = [...order, gameId];
      if (order.length > MAX_TRACKS) {
        const dropped = order.slice(0, order.length - MAX_TRACKS);
        order = order.slice(order.length - MAX_TRACKS);
        tracks = { ...tracks };
        for (const id of dropped) delete tracks[id];
      }
    }
    set({ order, tracks: { ...tracks, [gameId]: next } });
    save();
  },

  restart: (sourceKey) => {
    if (get().sourceKey === sourceKey) return;
    set({ sourceKey, tracks: {}, order: [] });
    save();
  },

  imported: null,
  openImported: (tape) => set({ imported: tape }),
  closeImported: () => set({ imported: null }),
}));

/** Every track in the order it was first seen. A stable array so selectors can memoise on it. */
export function tapeTracks(state: TapeState): TapeTrack[] {
  return state.order.map((id) => state.tracks[id]).filter(Boolean);
}

export { MAX_SAMPLES };
