import { describe, expect, it } from 'vitest';
import { contractsFor, contractTickers, dateFromTicker, findGameEvent, kalshiCode, nearestStrike, parseEventTicker, pricesFrom, quoteOf, type KalshiEvent, type KalshiMarket } from '../server/markets/kalshi';
import { normalizeScoreboardEvent } from '../server/providers/espn/normalize';
import type { GameSummary } from '../shared/model';
import { fixture } from './helpers/fixtures';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A real scheduled game from ESPN, Denver at Kansas City, captured on 14 September 2026 with its DraftKings lines (KC -2.5, total 43.5). */
const denverAtKansasCity = (): GameSummary => normalizeScoreboardEvent(fixture<Raw>('odds/nfl-401872931-pregame-event.json'), 'nfl', ['NFL'])!;

// Kalshi documents below use the field names observed on 14 September 2026. The prices are made up for these tests.
const contract = (ticker: string, bid: string, ask: string, last: string, extra: Partial<KalshiMarket> = {}): KalshiMarket => ({ ticker, status: 'active', yes_bid_dollars: bid, yes_ask_dollars: ask, last_price_dollars: last, ...extra });
const gameEvent: KalshiEvent = {
  event_ticker: 'KXNFLGAME-26SEP14DENKC',
  title: 'Denver vs Kansas City',
  markets: [contract('KXNFLGAME-26SEP14DENKC-KC', '0.6000', '0.6100', '0.6100'), contract('KXNFLGAME-26SEP14DENKC-DEN', '0.3900', '0.4000', '0.3900')],
};
const spreadEvent: KalshiEvent = {
  event_ticker: 'KXNFLSPREAD-26SEP14DENKC',
  markets: [
    contract('KXNFLSPREAD-26SEP14DENKC-KC2', '0.5800', '0.5900', '0.5800', { floor_strike: 1.5 }),
    contract('KXNFLSPREAD-26SEP14DENKC-KC3', '0.5200', '0.5300', '0.5200', { floor_strike: 2.5 }),
    contract('KXNFLSPREAD-26SEP14DENKC-KC4', '0.4700', '0.4800', '0.4700', { floor_strike: 3.5 }),
    contract('KXNFLSPREAD-26SEP14DENKC-DEN3', '0.2100', '0.2200', '0.2100', { floor_strike: 2.5 }),
  ],
};
const totalEvent: KalshiEvent = {
  event_ticker: 'KXNFLTOTAL-26SEP14DENKC',
  markets: [contract('KXNFLTOTAL-26SEP14DENKC-41', '0.6000', '0.6200', '0.6100', { floor_strike: 40.5 }), contract('KXNFLTOTAL-26SEP14DENKC-44', '0.5000', '0.5100', '0.5000', { floor_strike: 43.5 })],
};
const everyContract = new Map([...gameEvent.markets!, ...spreadEvent.markets!, ...totalEvent.markets!].map((m) => [m.ticker, m]));

describe('Kalshi contracts', () => {
  it('reads the date and teams from an event ticker', () => {
    expect(dateFromTicker('26SEP14')).toBe('20260914');
    expect(dateFromTicker('26XYZ14')).toBeNull();
    expect(parseEventTicker('KXNFLGAME-26SEP14DENKC')).toEqual({ series: 'KXNFLGAME', date: '20260914', teams: 'DENKC' });
    expect(parseEventTicker('KXNFLGAME')).toBeNull();
  });

  it("writes team codes the way Kalshi does, where they differ from ESPN's", () => {
    const game = denverAtKansasCity();
    expect(kalshiCode(game.home)).toBe('KC');
    expect(kalshiCode({ ...game.home, abbreviation: 'JAX' })).toBe('JAC');
    expect(kalshiCode({ ...game.home, abbreviation: 'WSH' })).toBe('WAS');
    expect(kalshiCode({ ...game.home, league: 'cfb', abbreviation: 'WSH' })).toBe('WSH');
  });

  it("matches a game by its US Eastern date and both teams' contracts, and nothing looser", () => {
    const game = denverAtKansasCity();
    expect(findGameEvent([gameEvent], game)).toBe(gameEvent);
    expect(findGameEvent([{ ...gameEvent, event_ticker: 'KXNFLGAME-26SEP14KCDEN' }], game)?.event_ticker).toBe('KXNFLGAME-26SEP14KCDEN');
    expect(findGameEvent([{ ...gameEvent, event_ticker: 'KXNFLGAME-26SEP15DENKC' }], game)).toBeNull();
    expect(findGameEvent([{ ...gameEvent, markets: gameEvent.markets!.slice(0, 1) }], game)).toBeNull();
    expect(findGameEvent([gameEvent], { ...game, startTime: null })).toBeNull();
  });

  it("chooses the spread and total contracts at the sportsbook's lines, and refuses far-off strikes", () => {
    const game = denverAtKansasCity();
    const contracts = contractsFor(game, gameEvent, spreadEvent, totalEvent)!;
    expect(contracts).toEqual({
      event: 'KXNFLGAME-26SEP14DENKC',
      home: 'KXNFLGAME-26SEP14DENKC-KC',
      away: 'KXNFLGAME-26SEP14DENKC-DEN',
      spread: { team: 'home', line: 2.5, ticker: 'KXNFLSPREAD-26SEP14DENKC-KC3' },
      total: { line: 43.5, ticker: 'KXNFLTOTAL-26SEP14DENKC-44' },
    });
    expect(contractTickers(contracts)).toHaveLength(4);
    expect(nearestStrike(spreadEvent.markets!, 10, 'KC')).toBeNull();
    expect(nearestStrike(spreadEvent.markets!, 2.5, 'DEN')?.ticker).toBe('KXNFLSPREAD-26SEP14DENKC-DEN3');
    expect(contractsFor({ ...game, lines: null }, gameEvent, spreadEvent, totalEvent)).toMatchObject({ spread: null, total: null });
  });

  it('prices contracts from close quotes, and leaves out closed or untraded contracts', () => {
    const game = denverAtKansasCity();
    const prices = pricesFrom(contractsFor(game, gameEvent, spreadEvent, totalEvent)!, everyContract, '2026-09-14T20:00:00.000Z', false)!;
    expect(prices.source).toBe('Kalshi');
    expect(prices.moneyline?.home).toEqual({ price: 0.605, bid: 0.6, ask: 0.61, last: 0.61 });
    expect(prices.moneyline?.away?.price).toBe(0.395);
    expect(prices.spread).toEqual({ team: 'home', line: 2.5, quote: { price: 0.525, bid: 0.52, ask: 0.53, last: 0.52 } });
    expect(prices.total?.over.price).toBe(0.505);
    expect(prices.changedAt).toBe('2026-09-14T20:00:00.000Z');

    expect(quoteOf(contract('X', '0.5000', '0.5100', '0.5000', { status: 'finalized' }))).toBeNull();
    expect(quoteOf(contract('X', '0.1000', '0.9000', '0.0000'))).toBeNull();
    expect(pricesFrom(contractsFor(game, gameEvent, null, null)!, new Map(), 'now', false)).toBeNull();
  });
});
