/**
 * Graphics capability and health. One WebGL context draws every field; when it
 * is unavailable or lost, fields fall back to the 2D renderer and say why.
 */
import { create } from 'zustand';
import { usePrefs } from './prefs';

export type GraphicsStatus = 'ok' | 'unsupported' | 'lost';

interface GraphicsState {
  status: GraphicsStatus;
  losses: number;
  /** Changing the key remounts the shared canvas with a fresh context. */
  canvasKey: number;
  /** Mounted 3D views, used to size the resolution budget. */
  views: number;
  /**
   * Field slots on the page, counted whether they draw in 3D or 2D, so the
   * shared canvas is only built where there is something for it to draw. This is
   * not `views`: a view is registered from inside the canvas, which is too late
   * to decide whether to have one.
   */
  slots: number;
  dpr: number;
  markLost: () => void;
  retry: () => void;
  registerView: () => () => void;
  registerSlot: () => () => void;
  setDpr: (dpr: number) => void;
}

function detectWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export const useGraphics = create<GraphicsState>()((set, get) => ({
  status: detectWebGL() ? 'ok' : 'unsupported',
  losses: 0,
  canvasKey: 0,
  views: 0,
  slots: 0,
  dpr: 1,
  markLost: () => set({ status: 'lost', losses: get().losses + 1 }),
  retry: () => set({ status: detectWebGL() ? 'ok' : 'unsupported', canvasKey: get().canvasKey + 1 }),
  registerView: () => {
    set({ views: get().views + 1 });
    return () => set({ views: Math.max(0, get().views - 1) });
  },
  registerSlot: () => {
    set({ slots: get().slots + 1 });
    return () => set({ slots: Math.max(0, get().slots - 1) });
  },
  setDpr: (dpr) => set({ dpr }),
}));

/** '3d' when the shared canvas can draw; '2d' for the low-power setting, no WebGL, or a lost context. */
/** Whether fields draw in the shared WebGL canvas or as SVG. */
export type FieldMode = '3d' | '2d';

export function useFieldMode(): FieldMode {
  const effects = usePrefs((s) => s.effects);
  const status = useGraphics((s) => s.status);
  return effects !== 'flat' && status === 'ok' ? '3d' : '2d';
}

/**
 * Whether the page has anything for the shared canvas to draw. The tape has no
 * fields at all, and was still loading three.js and building a context for it:
 * 191kB and a WebGL context for a view drawn entirely in DOM and SVG.
 */
export function useWantsCanvas(): boolean {
  return useGraphics((s) => s.slots > 0);
}
