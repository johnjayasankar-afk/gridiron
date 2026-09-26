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
import { noteFieldFrameDrawn, onFieldFrameDrawn, registerFieldFrameRequester } from './frameBus';
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
  const canvas = useThree((s) => s.gl.domElement);

  /*
   * Hold the drawn fields on their cards between frames.
   *
   * The canvas is fixed to the viewport and each field is scissored to its
   * card's rectangle, so a frame is only correct for the scroll position it was
   * drawn at. The page keeps scrolling after that, on the compositor, whether
   * or not this thread manages another frame, and every pixel the canvas is
   * showing belongs further and further up the page. That is the field sitting
   * still while the card slides away from under it.
   *
   * Nothing can make a WebGL frame cheap enough to guarantee one per scrolled
   * pixel. But the drawn frame is still right, just in the wrong place, and
   * moving it is a transform: no layout, no paint, no redraw, and cheap enough
   * to keep up where a redraw cannot. So the canvas is offset by however far
   * the page has scrolled since the frame it is showing, which puts every field
   * back on its card, and the offset returns to zero the moment a new frame
   * lands.
   */
  useEffect(() => {
    let drawnAt = window.scrollY || 0;
    let offset = 0;
    const put = (value: number) => {
      if (value === offset) return;
      offset = value;
      canvas.style.transform = value ? `translate3d(0, ${value}px, 0)` : '';
    };
    const hold = () => put(drawnAt - (window.scrollY || 0));
    const settled = () => {
      drawnAt = window.scrollY || 0;
      put(0);
    };
    const offDrawn = onFieldFrameDrawn(settled);
    window.addEventListener('scroll', hold, { passive: true, capture: true });
    return () => {
      offDrawn();
      window.removeEventListener('scroll', hold, { capture: true });
      canvas.style.transform = '';
    };
  }, [canvas]);

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
    /*
     * A card can move without the page scrolling. The slate is ordered by what
     * is worth watching, and that ranking follows the game, so cards change
     * places while a reader sits still. React moves the card's node and the
     * browser paints it in its new place immediately; the field does not move
     * until the canvas draws again, because the canvas is fixed to the viewport
     * and each field is scissored to its card's rectangle. Until then the field
     * is sitting over whatever is now in the old place.
     *
     * The timer below used to be the only thing that noticed, so a field could
     * sit wrong for up to a quarter of a second and then jump. Measured on a
     * still page: 41 moves a minute, a field landing late by 35ms on average
     * and 87ms at worst. This watches the DOM instead and asks for a frame on
     * the same frame the move happened, and the timer stays as a backstop for
     * moves that never touch the DOM at all.
     *
     * Coalesced to one request a frame: the slate mutates constantly with live
     * data and most of those mutations are text inside a card, not a card
     * changing places.
     */
    let queued = false;
    const moved = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        request();
      });
    });
    moved.observe(document.body, { childList: true, subtree: true });

    // Layout can move a field without a scroll, a resize or a DOM change at all.
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
      moved.disconnect();
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
    noteFieldFrameDrawn();
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
      /*
       * This canvas is fixed to the viewport and never moves with the page, so
       * it has no use for the scroll listeners react-three-fiber attaches by
       * default, and nothing to debounce: its size changes when the window's
       * does and at no other time.
       */
      flat
      dpr={dpr}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', stencil: false }}
      style={{ position: 'fixed', inset: 0, width: 'auto', height: 'auto', pointerEvents: 'none', zIndex: 5 }}
      aria-hidden="true"
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        /*
         * Reading a shader's info log makes the CPU wait for the GPU to finish
         * compiling, and three.js does it for every program the first time it is
         * used. Profiled on the first drag through a game, where new materials
         * appear for the drive, the trail and the spot: `getProgramInfoLog` and
         * `getShaderInfoLog` were 34ms of it, and that stall is the hitch.
         *
         * Kept on in development, where a shader that fails to compile should
         * still say so. The field's own patches assert their anchors in
         * JavaScript before the shader is ever built, so nothing here depends on
         * the info log to know a patch landed.
         */
        gl.debug.checkShaderErrors = import.meta.env.DEV;
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
