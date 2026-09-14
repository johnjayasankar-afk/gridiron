/**
 * The only way Gridiron talks to a provider over HTTP.
 *
 * - Identical in-flight requests are shared (deduplicated).
 * - Concurrency is bounded, and a rolling per-minute request budget is enforced.
 * - Every attempt has a timeout.
 * - 429 honours Retry-After; 429 and 5xx back off exponentially with jitter,
 *   and the back-off applies to the whole host so a struggling provider is not
 *   hammered by other queued requests.
 * - Queued requests that have not started can be cancelled when they become obsolete.
 */

export interface FetchPolicy {
  timeoutMs: number;
  maxConcurrent: number;
  /** Maximum requests started in any rolling 60-second window. */
  budgetPerMinute: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  timeoutMs: 9_000,
  maxConcurrent: 6,
  budgetPerMinute: 150,
  maxRetries: 2,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

export type FetchOutcome<T> =
  | { ok: true; data: T; status: number; receivedAt: number; bytes: number }
  | { ok: false; error: string; status: number | null; receivedAt: number; retryable: boolean };

export interface FetcherStats {
  started: number;
  deduplicated: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
  retried: number;
  cancelled: number;
  active: number;
  queued: number;
  lastMinute: number;
  backoffUntil: number;
}

interface Waiter {
  key: string;
  resolve: () => void;
  reject: (e: Error) => void;
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

export class ProviderFetcher {
  private inflight = new Map<string, Promise<FetchOutcome<unknown>>>();
  private active = 0;
  private waiters: Waiter[] = [];
  private starts: number[] = [];
  private backoffUntil = 0;
  private consecutiveThrottles = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly counters = { started: 0, deduplicated: 0, succeeded: 0, failed: 0, rateLimited: 0, retried: 0, cancelled: 0 };

  constructor(
    private readonly policy: FetchPolicy = DEFAULT_FETCH_POLICY,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /** GET a JSON document. Concurrent calls for the same URL share one request. */
  getJson<T>(url: string): Promise<FetchOutcome<T>> {
    const existing = this.inflight.get(url);
    if (existing) {
      this.counters.deduplicated++;
      return existing as Promise<FetchOutcome<T>>;
    }
    const run = this.run<T>(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, run as Promise<FetchOutcome<unknown>>);
    return run;
  }

  /** Cancel requests that are queued but not yet started. Returns how many were dropped. */
  cancelQueued(predicate: (url: string) => boolean): number {
    const keep: Waiter[] = [];
    let dropped = 0;
    for (const w of this.waiters) {
      if (predicate(w.key)) {
        dropped++;
        w.reject(new CancelledError());
      } else keep.push(w);
    }
    this.waiters = keep;
    this.counters.cancelled += dropped;
    return dropped;
  }

  stats(): FetcherStats {
    this.prune();
    return {
      ...this.counters,
      active: this.active,
      queued: this.waiters.length,
      lastMinute: this.starts.length,
      backoffUntil: this.backoffUntil,
    };
  }

  private prune() {
    const cutoff = this.now() - 60_000;
    while (this.starts.length && this.starts[0] <= cutoff) this.starts.shift();
  }

  /** Wait for a concurrency slot, a budget slot and the end of any host back-off. */
  private acquire(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ key, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.prune();
    const now = this.now();
    while (this.waiters.length && this.active < this.policy.maxConcurrent) {
      if (now < this.backoffUntil) {
        this.timer = setTimeout(() => this.pump(), this.backoffUntil - now);
        return;
      }
      if (this.starts.length >= this.policy.budgetPerMinute) {
        const wait = this.starts[0] + 60_000 - now + 5;
        this.timer = setTimeout(() => this.pump(), Math.max(5, wait));
        return;
      }
      const w = this.waiters.shift()!;
      this.active++;
      this.starts.push(now);
      w.resolve();
    }
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  private backoffDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return Math.min(this.policy.maxBackoffMs, retryAfterMs);
    const exp = this.policy.baseBackoffMs * 2 ** attempt;
    const capped = Math.min(this.policy.maxBackoffMs, exp);
    return Math.round(capped * (0.75 + this.random() * 0.5));
  }

  private async run<T>(url: string): Promise<FetchOutcome<T>> {
    let attempt = 0;
    for (;;) {
      try {
        await this.acquire(url);
      } catch (e) {
        return { ok: false, error: e instanceof CancelledError ? 'cancelled' : String(e), status: null, receivedAt: this.now(), retryable: false };
      }
      this.counters.started++;
      let outcome: FetchOutcome<T> & { retryAfterMs?: number | null };
      try {
        outcome = await this.attempt<T>(url);
      } finally {
        this.release();
      }
      if (outcome.ok) {
        this.counters.succeeded++;
        this.consecutiveThrottles = 0;
        return outcome;
      }
      const throttled = outcome.status === 429;
      if (throttled) {
        this.counters.rateLimited++;
        this.consecutiveThrottles++;
      }
      if (throttled || (outcome.status !== null && outcome.status >= 500)) {
        // Back off the whole host, growing with repeated throttling.
        const delay = this.backoffDelay(Math.max(attempt, this.consecutiveThrottles - 1), outcome.retryAfterMs ?? null);
        this.backoffUntil = Math.max(this.backoffUntil, this.now() + delay);
      }
      if (!outcome.retryable || attempt >= this.policy.maxRetries) {
        this.counters.failed++;
        return { ok: false, error: outcome.error, status: outcome.status, receivedAt: outcome.receivedAt, retryable: outcome.retryable };
      }
      attempt++;
      this.counters.retried++;
      if (!throttled && !(outcome.status !== null && outcome.status >= 500)) {
        // timeouts and network errors: a short, jittered pause before retrying
        const delay = this.backoffDelay(attempt - 1, null);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async attempt<T>(url: string): Promise<FetchOutcome<T> & { retryAfterMs?: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.policy.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      const receivedAt = this.now();
      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
        return {
          ok: false,
          error: `HTTP ${res.status}`,
          status: res.status,
          receivedAt,
          retryable: res.status === 429 || res.status >= 500,
          retryAfterMs: seconds !== null ? seconds * 1000 : null,
        };
      }
      const text = await res.text();
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        return { ok: false, error: 'Response was not valid JSON', status: res.status, receivedAt, retryable: false };
      }
      return { ok: true, data, status: res.status, receivedAt, bytes: text.length };
    } catch (e) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        error: aborted ? `Timed out after ${this.policy.timeoutMs}ms` : `Network error: ${(e as Error).message}`,
        status: null,
        receivedAt: this.now(),
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
