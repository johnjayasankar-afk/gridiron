/**
 * A provider logo asked for at roughly the size it will be drawn.
 *
 * Every team logo the provider hands out is 500 by 500 whatever it is for, and
 * the marks on a card are twenty-two pixels across. A slate of thirteen games
 * pulled about a megabyte of them, with single logos as large as 131 kB, to draw
 * them at a fortieth of the area.
 *
 * The same CDN resizes on request through its combiner endpoint, which was
 * checked before anything was built on it: it returns the exact pixel size
 * asked for, it keeps the dark variant distinct from the light one where the
 * provider has two, it serves `access-control-allow-origin: *` so the ball can
 * still draw a logo into its own texture, and it answers for college teams as
 * well as professional ones. Measured across five teams it returns 85 to 98 per
 * cent less than the original.
 *
 * Anything that is not one of the provider's team logos is returned exactly as
 * it came. This rewrites an address the provider publishes; it never invents one.
 */

/**
 * Sizes to ask for, so a handful of addresses cover every drawn size and each
 * one caches. It stops at 256 because the source is 500 across: asking the
 * combiner for 512 makes it scale a 500 up and re-encode it, and that came back
 * at 164 kB against the original's 94. At 256 and below it was smaller than the
 * original for every team measured, including the smallest one.
 */
const BUCKETS = [32, 64, 128, 256];

/** The provider's own logo path, which is the only thing this will rewrite. */
const TEAM_LOGO = /^https?:\/\/a\.espncdn\.com\/(i\/teamlogos\/[^?#]+)/;

/** Past this the original is the smaller file, so the original is what is asked for. */
const LARGEST = BUCKETS[BUCKETS.length - 1];

export function logoAt(url: string | null | undefined, px: number): string | null {
  if (!url) return null;
  const match = TEAM_LOGO.exec(url);
  if (!match) return url;
  const wanted = Math.max(1, Math.ceil(px));
  // Above the largest bucket the provider's own file is the smaller one.
  if (wanted > LARGEST) return url;
  const size = BUCKETS.find((b) => b >= wanted) ?? LARGEST;
  return `https://a.espncdn.com/combiner/i?img=/${match[1]}&w=${size}&h=${size}`;
}

/**
 * How many pixels a mark of `cssPx` needs on this screen. Capped at two, because
 * a logo at three times its drawn size is bytes nobody can see.
 */
export function logoPixels(cssPx: number, dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1): number {
  return cssPx * Math.min(2, Math.max(1, dpr));
}
