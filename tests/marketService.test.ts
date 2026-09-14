import { describe, expect, it } from 'vitest';
import { GridironEngine, type EngineMessage } from '../server/engine';
import type { FetchOutcome } from '../server/fetcher';
import type { KalshiEvent, KalshiMarket } from '../server/markets/kalshi';
import { MarketService } from '../server/markets/service';
import { normalizeScoreboardEvent } from '../server/providers/espn/normalize';
import type { SlateResult, SportsProvider } from '../server/providers/types';
import type { GameDetail, GameSummary, MarketHistory, MarketPrices } from '../shared/model';
import { fixture } from './helpers/fixtures';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const START = Date.parse('2026-09-14T20:00:00Z');
const API = 'https://api.elections.kalshi.com/trade-api/v2';

/** A real scheduled game from ESPN, Denver at Kansas City, captured on 14 September 2026 with its DraftKings lines. */
const denverAtKansasCity = (): GameSummary => normalizeScoreboardEvent(fixture<Raw>('odds/nfl-401872931-pregame-event.json'), 'nfl', ['NFL'])!;

// Kalshi documents use the field names observed on 14 September 2026. The prices are made up for these tests.
const contract = (ticker: string, bid: string, ask: string, extra: Partial<KalshiMarket> = {}): KalshiMarket => ({ ticker, status: 'active', yes_bid_dollars: bid, yes_ask_dollars: ask, last_price_dollars: bid, ...extra });
const gameEvent: KalshiEvent = { event_ticker: 'KXNFLGAME-26SEP14DENKC', markets: [contract('KXNFLGAME-26SEP14DENKC-KC', '0.6000', '0.6100'), contract('KXNFLGAME-26SEP14DENKC-DEN', '0.3900', '0.4000')] };
const spreadEvent: KalshiEvent = { event_ticker: 'KXNFLSPREAD-26SEP14DENKC', markets: [contract('KXNFLSPREAD-26SEP14DENKC-KC3', '0.5200', '0.5300', { floor_strike: 2.5 })] };
const totalEvent: KalshiEvent = { event_ticker: 'KXNFLTOTAL-26SEP14DENKC', markets: [contract('KXNFLTOTAL-26SEP14DENKC-44', '0.5000', '0.5100', { floor_strike: 43.5 })] };

// Candlesticks in Kalshi's shape, with made-up prices: hourly before kickoff and minute by minute from an hour before it.
const KICKOFF = Date.parse('2026-09-15T00:15:00Z');
const HOUR = 3_600_000;
const candle = (endMs: number, bid: string, ask: string, last: string | null) => ({
  end_period_ts: endMs / 1000,
  yes_bid: { close_dollars: bid },
  yes_ask: { close_dollars: ask },
  price: last ? { close_dollars: last } : { previous_dollars: bid },
});
const HOURLY = [candle(KICKOFF - 3 * HOUR, '0.5800', '0.6000', '0.5900'), candle(KICKOFF - 2 * HOUR, '0.6000', '0.6100', null), candle(KICKOFF - HOUR, '0.6000', '0.6200', '0.6100'), candle(KICKOFF, '0.6200', '0.6300', '0.6200')];
const MINUTES = [candle(KICKOFF - 59 * 60_000, '0.6100', '0.6200', null), candle(KICKOFF + 10 * 60_000, '0.7000', '0.7100', '0.7000')];

/** A stand-in for Kalshi's public API, answering the four requests the service makes. */
function fakeKalshi(now: () => number) {
  const calls: string[] = [];
  const markets = new Map([...gameEvent.markets!, ...spreadEvent.markets!, ...totalEvent.markets!].map((m) => [m.ticker, { ...m }]));
  let down = false;
  const fetcher = {
    async getJson<T>(url: string): Promise<FetchOutcome<T>> {
      calls.push(url);
      const receivedAt = now();
      if (down) return { ok: false, error: 'HTTP 503', status: 503, receivedAt, retryable: true };
      const path = url.slice(API.length);
      let data: unknown = null;
      if (path.startsWith('/events?series_ticker=KXNFLGAME&')) data = { events: [gameEvent], cursor: '' };
      else if (path.startsWith('/events/KXNFLSPREAD-26SEP14DENKC?')) data = { event: spreadEvent };
      else if (path.startsWith('/events/KXNFLTOTAL-26SEP14DENKC?')) data = { event: totalEvent };
      else if (path.startsWith('/series/KXNFLGAME/markets/KXNFLGAME-26SEP14DENKC-KC/candlesticks?')) {
        const minutes = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('period_interval') === '1';
        data = { ticker: 'KXNFLGAME-26SEP14DENKC-KC', candlesticks: minutes ? MINUTES : HOURLY };
      } else if (path.startsWith('/markets?tickers=')) {
        const tickers = decodeURIComponent(path.slice('/markets?tickers='.length).split('&')[0]).split(',');
        data = { markets: tickers.map((t) => markets.get(t)).filter(Boolean) };
      }
      return data ? { ok: true, data: data as T, status: 200, receivedAt, bytes: 0 } : { ok: false, error: 'HTTP 404', status: 404, receivedAt, retryable: false };
    },
  };
  return {
    fetcher,
    calls,
    setDown: (value: boolean) => {
      down = value;
    },
    setQuote: (ticker: string, bid: string, ask: string) => {
      markets.set(ticker, contract(ticker, bid, ask));
    },
  };
}

describe('MarketService', () => {
  it("reads a matched game's prices, discovers its contracts once, and keeps unchanged prices as they were", async () => {
    let now = START;
    const kalshi = fakeKalshi(() => now);
    const service = new MarketService({ fetcher: kalshi.fetcher, now: () => now });
    const game = denverAtKansasCity();

    const first = (await service.read([game])).get(game.id)!;
    expect(first).toMatchObject({ source: 'Kalshi', stale: false, spread: { team: 'home', line: 2.5 }, total: { line: 43.5 } });
    expect(first.moneyline?.home?.price).toBe(0.605);
    expect(first.moneyline?.away?.price).toBe(0.395);

    now += 15_000;
    expect((await service.read([game])).get(game.id)).toBe(first);
    expect(kalshi.calls.filter((c) => c.includes('series_ticker=KXNFLGAME'))).toHaveLength(1);
    expect(service.stats()).toMatchObject({ source: 'Kalshi', matchedGames: 1, failures: 0 });

    kalshi.setQuote('KXNFLGAME-26SEP14DENKC-KC', '0.6500', '0.6600');
    now += 15_000;
    const moved = (await service.read([game])).get(game.id)!;
    expect(moved.moneyline?.home?.price).toBe(0.655);
    expect(moved.changedAt).toBe(new Date(now).toISOString());
  });

  it('keeps prices through failed reads, marks them stale after 90 seconds, and drops them after 10 minutes', async () => {
    let now = START;
    const kalshi = fakeKalshi(() => now);
    const service = new MarketService({ fetcher: kalshi.fetcher, now: () => now });
    const game = denverAtKansasCity();
    const fresh = (await service.read([game])).get(game.id)!;

    kalshi.setDown(true);
    now += 60_000;
    expect((await service.read([game])).get(game.id)).toBe(fresh);
    now += 40_000;
    expect((await service.read([game])).get(game.id)).toMatchObject({ stale: true, moneyline: fresh.moneyline });
    now += 10 * 60_000;
    expect((await service.read([game])).get(game.id)).toBeNull();
    expect(service.stats().lastError).toBe('HTTP 503');
  });

  it('reads nothing for a game that has ended or is days away', async () => {
    const kalshi = fakeKalshi(() => START);
    const service = new MarketService({ fetcher: kalshi.fetcher, now: () => START });
    const game = denverAtKansasCity();
    const prices = await service.read([
      { ...game, status: { ...game.status, kind: 'final' } },
      { ...game, id: 'nfl-9', startTime: '2026-09-20T17:00Z' },
    ]);
    expect(prices.get(game.id)).toBeNull();
    expect(prices.get('nfl-9')).toBeNull();
    expect(kalshi.calls).toHaveLength(0);
  });

  it("reads a game's price history, hourly until an hour before kickoff and then minute by minute, and reuses it while fresh", async () => {
    let now = KICKOFF + 45 * 60_000;
    const kalshi = fakeKalshi(() => now);
    const service = new MarketService({ fetcher: kalshi.fetcher, now: () => now });
    const scheduled = denverAtKansasCity();
    const game: GameSummary = { ...scheduled, status: { ...scheduled.status, kind: 'in_progress' } };

    const history = await service.history(game);
    expect(history).toMatchObject({ source: 'Kalshi', team: 'home', captured: false });
    expect(history?.points).toEqual([
      { at: new Date(KICKOFF - 3 * HOUR).toISOString(), price: 0.59 },
      { at: new Date(KICKOFF - 2 * HOUR).toISOString(), price: 0.605 },
      { at: new Date(KICKOFF - HOUR).toISOString(), price: 0.61 },
      { at: new Date(KICKOFF - 59 * 60_000).toISOString(), price: 0.615 },
      { at: new Date(KICKOFF + 10 * 60_000).toISOString(), price: 0.705 },
    ]);
    const candleCalls = () => kalshi.calls.filter((c) => c.includes('/candlesticks?'));
    expect(candleCalls()).toHaveLength(2);
    expect(candleCalls().some((c) => c.includes('period_interval=60') && c.includes(`end_ts=${(KICKOFF - HOUR) / 1000}`))).toBe(true);

    now += 20_000;
    await service.history(game);
    expect(candleCalls()).toHaveLength(2);
    now += 30_000;
    await service.history(game);
    expect(candleCalls()).toHaveLength(3);
    expect(await service.history({ ...game, status: { ...game.status, kind: 'final' } })).toBeNull();
  });
});

describe('market prices in the engine', () => {
  it('attaches prices to slate summaries, keeps them through the next poll, and sends their removal', async () => {
    const game = denverAtKansasCity();
    const provider: SportsProvider = {
      info: { id: 'fake', name: 'Fake', description: 'test', licensed: false, push: false, divisions: ['NFL'] },
      async fetchSlate(league, date): Promise<SlateResult> {
        return { league, dateKey: date, games: league === 'nfl' ? [game] : [], divisions: [], errors: [], failed: false, receivedAt: Date.now(), discovery: '', limitations: [] };
      },
      async fetchDetail() {
        return { ok: false, error: { scope: 'detail', message: 'not found', status: 404 }, receivedAt: Date.now() };
      },
    };
    const prices: MarketPrices = { source: 'Kalshi', moneyline: { home: { price: 0.6, bid: 0.59, ask: 0.61, last: 0.6 }, away: null }, spread: null, total: null, changedAt: '2026-09-14T20:00:00.000Z', stale: false };
    const asked: string[][] = [];
    const engine = new GridironEngine({
      provider,
      mode: 'live',
      today: () => '20260914',
      markets: {
        read: async (games) => {
          asked.push(games.map((g) => g.id));
          return new Map([[game.id, prices]]);
        },
      },
    });

    const snapshot = await engine.getSlate('20260914');
    expect(snapshot.games.find((g) => g.id === game.id)?.market).toEqual(prices);
    expect(asked).toEqual([[game.id]]);

    await engine.refreshLeague('nfl', '20260914');
    expect(engine.snapshot('20260914').games.find((g) => g.id === game.id)?.market).toEqual(prices);
    expect(engine.marketGames().map((g) => g.id)).toContain(game.id);

    const sent: EngineMessage[] = [];
    engine.connect('client-1', { date: '20260914', divisions: ['FBS'], focus: [], visible: [], monitored: [], alertsAllGames: false }, (m) => sent.push(m));
    engine.setMarketPrices(new Map([[game.id, null]]));
    expect(engine.snapshot('20260914').games.find((g) => g.id === game.id)?.market).toBeNull();
    const delta = sent.find((m): m is Extract<EngineMessage, { type: 'slate-delta' }> => m.type === 'slate-delta');
    expect(delta?.upserts.map((g) => [g.id, g.market])).toEqual([[game.id, null]]);
  });

  it("puts a followed game's price history on its detail, and sends a new version when the history changes", async () => {
    let clock = Date.parse('2026-09-14T22:00:00Z');
    const game = denverAtKansasCity();
    const detail: GameDetail = { gameId: game.id, summary: game, drives: [], plays: [], scoring: [], stats: [], leaders: [], attendance: null, currentDriveId: null, gaps: [] };
    const provider: SportsProvider = {
      info: { id: 'fake', name: 'Fake', description: 'test', licensed: false, push: false, divisions: ['NFL'] },
      async fetchSlate(league, date): Promise<SlateResult> {
        return { league, dateKey: date, games: [], divisions: [], errors: [], failed: false, receivedAt: clock, discovery: '', limitations: [] };
      },
      async fetchDetail() {
        return { ok: true, detail, receivedAt: clock };
      },
    };
    const first: MarketHistory = { source: 'Kalshi', team: 'home', captured: false, points: [{ at: '2026-09-14T20:00:00.000Z', price: 0.6 }, { at: '2026-09-14T21:00:00.000Z', price: 0.61 }] };
    const second: MarketHistory = { ...first, points: [...first.points, { at: '2026-09-14T22:00:00.000Z', price: 0.64 }] };
    let reads = 0;
    const engine = new GridironEngine({ provider, mode: 'live', today: () => '20260914', now: () => clock, marketHistory: async () => (reads++ === 0 ? first : second) });
    const sent: EngineMessage[] = [];
    engine.connect('client-1', { date: '20260914', divisions: ['FBS'], focus: [game.id], visible: [], monitored: [], alertsAllGames: false }, (m) => sent.push(m));

    const opened = await engine.getDetail(game.id);
    expect(opened.detail?.marketHistory).toEqual(first);

    // Before kickoff the history is read again after five minutes; the provider's detail itself is unchanged.
    clock += 6 * 60_000;
    const later = await engine.getDetail(game.id);
    expect(later.version).toBe(opened.version + 1);
    expect(later.detail?.marketHistory).toEqual(second);
    expect(reads).toBe(2);
    const update = sent.filter((m) => m.type === 'detail' || m.type === 'detail-delta').pop();
    const carried = update?.type === 'detail-delta' ? update.delta.marketHistory : update?.type === 'detail' ? update.detail?.marketHistory : undefined;
    expect(carried).toEqual(second);
  });
});
