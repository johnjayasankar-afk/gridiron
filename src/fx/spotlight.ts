/**
 * A soft light that follows the mouse across glass panels. One delegated
 * listener sets --mx and --my on the panel under the pointer, at most once a
 * frame; CSS draws the light. Nothing re-renders, and touch input is ignored.
 */
const SELECTOR = '.card, .panel, .quiet-block, .watch-item, .digest-item, .glass';

export function installSpotlight(): () => void {
  let frame = 0;
  let target: HTMLElement | null = null;
  let x = 0;
  let y = 0;

  const paint = () => {
    frame = 0;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${Math.round(x - rect.left)}px`);
    target.style.setProperty('--my', `${Math.round(y - rect.top)}px`);
  };

  const clear = (el: HTMLElement | null) => {
    el?.style.removeProperty('--mx');
    el?.style.removeProperty('--my');
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    const el = (event.target as Element | null)?.closest<HTMLElement>(SELECTOR) ?? null;
    if (el !== target) {
      clear(target);
      target = el;
    }
    x = event.clientX;
    y = event.clientY;
    if (target && !frame) frame = requestAnimationFrame(paint);
  };

  const onLeave = () => {
    clear(target);
    target = null;
  };

  document.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('pointermove', onMove);
    document.documentElement.removeEventListener('pointerleave', onLeave);
    clear(target);
  };
}
