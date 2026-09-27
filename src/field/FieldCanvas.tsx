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
import { noteFieldFrameDrawn, registerFieldFrameRequester } from './frameBus';
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
   * Put the canvas in the page, so the page carries it.
   *
   * Each field is scissored to its card's rectangle as of the frame it was
   * drawn in, so a drawn frame is only correct for one scroll position. While
   * the canvas was fixed to the viewport, every pixel it was showing belonged
   * further up the page the moment the page moved again, and it stayed wrong
   * until another frame landed. That is the field sitting still while the card
   * slides out from under it, and it cannot be fixed by drawing faster: this
   * display asks for 120 frames a second, a full slate mounts a dozen views,
   * and a WebGL frame per scrolled pixel is not on offer.
   *
   * Correcting it from a scroll listener does not work either, and that is
   * worth saying plainly because it was the previous attempt. The page scrolls
   * on the compositor; the scroll event arrives on this thread afterwards. A
   * correction computed from it is applied a frame late, every frame, which is
   * the lag it was meant to remove.
   *
   * So the canvas stops being fixed. Absolutely positioned with no positioned
   * ancestor, it sits in the initial containing block: a viewport-sized box at
   * the top of the document, which scrolls with the document like everything
   * else, on the compositor, at whatever rate the display runs. A field then
   * holds its card by construction, at any frame rate, including none.
   *
   * All a drawn frame has to do is put the box back over the viewport, which is
   * this: translate it down by the scroll position it is about to draw for.
   * Done before drei measures anything (priority below its own), so what it
   * computes its scissor rectangles against is where the canvas actually is.
   */
  const anchored = useRef<number | null>(null);
  useFrame(() => {
    /*
     * The element that moves has to be the element react-three-fiber measures,
     * or the two disagree and every scissor rectangle is off by the difference.
     * It measures the container it renders, not the canvas inside it, so the
     * container is what gets moved. Putting the transform on the canvas instead
     * left the container drifting to -scrollY while the canvas sat at zero, and
     * the fields were drawn a screenful down inside their own boxes.
     */
    const host = (canvas.closest('.field-canvas') as HTMLElement | null) ?? canvas;
    const y = Math.round(window.scrollY || 0);
    if (anchored.current === y) return;
    anchored.current = y;
    host.style.transform = y ? `translate3d(0, ${y}px, 0)` : '';
  }, -200);
  useEffect(() => {
    const host = (canvas.closest('.field-canvas') as HTMLElement | null) ?? canvas;
    return () => { host.style.transform = ''; };
  }, [canvas]);

  useEffect(() => {
    let trailing: ReturnType<typeof setTimeout>[] = [];
    const request = () => {
      invalidate();
      trailing.forEach(clearTimeout);
      trailing = [setTimeout(() => invalidate(), 60), setTimeout(() => invalidate(), 220)];
    };
    registerFieldFrameRequester(request);
    /*
     * Scrolling no longer asks for a frame.
     *
     * It used to have to. The canvas was fixed and every field was scissored to
     * a viewport rectangle, so a scrolled page made every drawn field wrong and
     * only a redraw could put it right. That is what made a scroll expensive:
     * a full redraw over every mounted view, per scroll event, on the one
     * thread that also has to lay the page out.
     *
     * Now the canvas travels with the page, so a card's position relative to it
     * does not change while scrolling, and the rectangles stay exactly as
     * correct as they were. The pixels are already right and already in the
     * right place. Redrawing them would produce the same image.
     *
     * A view that mounts mid-scroll still needs a frame, and asks for one
     * itself when it goes live. The request below is a backstop for anything
     * that does not, and it runs once the scroll stops rather than during it.
     */
    let settle: ReturnType<typeof setTimeout> | undefined;
    const afterScroll = () => {
      clearTimeout(settle);
      settle = setTimeout(request, 120);
    };
    window.addEventListener('scroll', afterScroll, { passive: true, capture: true });
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
     * Only mutations that carry a field count. The slate mutates constantly
     * with live data, and nearly all of it is a score or a clock changing
     * inside a card that has not moved: asking for a WebGL frame on each one
     * costs a full redraw over every mounted view and buys nothing. A card
     * changing places, on the other hand, arrives as that card's own node
     * being taken out and put back, so the moved node is the card and the
     * field is inside it. Checking for one is a query over a single card's
     * subtree, and it reads no geometry, so it cannot force a layout in the
     * middle of a scroll. Then coalesced to one request a frame.
     */
    let queued = false;
    const carriesField = (list: NodeList) => {
      for (const node of list) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('field-view') || node.querySelector('.field-view')) return true;
      }
      return false;
    };
    const moved = new MutationObserver((records) => {
      if (queued) return;
      for (const record of records) {
        if (!carriesField(record.addedNodes) && !carriesField(record.removedNodes)) continue;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          request();
        });
        return;
      }
    });
    moved.observe(document.body, { childList: true, subtree: true });

    /*
     * Layout can move a field without a scroll, a resize or a DOM change at
     * all. Measured against the canvas rather than the viewport: what decides
     * whether a drawn field is still right is where its card sits relative to
     * the canvas, and scrolling no longer changes that. Comparing viewport
     * rectangles instead would report a change on every scrolled pixel and ask
     * for a redraw that draws the same image.
     */
    let signature = '';
    const timer = setInterval(() => {
      if (document.hidden) return;
      const base = canvas.getBoundingClientRect();
      let next = '';
      document.querySelectorAll('.field-view').forEach((el) => {
        const r = el.getBoundingClientRect();
        next += `${(r.left - base.left) | 0},${(r.top - base.top) | 0},${r.width | 0},${r.height | 0};`;
      });
      if (next !== signature) {
        signature = next;
        request();
      }
    }, 250);
    return () => {
      clearTimeout(settle);
      window.removeEventListener('scroll', afterScroll, { capture: true });
      window.removeEventListener('resize', request);
      offTextures();
      offPrefs();
      clearInterval(timer);
      moved.disconnect();
      trailing.forEach(clearTimeout);
      registerFieldFrameRequester(null);
    };
  }, [invalidate, canvas]);
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
       * The canvas is sized by the initial containing block, which is the
       * viewport, so its size changes when the window's does and at no other
       * time. It does move with the page now, but its size does not, and
       * re-measuring it on scroll would only cost a forced layout per event.
       */
      flat
      dpr={dpr}
      /*
       * Never re-measure on scroll. The default re-measures 50ms after one,
       * which catches the container part way through travelling with the page
       * and caches that as where the canvas is. Every field is then scissored
       * against a position it is not in. Its size is what matters here, and its
       * size only changes when the window's does.
       */
      resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', stencil: false }}
      style={{ position: 'absolute', inset: 0, width: 'auto', height: 'auto', pointerEvents: 'none', zIndex: 5 }}
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
