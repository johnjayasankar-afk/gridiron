/** Relative and wall-clock time labels. None of these is a game clock; game clocks are shown only as reported. */

export function formatAgo(from: number | string | null | undefined, now: number): string {
  if (from === null || from === undefined) return 'never';
  const t = typeof from === 'string' ? Date.parse(from) : from;
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function kickoffShort(startTime: string | null, now = Date.now()): string {
  if (!startTime) return 'Time TBD';
  const d = new Date(startTime);
  if (Number.isNaN(d.getTime())) return 'Time TBD';
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(d);
}

export const clockTime = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

export const clockTimeSeconds = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(ms));

export function dateKeyToInput(key: string | null): string {
  return key ? `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}` : '';
}

export function inputToDateKey(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}
