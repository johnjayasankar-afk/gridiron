/**
 * Spoiler delay: everything the user sees comes from one presentation
 * timeline. Each state the client receives is stored with its local receipt
 * time; with a delay of D seconds the UI shows the newest state received at
 * least D seconds ago. Scores, fields, plays, alerts and Watch next all read the
 * same presented state, so nothing can leak ahead of the delay.
 *
 * This is a display delay, not synchronisation with any broadcast.
 */

export interface Presented<T> {
  value: T;
  receivedAt: number;
}

export type PresentationResult<T> =
  | { status: 'ready'; state: Presented<T>; delayMs: number }
  | { status: 'buffering'; delayMs: number; readyInMs: number }
  | { status: 'empty'; delayMs: number };

export class PresentationBuffer<T> {
  private entries: Presented<T>[] = [];

  constructor(private readonly retainMs = 6 * 60_000) {}

  push(value: T, receivedAt: number) {
    const last = this.entries[this.entries.length - 1];
    if (last && receivedAt < last.receivedAt) receivedAt = last.receivedAt; // receipt times never go backwards
    this.entries.push({ value, receivedAt });
    // Keep one entry older than the retention window so the oldest delayed view stays answerable.
    const cutoff = receivedAt - this.retainMs;
    let drop = 0;
    while (drop + 1 < this.entries.length && this.entries[drop + 1].receivedAt <= cutoff) drop++;
    if (drop) this.entries.splice(0, drop);
  }

  clear() {
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  latest(): Presented<T> | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /** The newest state received at or before `time`. */
  at(time: number): Presented<T> | null {
    let lo = 0;
    let hi = this.entries.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].receivedAt <= time) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 ? this.entries[found] : null;
  }

  present(now: number, delayMs: number): PresentationResult<T> {
    if (!this.entries.length) return { status: 'empty', delayMs };
    if (delayMs <= 0) return { status: 'ready', state: this.entries[this.entries.length - 1], delayMs: 0 };
    const state = this.at(now - delayMs);
    if (state) return { status: 'ready', state, delayMs };
    return { status: 'buffering', delayMs, readyInMs: Math.max(0, this.entries[0].receivedAt + delayMs - now) };
  }
}

export const DELAY_PRESETS = [0, 15, 30, 60] as const;
export const MAX_DELAY_SECONDS = 300;

export function clampDelaySeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.round(value)));
}
