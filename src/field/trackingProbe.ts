/**
 * Does a field stay on its card while the page scrolls?
 *
 * The canvas is fixed to the viewport and each field is scissored to its card's
 * rectangle, so a field is only in the right place in frames that were actually
 * drawn. Between two drawn frames the page keeps moving and the field does not,
 * and the gap between them is what a reader sees as the field sliding off the
 * card. This measures that gap, in pixels, in the browser it is happening in.
 *
 * It exists because the behaviour was reported on a machine where it could not
 * be reproduced: not at 1x, 2x, 4x or 6x throttle, not at one or two device
 * pixels, not at 1100 or 5000 pixels a second, not on the slate or the game
 * page. Four candidate fixes were built and measured and none of them moved a
 * number. Rather than guess again, this turns the report into data.
 *
 *   open the site with ?probe=tracking
 *   scroll the way that looks wrong
 *   read the line it prints, or copy window.__gridironTracking
 *
 * It is behind a query flag and installs nothing unless the flag is there, so
 * it costs a normal visit exactly nothing. See docs/PERFORMANCE.md.
 */

export interface TrackingReport {
  /** The worst gap between where a field was drawn and where its card was, in CSS pixels. */
  worstGapPx: number;
  /** The typical gap, which is what the scroll looks like rather than its worst moment. */
  medianGapPx: number;
  /** Frames the field canvas drew per 1000 pixels scrolled. At 60Hz and a normal scroll this is about 40. */
  framesPer1000px: number;
  /** What the display is running at, measured rather than assumed. */
  displayHz: number;
  /** The canvas should stay pinned to the top of the viewport. If this is not 0 it is scrolling with the page. */
  canvasTopPx: number;
  devicePixelRatio: number;
  fieldsMounted: number;
  scrolledPx: number;
  userAgent: string;
}

declare global {
  interface Window {
    __gridironTracking?: TrackingReport;
  }
}

const FLAG = 'tracking';
const STILL_AFTER_MS = 260;

function median(list: number[]): number {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Installs the probe when the address asks for it. Returns a teardown. */
export function installTrackingProbe(): () => void {
  let search = '';
  try {
    search = new URL(window.location.href).searchParams.get('probe') ?? '';
  } catch {
    return () => undefined;
  }
  if (search !== FLAG) return () => undefined;

  const drawn = () => window.__gridironGraphics?.info().frames ?? 0;
  const firstField = () => document.querySelector('.field-view');

  let raf = 0;
  let scrolling = false;
  let settle: ReturnType<typeof setTimeout> | null = null;
  let gaps: number[] = [];
  let ticks: number[] = [];
  let startFrames = 0;
  let startY = 0;
  let lastDrawFrames = 0;
  let slotAtLastDraw = 0;
  let lastTick = 0;

  const sample = (now: number) => {
    raf = requestAnimationFrame(sample);
    if (lastTick) ticks.push(now - lastTick);
    lastTick = now;
    const field = firstField();
    if (!field) return;
    const top = field.getBoundingClientRect().top;
    const frames = drawn();
    if (frames !== lastDrawFrames) {
      /* A frame landed: from here the field is where the card is. */
      lastDrawFrames = frames;
      slotAtLastDraw = top;
      return;
    }
    /* No frame since the last sample, so the field is still drawn where the
       card was then, and this is how far the card has moved out from under it. */
    gaps.push(Math.abs(top - slotAtLastDraw));
  };

  const report = () => {
    settle = null;
    scrolling = false;
    cancelAnimationFrame(raf);
    raf = 0;
    const host = document.querySelector('.field-canvas');
    const scrolled = Math.abs((window.scrollY || 0) - startY);
    const frames = drawn() - startFrames;
    const gapList = gaps;
    const tickList = ticks.filter((t) => t > 1 && t < 100);
    gaps = [];
    ticks = [];
    lastTick = 0;
    if (scrolled < 40) return;
    const out: TrackingReport = {
      worstGapPx: Math.round(Math.max(0, ...gapList)),
      medianGapPx: Math.round(median(gapList)),
      framesPer1000px: Math.round(frames / (scrolled / 1000)),
      displayHz: tickList.length ? Math.round(1000 / median(tickList)) : 0,
      canvasTopPx: host ? Math.round(host.getBoundingClientRect().top) : -1,
      devicePixelRatio: window.devicePixelRatio || 1,
      fieldsMounted: document.querySelectorAll('.field-view').length,
      scrolledPx: Math.round(scrolled),
      userAgent: navigator.userAgent,
    };
    window.__gridironTracking = out;
    const verdict = out.canvasTopPx !== 0
      ? 'the canvas is scrolling with the page, which it must never do'
      : out.worstGapPx > 40
        ? 'the fields are coming off their cards'
        : out.worstGapPx > 20
          ? 'the fields trail their cards by about a frame'
          : 'the fields are tracking';
    // eslint-disable-next-line no-console
    console.log(
      `Gridiron tracking: worst gap ${out.worstGapPx}px, typical ${out.medianGapPx}px, ` +
      `${out.framesPer1000px} frames per 1000px, display ${out.displayHz}Hz, ` +
      `canvas top ${out.canvasTopPx}px, dpr ${out.devicePixelRatio}, ` +
      `${out.fieldsMounted} fields. ${verdict}. Copy window.__gridironTracking.`,
    );
  };

  const onScroll = () => {
    if (!scrolling) {
      scrolling = true;
      gaps = [];
      ticks = [];
      lastTick = 0;
      startY = window.scrollY || 0;
      startFrames = drawn();
      lastDrawFrames = startFrames;
      const field = firstField();
      slotAtLastDraw = field ? field.getBoundingClientRect().top : 0;
      raf = requestAnimationFrame(sample);
    }
    if (settle) clearTimeout(settle);
    settle = setTimeout(report, STILL_AFTER_MS);
  };

  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  // eslint-disable-next-line no-console
  console.log('Gridiron tracking probe is on. Scroll the way that looks wrong.');
  return () => {
    window.removeEventListener('scroll', onScroll, { capture: true });
    if (settle) clearTimeout(settle);
    if (raf) cancelAnimationFrame(raf);
  };
}
