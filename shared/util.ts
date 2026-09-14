/** Small, dependency-free helpers shared by the server and the client. */

/** FNV-1a, 32-bit, base36. Used to fingerprint provider content, not for security. */
export function fingerprint(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** "12:34" → 754. Anything else is unknown. */
export function clockToSeconds(clock: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec((clock ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Compact period label: "Q1".."Q4", "OT", "2OT". Overtime numbering follows the provider's period count. */
export function periodShort(period: number | null, regulationPeriods = 4): string | null {
  if (period === null || !Number.isFinite(period) || period < 1) return null;
  if (period <= regulationPeriods) return `Q${period}`;
  const ot = period - regulationPeriods;
  return ot === 1 ? 'OT' : `${ot}OT`;
}

export function periodLong(period: number | null, regulationPeriods = 4): string | null {
  if (period === null || !Number.isFinite(period) || period < 1) return null;
  if (period <= regulationPeriods) return `${ordinal(period)} quarter`;
  const ot = period - regulationPeriods;
  return ot === 1 ? 'overtime' : `${ordinal(ot)} overtime`;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** YYYYMMDD for a Date in US Eastern time, which is how the provider buckets game days. */
export function easternDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

export function shiftDateKey(key: string, days: number): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(4, 6));
  const d = Number(key.slice(6, 8));
  const t = new Date(Date.UTC(y, m - 1, d + days, 12));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}

export const isDateKey = (v: unknown): v is string => typeof v === 'string' && /^\d{8}$/.test(v);

export function dateKeyToLabel(key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
  const t = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)), 12));
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(t);
}

/** Deterministic, seedless jitter factor in [1 - spread, 1 + spread] for poll spacing. */
export function jitter(ms: number, spread = 0.15, rand: () => number = Math.random): number {
  return Math.round(ms * (1 - spread + rand() * spread * 2));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}
