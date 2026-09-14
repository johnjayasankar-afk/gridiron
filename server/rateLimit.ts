/**
 * A fixed-window request counter per key, for small abuse limits on write
 * endpoints. Memory stays bounded: expired windows are pruned, and under a
 * flood of distinct keys the oldest windows are forgotten first.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one request for `key`. Returns 0 when it is allowed, or the whole seconds to wait. */
  take(key: string): number {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs || t < w.start) {
      if (w) this.windows.delete(key);
      else if (this.windows.size >= this.maxKeys) this.prune(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    w.count++;
    return 0;
  }

  get size() {
    return this.windows.size;
  }

  private prune(t: number) {
    for (const [key, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(key);
    // Insertion order is oldest first.
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys * 0.9) break;
      this.windows.delete(key);
    }
  }
}
