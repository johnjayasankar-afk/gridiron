/** Small, dependency-free colour helpers for team tints on the field. */

export function parseHex(hex: string | null | undefined): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = (rgb: [number, number, number]) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** Mix two colours; `t` is the weight of `b`. Invalid input falls back to the other colour. */
export function mixColor(a: string | null, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca) return cb ? toHex(cb) : '#1c3326';
  if (!cb) return toHex(ca);
  return toHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

export function luminance(hex: string | null): number {
  const c = parseHex(hex);
  if (!c) return 0;
  const lin = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * A team colour that stays legible as an end-zone fill on dark forest turf:
 * very light colours are deepened and very dark ones lifted slightly.
 */
export function endZoneTint(teamColor: string | null): string {
  const base = parseHex(teamColor) ? teamColor! : '#2c5a42';
  const l = luminance(base);
  if (l > 0.45) return mixColor(base, '#13241b', 0.45);
  if (l < 0.02) return mixColor(base, '#3a5a48', 0.35);
  return mixColor(base, '#13241b', 0.18);
}

/** A colour as rgba() with the given alpha; invalid input falls back to Gridiron mint. */
export function withAlpha(hex: string | null, alpha: number): string {
  const c = parseHex(hex) ?? [110, 231, 183];
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

/** A colour for small team accents in the interface (score bars, possession dots). */
export function accentFor(teamColor: string | null, dark: boolean): string {
  const base = parseHex(teamColor) ? teamColor! : dark ? '#6ee7b7' : '#1f6b4a';
  const l = luminance(base);
  if (dark && l < 0.06) return mixColor(base, '#f0f7f3', 0.45);
  if (!dark && l > 0.6) return mixColor(base, '#0f1712', 0.45);
  return base;
}
