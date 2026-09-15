import { describe, expect, it } from 'vitest';
import { GridironEngine } from '../server/engine';
import { newDiagnostics, normalizeScoreboardEvent, normalizeSummary } from '../server/providers/espn/normalize';
import type { SlateResult, SportsProvider } from '../server/providers/types';
import type { GameDetail, GameSummary } from '../shared/model';
import { fixture } from './helpers/fixtures';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Denver at Kansas City as ESPN listed it before kickoff on 14 September 2026 (kickoff 00:15 UTC on the 15th). */
const denverAtKansasCity = (): GameSummary => normalizeScoreboardEvent(fixture<Raw>('odds/nfl-401872931-pregame-event.json'), 'nfl', ['NFL'])!;
/** The same game's summary, read at the same time. */
const denverAtKansasCityDetail = (): GameDetail => normalizeSummary(fixture<Raw>('odds/nfl-401872931-pregame-summary.json'), 'nfl', ['NFL'], newDiagnostics())!;

/** A provider whose answers a test controls: refusing, as ESPN refused the Vercel deployment on 14 September 2026, or answering. */
function scriptedProvider(clock: () => number) {
  const game = denverAtKansasCity();
  const calls = { nfl: 0, cfb: 0, detail: 0 };
  const state = { refusing: true };
  const provider: SportsProvider = {
    info: { id: 'fake', name: 'Fake', description: 'test', licensed: false, push: false, divisions: ['NFL'] },
    async fetchSlate(league, date): Promise<SlateResult> {
      calls[league]++;
      if (state.refusing) {
        const scope = league === 'nfl' ? 'NFL scoreboard' : 'College scoreboard';
        return { league, dateKey: date, games: [], divisions: [], errors: [{ scope, message: 'HTTP 403', status: 403 }], failed: true, receivedAt: clock(), discovery: '', limitations: [] };
      }
      return { league, dateKey: date, games: league === 'nfl' ? [game] : [], divisions: [], errors: [], failed: false, receivedAt: clock(), discovery: '', limitations: [] };
    },
    async fetchDetail() {
      calls.detail++;
      if (state.refusing) return { ok: false, error: { scope: 'detail', message: 'HTTP 403', status: 403 }, receivedAt: clock() };
      return { ok: true, detail: denverAtKansasCityDetail(), receivedAt: clock() };
    },
  };
  return { provider, calls, state, game };
}

describe('a serverless engine, which nothing polls between requests', () => {
  it('asks the provider again 30 seconds after a refusal, not on every request, and recovers', async () => {
    let clock = Date.parse('2026-09-14T16:00:00Z');
    const { provider, calls, state } = scriptedProvider(() => clock);
    const engine = new GridironEngine({ provider, mode: 'live', today: () => '20260914', now: () => clock });

    const refused = await engine.getSlate('20260914');
    expect(refused.freshness.nfl.health).toBe('unavailable');
    expect(calls.nfl).toBe(1);

    clock += 10_000;
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(1);

    state.refusing = false;
    clock += 25_000;
    const recovered = await engine.getSlate('20260914');
    expect(calls.nfl).toBe(2);
    expect(recovered.freshness.nfl.health).toBe('connected');
    expect(recovered.games).toHaveLength(1);
  });

  it('refreshes a healthy slate on its polling interval instead of keeping the first answer', async () => {
    let clock = Date.parse('2026-09-14T16:00:00Z');
    const { provider, calls, state } = scriptedProvider(() => clock);
    state.refusing = false;
    const engine = new GridironEngine({ provider, mode: 'live', today: () => '20260914', now: () => clock });
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(1);

    // hours before kickoff the day is idle, polled every five minutes
    clock += 60_000;
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(1);
    clock += 5 * 60_000;
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(2);

    // fifteen minutes before kickoff it is polled as live, every 25 seconds
    clock = Date.parse('2026-09-15T00:00:00Z');
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(3);
    clock += 26_000;
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(4);
  });

  it('counts a live slate as due a few seconds early, because viewers poll on the same 25 second cycle', async () => {
    let clock = Date.parse('2026-09-15T00:00:00Z');
    const { provider, calls, state } = scriptedProvider(() => clock);
    state.refusing = false;
    const engine = new GridironEngine({ provider, mode: 'live', today: () => '20260914', now: () => clock });
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(1);
    clock += 15_000;
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(1);
    // a viewer's next poll can reach the function a moment before 25 seconds have passed
    clock += 9_000;
    await engine.getSlate('20260914');
    expect(calls.nfl).toBe(2);
  });

  it('asks for a failing game at most every 10 seconds', async () => {
    let clock = Date.parse('2026-09-14T16:00:00Z');
    const { provider, calls, game } = scriptedProvider(() => clock);
    const engine = new GridironEngine({ provider, mode: 'live', today: () => '20260914', now: () => clock });
    await engine.getDetail(game.id);
    expect(calls.detail).toBe(1);
    clock += 5_000;
    await engine.getDetail(game.id);
    expect(calls.detail).toBe(1);
    clock += 6_000;
    await engine.getDetail(game.id);
    expect(calls.detail).toBe(2);
  });

  it('counts a healthy game as due a few seconds early, because a game in focus is asked for every 12 seconds', async () => {
    let clock = Date.parse('2026-09-15T00:00:00Z');
    const { provider, calls, state, game } = scriptedProvider(() => clock);
    state.refusing = false;
    const engine = new GridironEngine({ provider, mode: 'live', today: () => '20260914', now: () => clock });
    const first = await engine.getDetail(game.id);
    expect(first.detail).not.toBeNull();
    expect(calls.detail).toBe(1);
    clock += 6_000;
    await engine.getDetail(game.id);
    expect(calls.detail).toBe(1);
    // the next request for the game can arrive a moment before 12 seconds have passed
    clock += 5_500;
    const next = await engine.getDetail(game.id);
    expect(calls.detail).toBe(2);
    expect(next.freshness.health).toBe('connected');
  });
});
