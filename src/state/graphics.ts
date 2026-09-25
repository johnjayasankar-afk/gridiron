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
  dpr: number;
  markLost: () => void;
  retry: () => void;
  registerView: () => () => void;
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
  dpr: 1,
  markLost: () => set({ status: 'lost', losses: get().losses + 1 }),
  retry: () => set({ status: detectWebGL() ? 'ok' : 'unsupported', canvasKey: get().canvasKey + 1 }),
  registerView: () => {
    set({ views: get().views + 1 });
    return () => set({ views: Math.max(0, get().views - 1) });
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
