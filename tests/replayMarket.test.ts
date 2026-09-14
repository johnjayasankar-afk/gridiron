/**
 * Kalshi prices captured for the NFL Week 1 replay (fixtures/kalshi/nfl-20260913.json, from
 * scripts/capture-kalshi.ts): attached to real replays by date and teams, cut at the replay
 * clock like the plays, and never given to synthetic scenarios.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplayLab } from '../server/replay/lab';
import { FixtureStore, SCENARIOS, withCapturedMarket } from '../server/replay/scenarios';
import { marketAt, marketHistoryAt, type GameTimeline } from '../server/replay/timeline';

const FIXTURES = fileURLToPath(new URL('../fixtures/espn', import.meta.url));
const MIN = 60_000;
const ARI_AT_LAC = 'nfl-401872926';

function captured(id: string): GameTimeline {
  const fx = new FixtureStore(FIXTURES);
  const built = SCENARIOS.find((s) => s.id === 'nfl-week1-sunday')?.build(fx);
  const tl = built?.games.find((g) => g.id === id);
  if (!tl) throw new Error(`${id} is not in the captured replay`);
  return withCapturedMarket(fx, tl);
}

describe('captured Kalshi prices in the replay lab', () => {
  let lab: ReplayLab | null = null;
  afterEach(() => {
    lab?.stopAll();
    lab = null;
  });

  it("attaches a real game's captured contracts, found by its date and both teams", () => {
    const tl = captured(ARI_AT_LAC);
    expect(tl.market?.event).toBe('KXNFLGAME-26SEP13ARILAC');
    expect(tl.market?.home?.ticker).toBe('KXNFLGAME-26SEP13ARILAC-LAC');
    expect(tl.market?.away?.ticker).toBe('KXNFLGAME-26SEP13ARILAC-ARI');
    expect(tl.market?.home?.candles.length).toBeGreaterThan(100);
  });

  it('shows each contract as of the replay clock, and nothing once the game is over', () => {
    const tl = captured(ARI_AT_LAC);
    expect(marketAt(tl, tl.kickoffAt - 3 * 60 * MIN)).toBeNull();
    const middle = Math.round((tl.kickoffAt + tl.endAt) / 2);
    const prices = marketAt(tl, middle);
    expect(prices).toMatchObject({ source: 'Kalshi', spread: null, total: null, stale: false });
    for (const quote of [prices?.moneyline?.home, prices?.moneyline?.away]) {
      expect(quote?.price).toBeGreaterThan(0);
      expect(quote?.price).toBeLessThan(1);
    }
    expect(Date.parse(prices?.changedAt ?? '')).toBeLessThanOrEqual(middle);
    expect(marketAt(tl, tl.endAt)).toBeNull();
  });

  it('cuts the price history at the replay clock, and at the end of the game', () => {
    const tl = captured(ARI_AT_LAC);
    const middle = Math.round((tl.kickoffAt + tl.endAt) / 2);
    const history = marketHistoryAt(tl, middle);
    expect(history).toMatchObject({ source: 'Kalshi', team: 'home', captured: true });
    expect(history?.points.length).toBeGreaterThan(10);
    expect(history?.points.every((p) => Date.parse(p.at) <= middle)).toBe(true);
    const later = marketHistoryAt(tl, tl.endAt + 60 * MIN);
    const last = later?.points[later.points.length - 1];
    expect(Date.parse(last?.at ?? '')).toBeLessThanOrEqual(tl.endAt);
  });

  it('gives real replays captured prices on their game details, and synthetic scenarios none', async () => {
    lab = new ReplayLab({ fixturesDir: FIXTURES, maxSessions: 4 });
    const real = lab.create('nfl-week1-sunday', { playing: false, progress: 0.55 });
    if ('error' in real) throw new Error(real.error);
    const detail = (await lab.engine(real.id)?.getDetail(ARI_AT_LAC))?.detail;
    expect(detail?.marketHistory?.captured).toBe(true);
    expect(detail?.summary.market?.source).toBe('Kalshi');

    const synthetic = lab.create('test-overturned-touchdown', { playing: false });
    if ('error' in synthetic) throw new Error(synthetic.error);
    const edited = (await lab.engine(synthetic.id)?.getDetail('nfl-401872925'))?.detail;
    expect(edited).toBeTruthy();
    expect(edited?.marketHistory ?? null).toBeNull();
    expect(edited?.summary.market ?? null).toBeNull();
  });
});
