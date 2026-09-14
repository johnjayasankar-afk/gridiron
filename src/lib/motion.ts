import { useEffect, useRef, useState, type RefObject } from 'react';
import { usePrefs } from '../state/prefs';

const QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(QUERY).matches;
}

/** True when motion should be replaced by brief fades: the system setting, or Gridiron's Reduced or 2D effects. */
export function useReducedMotion(): boolean {
  const effects = usePrefs((s) => s.effects);
  const [system, setSystem] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return;
    const on = () => setSystem(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return system || effects !== 'full';
}

/** Whether an element is within `margin` of the viewport. Offscreen fields unmount their 3D scene. */
export function useNearViewport(ref: RefObject<Element | null>, margin = '300px'): boolean {
  const [near, setNear] = useState(false);
  const last = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const v = entries.some((e) => e.isIntersecting);
        if (v !== last.current) {
          last.current = v;
          setNear(v);
        }
      },
      { rootMargin: `${margin} 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return near;
}

/** A timestamp that advances every `intervalMs`, for relative "updated 12s ago" labels. Never a game clock. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
