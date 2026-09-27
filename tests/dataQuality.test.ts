import { describe, expect, it } from 'vitest';
import { EspnProvider } from '../server/providers/espn/provider';
import { newDiagnostics, normalizeScoreboardEvent } from '../server/providers/espn/normalize';
import { DEFAULT_FETCH_POLICY, ProviderFetcher } from '../server/fetcher';
import { fixture, fixtureFetch } from './helpers/fixtures';

const provider = () => new EspnProvider(new ProviderFetcher({ ...DEFAULT_FETCH_POLICY, maxRetries: 0 }, fixtureFetch()));

/**
 * The provider counts what it could not read. These counts are the only
 * warning that a feed has changed shape, so they have to leave the provider
 * and reach /api/health, and they have to count rather than round to a verdict.
 */
describe('data quality counters', () => {
  it('reports zero for a provider that has read nothing', () => {
    const quality = provider().dataQuality();
    expect(quality.invalidEvents).toBe(0);
    expect(quality.spotSignalConflicts).toBe(0);
    expect(quality.duplicatePlays).toBe(0);
  });

  it('counts an event it cannot read instead of dropping it silently', () => {
    const diag = newDiagnostics();
    expect(normalizeScoreboardEvent({ id: 'nope' } as never, 'nfl', ['NFL'], diag)).toBeNull();
    expect(diag.invalidEvents).toBe(1);
  });

  it('hands back a copy, so a reader cannot reset the provider by editing it', () => {
    const p = provider();
    const first = p.dataQuality();
    first.invalidEvents = 999;
    expect(p.dataQuality().invalidEvents).toBe(0);
  });

  it('still reads a real scoreboard without counting a problem', () => {
    const diag = newDiagnostics();
    const raw = fixture<{ events: unknown[] }>('scoreboard/nfl-20260913.json');
    const games = raw.events.map((e) => normalizeScoreboardEvent(e as never, 'nfl', ['NFL'], diag)).filter(Boolean);
    expect(games.length).toBeGreaterThan(0);
    expect(diag.invalidEvents).toBe(0);
  });
});
