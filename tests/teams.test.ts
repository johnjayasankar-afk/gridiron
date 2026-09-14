import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchOutcome } from '../server/fetcher';
import { TeamService } from '../server/teams';
import type { LeagueId } from '../shared/model';

const SAVED = resolve(process.cwd(), 'fixtures/espn/team');

/** A provider stand-in that answers team URLs from the saved documents, or fails every request. */
function provider(mode: 'saved' | 'down') {
  const calls: string[] = [];
  return {
    calls,
    async getJson<T>(url: string): Promise<FetchOutcome<T>> {
      calls.push(url);
      if (mode === 'down') return { ok: false, error: 'HTTP 503', status: 503, receivedAt: 0, retryable: true };
      const parsed = new URL(url);
      const league = parsed.pathname.includes('/nfl/') ? 'nfl' : 'cfb';
      const id = /\/teams\/(\d+)/.exec(parsed.pathname)?.[1];
      const season = parsed.searchParams.get('season') ?? '2026';
      const type = parsed.searchParams.get('seasontype') ?? '2';
      const name = parsed.pathname.endsWith('/schedule') ? `${league}-team-${id}-schedule-${season}${type === '2' ? '' : `-st${type}`}.json` : `${league}-team-${id}.json`;
      try {
        return { ok: true, data: JSON.parse(readFileSync(join(SAVED, name), 'utf8')) as T, status: 200, receivedAt: 0, bytes: 0 };
      } catch {
        return { ok: false, error: 'HTTP 404', status: 404, receivedAt: 0, retryable: false };
      }
    },
  };
}

describe('TeamService', () => {
  it('builds a replay page from saved documents without the network', async () => {
    const fetcher = provider('down');
    const service = new TeamService({ fetcher, savedDir: SAVED });
    const result = await service.get('nfl', '2', { season: 2026, saved: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('saved');
    expect(result.page.team.abbreviation).toBe('BUF');
    expect(result.page.schedule.length).toBe(17);
    expect(fetcher.calls).toHaveLength(0);
  });

  it('refuses ids that are not provider team ids', async () => {
    const service = new TeamService({ fetcher: provider('down') });
    expect(await service.get('nfl', 'abc')).toMatchObject({ ok: false, status: 400 });
    expect(await service.get('xfl' as LeagueId, '2')).toMatchObject({ ok: false, status: 400 });
  });

  it('fetches live pages once and shares them while they are fresh', async () => {
    let now = 1_000_000;
    const fetcher = provider('saved');
    const service = new TeamService({ fetcher, now: () => now });
    const [a, b] = await Promise.all([service.get('nfl', '2'), service.get('nfl', '2')]);
    expect(a).toMatchObject({ ok: true, source: 'live' });
    expect(b).toBe(a);
    const firstCalls = fetcher.calls.length;
    expect(firstCalls).toBeGreaterThan(0);
    now += 60_000;
    await service.get('nfl', '2');
    expect(fetcher.calls.length).toBe(firstCalls);
    now += 10 * 60_000;
    await service.get('nfl', '2');
    expect(fetcher.calls.length).toBeGreaterThan(firstCalls);
  });

  it('reports a provider failure and retries it soon after', async () => {
    let now = 5_000_000;
    const fetcher = provider('down');
    const service = new TeamService({ fetcher, now: () => now });
    const failed = await service.get('cfb', '333');
    expect(failed).toMatchObject({ ok: false, status: 502 });
    const calls = fetcher.calls.length;
    await service.get('cfb', '333');
    expect(fetcher.calls.length).toBe(calls);
    now += 25_000;
    await service.get('cfb', '333');
    expect(fetcher.calls.length).toBeGreaterThan(calls);
  });

  it('goes to the network when the saved set for a season is incomplete', async () => {
    const fetcher = provider('down');
    const service = new TeamService({ fetcher, savedDir: SAVED });
    // Alabama's 2026 postseason schedule was not saved.
    expect(await service.get('cfb', '333', { season: 2026, saved: true })).toMatchObject({ ok: false, status: 502 });
    expect(fetcher.calls.length).toBeGreaterThan(0);
  });
});
