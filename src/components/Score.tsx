import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../lib/motion';

/**
 * Which way a score just moved, or null when it has not moved. Null under
 * reduced motion, where the number simply changes.
 *
 * It is a hook rather than a part of `Score` because the scorebug on the field
 * draws its own numbers at its own size, and the two should move together:
 * scrubbing back through a game rolls both of them down, so points come off the
 * board in the same motion they went on.
 */
export function useScoreRoll(value: number | null): 'up' | 'down' | null {
  const reduced = useReducedMotion();
  const previous = useRef(value);
  const [roll, setRoll] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before === value || before === null || value === null) return;
    setRoll(value > before ? 'up' : 'down');
    const t = setTimeout(() => setRoll(null), 520);
    return () => clearTimeout(t);
  }, [value]);
  return reduced ? null : roll;
}

/** A score that rolls when it changes (up for a score, down for a correction), and simply updates when motion is reduced. */
export function Score({ value, className = '' }: { value: number | null; className?: string }) {
  const roll = useScoreRoll(value);
  if (value === null) return null;
  return (
    <span className={`score ${className}${roll ? ` roll-${roll}` : ''}`}>
      <span key={value} className="score-num">
        {value}
      </span>
    </span>
  );
}
