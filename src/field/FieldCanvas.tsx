/**
 * The one WebGL canvas behind every field. It is fixed to the viewport and draws
 * each field view into that view's own rectangle (drei View, scissored).
 * Rendering is on demand: data changes, scrolling, layout shifts and running
 * animations request frames; nothing renders while the page is still.
 */
import { View } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { useFieldMode, useGraphics } from '../state/graphics';
import { usePrefs } from '../state/prefs';
import { registerFieldFrameRequester } from './frameBus';
import { onFieldTexturesChanged } from './textures';

export interface GraphicsInfo {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  views: number;
  dpr: number;
  /** Average CPU time to draw a frame over the last 24 frames, in milliseconds. */
  frameMs: number | null;
  frames: number;
}

let averageFrameMs: number | null = null;
let framesDrawn = 0;

declare global {
  interface Window {
    /** Diagnostics used by the verification suite: renderer counters and a context-loss trigger. */
    __gridironGraphics?: { loseContext: () => boolean; info: () => GraphicsInfo };
  }
}

/**
 * Requests frames when something that moves a field happens. A view that comes
 * back on screen clears its rectangle during React's commit, after the frame
 * that noticed it, so every request is followed by short trailing frames.
 */
function Invalidator() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let trailing: ReturnType<typeof setTimeout>[] = [];
    const request = () => {
      invalidate();
      trailing.forEach(clearTimeout);
      trailing = [setTimeout(() => invalidate(), 60), setTimeout(() => invalidate(), 220)];
    };
    registerFieldFrameRequester(request);
    window.addEventListener('scroll', request, { passive: true, capture: true });
    window.addEventListener('resize', request);
    const offTextures = onFieldTexturesChanged(request);
    const offPrefs = usePrefs.subscribe((s, p) => {
      if (s.theme !== p.theme || s.density !== p.density || s.railOpen !== p.railOpen) request();
    });
    // Layout can move a field without a scroll or resize event (sorting, a panel opening, a view mounting).
    let signature = '';
    const timer = setInterval(() => {
      if (document.hidden) return;
      let next = '';
      document.querySelectorAll('.field-view').forEach((el) => {
        const r = el.getBoundingClientRect();
        next += `${r.left | 0},${r.top | 0},${r.width | 0},${r.height | 0};`;
      });
      if (next !== signature) {
        signature = next;
        request();
      }
    }, 250);
    return () => {
      window.removeEventListener('scroll', request, { capture: true });
      window.removeEventListener('resize', request);
      offTextures();
      offPrefs();
      clearInterval(timer);
      trailing.forEach(clearTimeout);
      registerFieldFrameRequester(null);
    };
  }, [invalidate]);
  return null;
}

/** Resolution follows the effects setting, how many fields are mounted, and measured frame cost. */
function AdaptiveResolution() {
  const gl = useThree((s) => s.gl);
  const effects = usePrefs((s) => s.effects);
  const views = useGraphics((s) => s.views);
  const ceiling = useMemo(() => {
    const device = Math.min(2, window.devicePixelRatio || 1);
    const byEffects = effects === 'full' ? device : Math.min(device, 1.25);
    const byViews = views > 12 ? 1.25 : views > 6 ? 1.5 : 2;
    return Math.max(1, Math.min(byEffects, byViews));
  }, [effects, views]);
  const current = useRef(ceiling);
  const samples = useRef<number[]>([]);
  const started = useRef(0);

  useEffect(() => {
    gl.info.autoReset = false;
  }, [gl]);
  useEffect(() => {
    current.current = ceiling;
    useGraphics.getState().setDpr(ceiling);
  }, [ceiling]);

  useFrame(() => {
    started.current = performance.now();
    gl.info.reset();
  }, -100);
  useFrame(() => {
    const list = samples.current;
    list.push(performance.now() - started.current);
    framesDrawn++;
    if (list.length < 24) return;
    const average = list.reduce((a, b) => a + b, 0) / list.length;
    averageFrameMs = Math.round(average * 100) / 100;
    list.length = 0;
    let next = current.current;
    if (average > 22) next = Math.max(0.75, next - 0.25);
    else if (average < 6) next = Math.min(ceiling, next + 0.25);
    if (next !== current.current) {
      current.current = next;
      useGraphics.getState().setDpr(next);
    }
  }, 100);
  return null;
}

export function FieldCanvas() {
  const mode = useFieldMode();
  const canvasKey = useGraphics((s) => s.canvasKey);
  const dpr = useGraphics((s) => s.dpr);
  if (mode !== '3d') return null;
  return (
    <Canvas
      key={canvasKey}
      className="field-canvas"
      frameloop="demand"
      flat
      dpr={dpr}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', stencil: false }}
      style={{ position: 'fixed', inset: 0, width: 'auto', height: 'auto', pointerEvents: 'none', zIndex: 5 }}
      aria-hidden="true"
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        gl.domElement.addEventListener(
          'webglcontextlost',
          (event) => {
            event.preventDefault();
            useGraphics.getState().markLost();
          },
          { once: true },
        );
        window.__gridironGraphics = {
          loseContext: () => {
            const ext = gl.getContext().getExtension('WEBGL_lose_context');
            ext?.loseContext();
            return !!ext;
          },
          info: () => ({
            calls: gl.info.render.calls,
            triangles: gl.info.render.triangles,
            geometries: gl.info.memory.geometries,
            textures: gl.info.memory.textures,
            programs: gl.info.programs?.length ?? 0,
            views: useGraphics.getState().views,
            dpr: useGraphics.getState().dpr,
            frameMs: averageFrameMs,
            frames: framesDrawn,
          }),
        };
      }}
    >
      <View.Port />
      <Invalidator />
      <AdaptiveResolution />
    </Canvas>
  );
}
