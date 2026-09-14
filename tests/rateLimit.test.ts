import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../server/rateLimit';

describe('RateLimiter', () => {
  it('allows up to the limit in a window, then says how long to wait', () => {
    let t = 1_000;
    const limiter = new RateLimiter(2, 10_000, () => t);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(10);
    t += 4_500;
    expect(limiter.take('a')).toBe(6);
    expect(limiter.take('b')).toBe(0);
    t += 5_500;
    expect(limiter.take('a')).toBe(0);
  });

  it('starts a fresh window when the clock steps backwards', () => {
    let t = 50_000;
    const limiter = new RateLimiter(1, 10_000, () => t);
    expect(limiter.take('a')).toBe(0);
    t = 10_000;
    expect(limiter.take('a')).toBe(0);
  });

  it('keeps memory bounded under many distinct keys', () => {
    let t = 0;
    const limiter = new RateLimiter(1, 60_000, () => t, 100);
    for (let i = 0; i < 1_000; i++) {
      t += 1;
      limiter.take(`k${i}`);
    }
    expect(limiter.size).toBeLessThanOrEqual(100);
    expect(limiter.take('k999')).toBeGreaterThan(0);
  });
});
