/**
 * Defensive readers for untyped provider JSON. Each returns null (or an empty
 * array) for anything that is not exactly the expected shape, so a missing or
 * malformed field becomes "unknown" instead of an exception or a fake value.
 */

export const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

export const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Follow a path of keys and indexes through nested objects and arrays. */
export function at(v: unknown, ...path: Array<string | number>): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      const o = obj(cur);
      if (!o) return undefined;
      cur = o[key];
    }
  }
  return cur;
}

/** A six-digit hex colour from the provider, as "#rrggbb". */
export const hexColor = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
};

/** Only https URLs on hosts we expect provider media to come from. */
export const safeUrl = (v: unknown, hosts: RegExp = /(^|\.)espncdn\.com$|(^|\.)espn\.com$/): string | null => {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !hosts.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
};
