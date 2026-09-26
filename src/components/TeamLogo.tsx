import { useState, type CSSProperties } from 'react';
import type { Team } from '../../shared/model';
import { logoAt, logoPixels } from '../../shared/logo';
import { useIsDark } from '../lib/theme';

/**
 * A provider logo at a fixed square size so layout never shifts. Dark mode uses
 * the provider's dark variant when it supplies one. A failed or missing logo
 * becomes a designed abbreviation tile.
 *
 * A logo is never sat on a light disc. The provider hands out the same team with
 * and without its dark variant depending on which report it came from, so the
 * disc used to appear and disappear every few seconds as reports arrived; the
 * summaries keep a team's branding now, and a mark on the card is just the mark.
 */
export function TeamLogo({ team, size = 28, className = '' }: { team: Team; size?: number; className?: string }) {
  const dark = useIsDark();
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  // At the size it is actually drawn, rather than the 500 by 500 the provider serves for everything.
  const src = logoAt(dark ? (team.logoDark ?? team.logo) : team.logo, logoPixels(size));
  const style = { width: size, height: size, '--team': team.color ?? 'var(--forest)' } as CSSProperties;
  const letters = team.abbreviation.length > 3 ? team.abbreviation.slice(0, 3) : team.abbreviation;
  const fontSize = Math.max(8, Math.round(size * 0.34));

  if (!src || failed === src) {
    return (
      <span className={`logo-fallback ${className}`} style={{ ...style, fontSize }} aria-hidden="true">
        {letters}
      </span>
    );
  }
  return (
    <span className={`logo-frame ${className}`} style={style} aria-hidden="true">
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        /*
         * A cached image is already complete by the time React attaches the
         * handler, and then onLoad never fires. Without this check the tile
         * would sit there forever on a second visit, which is the one case
         * where the logo was never late to begin with.
         */
        ref={(el) => {
          if (el?.complete && el.naturalWidth > 0 && ready !== src) setReady(src);
        }}
        onLoad={() => setReady(src)}
        onError={() => setFailed(src)}
      />
      {ready !== src && (
        <span className="logo-waiting" style={{ fontSize }}>
          {letters}
        </span>
      )}
    </span>
  );
}
