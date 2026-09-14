import { useState, type CSSProperties } from 'react';
import type { Team } from '../../shared/model';
import { useIsDark } from '../lib/theme';

/**
 * A provider logo at a fixed square size so layout never shifts. Dark mode uses
 * the provider's dark variant when it supplies one, and otherwise sits the logo
 * on a light chip. A failed or missing logo becomes a designed abbreviation tile.
 */
export function TeamLogo({ team, size = 28, className = '' }: { team: Team; size?: number; className?: string }) {
  const dark = useIsDark();
  const [failed, setFailed] = useState<string | null>(null);
  const src = dark ? (team.logoDark ?? team.logo) : team.logo;
  const style = { width: size, height: size, '--team': team.color ?? 'var(--forest)' } as CSSProperties;

  if (!src || failed === src) {
    const letters = team.abbreviation.length > 3 ? team.abbreviation.slice(0, 3) : team.abbreviation;
    return (
      <span className={`logo-fallback ${className}`} style={{ ...style, fontSize: Math.max(8, Math.round(size * 0.34)) }} aria-hidden="true">
        {letters}
      </span>
    );
  }
  return (
    <span className={`logo-frame ${dark && !team.logoDark ? 'on-chip' : ''} ${className}`} style={style} aria-hidden="true">
      <img src={src} width={size} height={size} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />
    </span>
  );
}
