import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderFetcher, type FetchPolicy } from '../server/fetcher';

const policy = (over: Partial<FetchPolicy> = {}): FetchPolicy => ({
  timeoutMs: 1_000,
  maxConcurrent: 2,
  budgetPerMinute: 100,
  maxRetries: 2,
  baseBackoffMs: 100,
  maxBackoffMs: 5_000,
  ...over,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch whose responses are released by the test, so concurrency can be observed. */
function controllableFetch() {
  const pending: Array<{ url: string; resolve: (r: Response) => void }> = [];
  let active = 0;
  let peak = 0;
  const impl = vi.fn((input: RequestInfo | URL) => {
    active++;
    peak = Math.max(peak, active);
    return new Promise<Response>((resolve) => {
      pending.push({
        url: String(input),
        resolve: (r) => {
          active--;
          resolve(r);
        },
      });
    });
  });
  return { impl, pending, peak: () => peak };
}

describe('ProviderFetcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shares one request between identical concurrent callers', async () => {
    const f = controllableFetch();
    const fetcher = new ProviderFetcher(policy(), f.impl as unknown as typeof fetch);
    const a = fetcher.getJson('https://x.test/scoreboard');
    const b = fetcher.getJson('https://x.test/scoreboard');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.impl).toHaveBeenCalledTimes(1);
    f.pending[0].resolve(json({ events: [] }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(fetcher.stats().deduplicated).toBe(1);
  });

  it('never runs more than the concurrency limit at once', async () => {
    const f = controllableFetch();
    const fetcher = new ProviderFetcher(policy({ maxConcurrent: 2 }), f.impl as unknown as typeof fetch);
    const all = Array.from({ length: 6 }, (_, i) => fetcher.getJson(`https://x.test/game/${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.impl).toHaveBeenCalledTimes(2);
    for (let round = 0; round < 6; round++) {
      const next = f.pending.shift();
      next?.resolve(json({ ok: round }));
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all(all);
    expect(f.peak()).toBe(2);
    expect(f.impl).toHaveBeenCalledTimes(6);
  });

  it('holds requests beyond the per-minute budget until the window moves', async () => {
    const impl = vi.fn(async () => json({}));
    const fetcher = new ProviderFetcher(policy({ budgetPerMinute: 3, maxConcurrent: 10 }), impl as unknown as typeof fetch);
    const all = Array.from({ length: 5 }, (_, i) => fetcher.getJson(`https://x.test/${i}`));
    await vi.advanceTimersByTimeAsync(10);
    expect(impl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(all);
    expect(impl).toHaveBeenCalledTimes(5);
  });

  it('backs off on 429, honouring Retry-After, then succeeds', async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '3' }))
      .mockResolvedValueOnce(json({ events: [1] }));
    const fetcher = new ProviderFetcher(policy(), impl as unknown as typeof fetch);
    const p = fetcher.getJson<{ events: number[] }>('https://x.test/sb');
    await vi.advanceTimersByTimeAsync(2_900);
    expect(impl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    const r = await p;
    expect(impl).toHaveBeenCalledTimes(2);
    expect(r.ok && r.data.events).toEqual([1]);
    expect(fetcher.stats().rateLimited).toBe(1);
  });

  it('retries server errors a bounded number of times and then reports failure', async () => {
    const impl = vi.fn(async () => json({ error: true }, 503));
    const fetcher = new ProviderFetcher(policy({ maxRetries: 2 }), impl as unknown as typeof fetch, Date.now, () => 0.5);
    const p = fetcher.getJson('https://x.test/down');
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(503);
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a response that is not JSON', async () => {
    const impl = vi.fn(async () => new Response('<html>blocked</html>', { status: 200 }));
    const fetcher = new ProviderFetcher(policy(), impl as unknown as typeof fetch);
    const r = await fetcher.getJson('https://x.test/html');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.retryable).toBe(false);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('times out a hung request and retries it', async () => {
    let calls = 0;
    const impl = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve(json({ recovered: true }));
    });
    const fetcher = new ProviderFetcher(policy({ timeoutMs: 500 }), impl as unknown as typeof fetch, Date.now, () => 0.5);
    const p = fetcher.getJson<{ recovered: boolean }>('https://x.test/slow');
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await p;
    expect(r.ok && r.data.recovered).toBe(true);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('cancels queued requests that became obsolete without starting them', async () => {
    const f = controllableFetch();
    const fetcher = new ProviderFetcher(policy({ maxConcurrent: 1 }), f.impl as unknown as typeof fetch);
    const first = fetcher.getJson('https://x.test/keep');
    const obsolete = fetcher.getJson('https://x.test/game/old');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.cancelQueued((u) => u.includes('/game/old'))).toBe(1);
    f.pending[0].resolve(json({}));
    await first;
    const r = await obsolete;
    expect(r.ok).toBe(false);
    expect(f.impl).toHaveBeenCalledTimes(1);
  });
});
