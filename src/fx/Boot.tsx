/**
 * A brief power-on sequence for the first load in a browser session. It is
 * decorative, never blocks input (pointer events pass through), shows no
 * invented progress, and is skipped when motion is reduced.
 */
import { useEffect, useState } from 'react';
import { LogoMark } from '../components/Logo';
import { prefersReducedMotion } from '../lib/motion';

const KEY = 'gridiron.booted';

function firstLoadThisSession(): boolean {
  if (typeof window === 'undefined' || prefersReducedMotion()) return false;
  try {
    if (sessionStorage.getItem(KEY)) return false;
    sessionStorage.setItem(KEY, '1');
    return true;
  } catch {
    return false;
  }
}

// Decided once per page load, so React's development double render cannot skip it.
const BOOT = firstLoadThisSession();

export function Boot() {
  const [phase, setPhase] = useState<'on' | 'out' | 'done'>(BOOT ? 'on' : 'done');
  useEffect(() => {
    if (phase === 'done') return;
    const t = setTimeout(() => setPhase(phase === 'on' ? 'out' : 'done'), phase === 'on' ? 950 : 520);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase === 'done') return null;
  return (
    <div className={`boot${phase === 'out' ? ' is-out' : ''}`} aria-hidden="true">
      <div className="boot-grid" />
      <div className="boot-core">
        <span className="boot-mark">
          <LogoMark size={64} />
        </span>
        <span className="boot-word">Gridiron</span>
        <span className="boot-scan" />
      </div>
    </div>
  );
}
