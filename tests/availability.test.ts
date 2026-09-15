import { describe, expect, it } from 'vitest';
import { anyFeedUnknown, feedUnknown, leagueNames, unknownLeagues } from '../shared/availability';
import type { Freshness } from '../shared/model';

const feed = (over: Partial<Freshness>): Freshness => ({
  lastAttemptAt: '2026-09-15T00:10:00.000Z',
  lastSuccessAt: null,
  lastChangeAt: null,
  health: 'connected',
  error: null,
  consecutiveFailures: 0,
  ...over,
});

describe('whether a league’s games are known', () => {
  it('treats a feed that never answered as unknown, and one that answered before as known', () => {
    expect(feedUnknown(feed({ health: 'unavailable', error: 'NFL scoreboard: HTTP 403', consecutiveFailures: 2 }))).toBe(true);
    expect(feedUnknown(feed({ health: 'unavailable', lastSuccessAt: '2026-09-14T23:00:00.000Z', error: 'NFL scoreboard: HTTP 403' }))).toBe(false);
    expect(feedUnknown(feed({ health: 'stale', lastSuccessAt: '2026-09-14T23:00:00.000Z' }))).toBe(false);
    expect(feedUnknown(feed({ health: 'reconnecting' }))).toBe(false);
    expect(feedUnknown(feed({ health: 'connected', lastSuccessAt: '2026-09-15T00:10:00.000Z' }))).toBe(false);
    expect(feedUnknown(null)).toBe(false);
  });

  it('names only the leagues in view whose games are unknown', () => {
    const freshness = { nfl: feed({ health: 'unavailable', error: 'NFL scoreboard: HTTP 403' }), cfb: feed({ lastSuccessAt: '2026-09-15T00:10:00.000Z' }) };
    expect(unknownLeagues(freshness, ['nfl', 'cfb'])).toEqual(['nfl']);
    expect(unknownLeagues(freshness, ['cfb'])).toEqual([]);
    expect(anyFeedUnknown(freshness)).toBe(true);
    expect(anyFeedUnknown({ cfb: freshness.cfb })).toBe(false);
    expect(anyFeedUnknown(undefined)).toBe(false);
  });

  it('writes league names for a sentence', () => {
    expect(leagueNames(['nfl'])).toBe('NFL');
    expect(leagueNames(['cfb'])).toBe('college');
    expect(leagueNames(['cfb'], true)).toBe('College');
    expect(leagueNames(['nfl', 'cfb'], true)).toBe('NFL and college');
  });
});
