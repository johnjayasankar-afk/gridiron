import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../lib/motion';

/** A score that rolls when it changes (up for a score, down for a correction), and simply updates when motion is reduced. */
export function Score({ value, className = '' }: { value: number | null; className?: string }) {
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
  if (value === null) return null;
  return (
    <span className={`score ${className}${roll && !reduced ? ` roll-${roll}` : ''}`}>
      <span key={value} className="score-num">
        {value}
      </span>
    </span>
  );
}
