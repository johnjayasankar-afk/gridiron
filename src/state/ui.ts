/** Transient interface state: dialogs, the palette, visibility, notices and historical inspection. */
import { create } from 'zustand';
import type { GameId } from '../../shared/model';

export type DialogName = 'alerts' | 'boards' | 'help' | 'shortcuts' | 'replay' | 'settings' | 'party' | null;

export interface Inspection {
  gameId: GameId;
  /** Play order being shown; null means live. */
  order: number | null;
  playing: boolean;
  /**
   * Playing the game's scoring plays one after another rather than every play.
   * Each one is drawn rather than jumped to, which is the difference between a
   * recap and a list.
   */
  reel: boolean;
  speed: 0.5 | 1 | 2 | 4;
  /** Restrict stepping and playback to one drive. */
  driveId: string | null;
  /** Inspectable plays known when inspection began, to count new arrivals without moving the view. */
  knownPlays: number;
}

export interface Notice {
  id: number;
  text: string;
  actionLabel?: string;
  action?: () => void;
}

interface UiState {
  dialog: DialogName;
  paletteOpen: boolean;
  drawerOpen: boolean;
  visible: GameId[];
  slateQuery: string;
  inspection: Inspection | null;
  notice: Notice | null;
  setDialog: (dialog: DialogName) => void;
  setPalette: (open: boolean) => void;
  setDrawer: (open: boolean) => void;
  setVisible: (ids: GameId[]) => void;
  setSlateQuery: (query: string) => void;
  setInspection: (inspection: Inspection | null) => void;
  patchInspection: (patch: Partial<Inspection>) => void;
  showNotice: (text: string, action?: { label: string; run: () => void }) => void;
  clearNotice: (id?: number) => void;
}

let noticeId = 0;

export const useUi = create<UiState>()((set, get) => ({
  dialog: null,
  paletteOpen: false,
  drawerOpen: false,
  visible: [],
  slateQuery: '',
  inspection: null,
  notice: null,
  setDialog: (dialog) => set({ dialog, paletteOpen: false }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  setVisible: (visible) => set({ visible }),
  setSlateQuery: (slateQuery) => set({ slateQuery }),
  setInspection: (inspection) => set({ inspection }),
  patchInspection: (patch) => {
    const cur = get().inspection;
    if (cur) set({ inspection: { ...cur, ...patch } });
  },
  showNotice: (text, action) => set({ notice: { id: ++noticeId, text, actionLabel: action?.label, action: action?.run } }),
  clearNotice: (id) => {
    if (id === undefined || get().notice?.id === id) set({ notice: null });
  },
}));

// ---------------------------------------------------------------- card visibility

const elementGame = new WeakMap<Element, GameId>();
const inView = new Set<Element>();
let observer: IntersectionObserver | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function publish() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const ids = [...new Set([...inView].map((el) => elementGame.get(el)).filter((x): x is GameId => !!x))].sort();
    if (ids.join('|') !== useUi.getState().visible.join('|')) useUi.getState().setVisible(ids);
  }, 350);
}

/** Track a game card so the server can prioritise play-by-play for what is on screen. */
export function observeCard(el: Element, gameId: GameId): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) inView.add(e.target);
        else inView.delete(e.target);
      }
      publish();
    },
    { rootMargin: '200px 0px' },
  );
  elementGame.set(el, gameId);
  observer.observe(el);
  return () => {
    observer?.unobserve(el);
    inView.delete(el);
    publish();
  };
}
