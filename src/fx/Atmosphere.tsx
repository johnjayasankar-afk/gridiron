import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../lib/motion';
import { usePrefs } from '../state/prefs';
import { Atmosphere } from './atmosphereRenderer';

/**
 * The WebGL night-stadium background behind the whole interface (see atmosphereRenderer.ts).
 * 2D mode uses no WebGL at all, so there the page keeps its static CSS background.
 */
export function AtmosphereCanvas() {
  const effects = usePrefs((s) => s.effects);
  const reduced = useReducedMotion();
  if (effects === 'flat') return null;
  return <AtmosphereLayer animate={effects === 'full' && !reduced} />;
}

function AtmosphereLayer({ animate }: { animate: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const instance = useRef<Atmosphere | null>(null);
  const animateRef = useRef(animate);
  animateRef.current = animate;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const created = Atmosphere.create(el, animateRef.current);
    if (!created) {
      el.style.display = 'none';
      return;
    }
    instance.current = created;
    return () => {
      created.dispose();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    instance.current?.setAnimate(animate);
  }, [animate]);

  return <canvas ref={canvas} className="atmosphere" aria-hidden="true" />;
}
