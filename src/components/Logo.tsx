import { useId } from 'react';

/** Gridiron's mark: a forest tile, mint field lines and a football. */
export function LogoMark({ size = 28 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c5a42" />
          <stop offset="1" stopColor="#13241b" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-tile)`} />
      <rect x="5.5" y="8.5" width="21" height="15" rx="2.2" fill="none" stroke="#a7f3d0" strokeWidth="1.3" opacity="0.92" />
      <path d="M9.7 8.5v15M13.9 8.5v15M18.1 8.5v15M22.3 8.5v15" stroke="#a7f3d0" strokeWidth="0.8" opacity="0.42" />
      <ellipse cx="16" cy="16" rx="4.7" ry="2.9" fill="#6ee7b7" />
      <path d="M13.8 16h4.4M15 15.1v1.8M16 15.1v1.8M17 15.1v1.8" stroke="#13241b" strokeWidth="0.7" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <LogoMark />
      <span className="wordmark-text">Gridiron</span>
    </span>
  );
}
