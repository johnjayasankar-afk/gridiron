import { describe, expect, it } from 'vitest';
import { candlesFrom } from '../server/markets/kalshi';
import { applyDetailDelta, computeDetailDelta } from '../shared/detailDelta';
import { formatCents, marketTrack, priceAtPlay, pricePoints, priceSummary, sameHistory, trackPriceAt, type PriceCandle } from '../shared/marketHistory';
import type { GameDetail, MarketHistory } from '../shared/model';
import type { ProbabilitySeries } from '../shared/winProbability';

// Fictional prices and times; the field names and shapes are Kalshi's and Gridiron's own.
const at = (hhmm: string) => `2026-09-13T${hhmm}:00.000Z`;
const seconds = (hhmm: string) => Date.parse(at(hhmm)) / 1000;
const history = (points: Array<[string, number]>, extra: Partial<MarketHistory> = {}): MarketHistory => ({
  source: 'Kalshi',
  team: 'home',
  captured: false,
  points: points.map(([time, price]) => ({ at: at(time), price })),
  ...extra,
});

function detailWith(marketHistory: MarketHistory | null): GameDetail {
  return {
    gameId: 'nfl-1',
    summary: {} as GameDetail['summary'],
    drives: [],
    plays: [
      { id: 'nfl-1:1', order: 0, wallclock: at('17:00') },
      { id: 'nfl-1:2', order: 1, wallclock: at('17:10') },
      { id: 'nfl-1:3', order: 2, wallclock: at('17:20') },
    ] as GameDetail['plays'],
    scoring: [],
    stats: [],
    leaders: [],
    attendance: null,
    currentDriveId: null,
    gaps: [],
    marketHistory,
  };
}

const series: ProbabilitySeries = {
  periods: [],
  swings: [],
  points: [
    { x: 0, home: 0.5, tie: 0, playId: 'nfl-1:1', order: 0, label: 'Q1 15:00', description: null, swing: null },
    { x: 0.25, home: 0.6, tie: 0, playId: 'nfl-1:2', order: 1, label: 'Q2 15:00', description: null, swing: 0.1 },
    { x: 0.5, home: 0.7, tie: 0, playId: 'nfl-1:3', order: 2, label: 'Q3 15:00', description: null, swing: 0.1 },
  ],
};

describe('market price history', () => {
  it('reads Kalshi candlesticks, leaving out malformed entries', () => {
    const raw = [
      { end_period_ts: 1789329660, price: { close_dollars: '0.8100' }, yes_bid: { close_dollars: '0.8000' }, yes_ask: { close_dollars: '0.8100' } },
      { end_period_ts: 1789329720, price: { previous_dollars: '0.8100' }, yes_bid: { close_dollars: '0.7900' }, yes_ask: { close_dollars: '0.8200' } },
      { price: { close_dollars: '0.5' } },
      'not a candle',
    ];
    expect(candlesFrom(raw)).toEqual([
      [1789329660, 0.8, 0.81, 0.81],
      [1789329720, 0.79, 0.82, null],
    ]);
    expect(candlesFrom({ candlesticks: [] })).toEqual([]);
  });

  it('prices each period like a live quote, skips periods with no price, and keeps only the ends of a flat run', () => {
    const candles: PriceCandle[] = [
      [seconds('17:04'), 0.54, 0.56, null],
      [seconds('17:01'), 0.54, 0.56, 0.55],
      [seconds('17:02'), 0.4, 0.6, 0.52],
      [seconds('17:03'), 0, 1, null],
      [seconds('17:05'), 0.54, 0.56, 0.6],
      [seconds('17:06'), 0.55, 0.55, null],
    ];
    expect(pricePoints(candles)).toEqual([
      { at: at('17:01'), price: 0.55 },
      { at: at('17:02'), price: 0.52 },
      { at: at('17:04'), price: 0.55 },
      { at: at('17:06'), price: 0.55 },
    ]);
  });

  it('places prices between the plays around them by time, from the last price before the first play to the latest play shown', () => {
    const h = history([
      ['16:30', 0.45],
      ['16:55', 0.48],
      ['17:05', 0.55],
      ['17:10', 0.6],
      ['17:15', 0.65],
      ['17:25', 0.8],
    ]);
    const track = marketTrack(series, detailWith(h));
    expect(track?.points).toEqual([
      { x: 0, price: 0.48, at: at('16:55') },
      { x: 0.125, price: 0.55, at: at('17:05') },
      { x: 0.25, price: 0.6, at: at('17:10') },
      { x: 0.375, price: 0.65, at: at('17:15') },
    ]);
    expect(trackPriceAt(track, 0.3)?.price).toBe(0.6);
    expect(trackPriceAt(track, 0.25)?.price).toBe(0.6);
    expect(trackPriceAt(null, 0.3)).toBeNull();
    // An away team's contract, or too little history, draws nothing.
    expect(marketTrack(series, detailWith({ ...h, team: 'away' }))).toBeNull();
    expect(marketTrack(series, detailWith(history([['17:05', 0.55]])))).toBeNull();
    expect(marketTrack(series, detailWith(null))).toBeNull();
  });

  it('summarizes the change across the window, and writes prices in cents', () => {
    const s = priceSummary(history([
      ['16:00', 0.56],
      ['17:00', 0.49],
      ['18:00', 0.605],
    ]));
    expect(s).toMatchObject({ low: 0.49, high: 0.605 });
    expect(s?.change).toBeCloseTo(0.045, 6);
    expect(priceSummary(history([['16:00', 0.5]]))).toBeNull();
    expect([formatCents(0.55), formatCents(0.545), formatCents(0.01)]).toEqual(['55¢', '54.5¢', '1¢']);
  });

  it('sends the history in a detail delta only when it changed, and applies its removal', () => {
    const a = history([
      ['17:00', 0.5],
      ['17:01', 0.52],
    ]);
    const b = history([
      ['17:00', 0.5],
      ['17:01', 0.52],
      ['17:02', 0.57],
    ]);
    expect(sameHistory(a, history([['17:00', 0.5], ['17:01', 0.52]]))).toBe(true);
    expect(sameHistory(a, b)).toBe(false);
    expect(sameHistory(null, undefined)).toBe(true);

    const unchanged = computeDetailDelta(detailWith(a), detailWith(a), 1, 2);
    expect('marketHistory' in unchanged).toBe(false);
    expect(applyDetailDelta(detailWith(a), unchanged).marketHistory).toEqual(a);

    const grown = computeDetailDelta(detailWith(a), detailWith(b), 2, 3);
    expect(grown.marketHistory).toEqual(b);
    expect(applyDetailDelta(detailWith(a), grown).marketHistory).toEqual(b);

    const removed = computeDetailDelta(detailWith(b), detailWith(null), 3, 4);
    expect(removed.marketHistory).toBeNull();
    expect(applyDetailDelta(detailWith(b), removed).marketHistory).toBeUndefined();
  });
});

/**
 * Looking at an earlier play should show the market as it stood then, not as it stands
 * now. The rule is the one the chart already uses: the last price recorded at or before
 * the play's wall-clock time. Nothing is interpolated, and a price recorded after the
 * play is never used, because it was not known then.
 */
describe('the price standing at a play', () => {
  const detail = detailWith(
    history([
      ['16:58', 0.4],
      ['17:05', 0.52],
      ['17:15', 0.61],
      ['17:25', 0.7],
    ]),
  );

  it('takes the last price recorded before the play, never one recorded after it', () => {
    // The play at 17:10 gets the 17:05 price, not the 17:15 one.
    expect(priceAtPlay(detail, 'nfl-1:2')).toMatchObject({ price: 0.52, at: at('17:05'), source: 'Kalshi', team: 'home' });
    expect(priceAtPlay(detail, 'nfl-1:3')).toMatchObject({ price: 0.61, at: at('17:15') });
    // and says how old the reading was, so a gap in the record can be seen
    expect(priceAtPlay(detail, 'nfl-1:2')!.ageSeconds).toBe(300);
  });

  it('measures the change against the price standing at the play before', () => {
    // 0.61 at the third play against 0.52 at the second.
    expect(priceAtPlay(detail, 'nfl-1:3')!.swing).toBeCloseTo(0.09, 6);
    // The first play has nothing before it to compare with.
    expect(priceAtPlay(detail, 'nfl-1:1')!.swing).toBeNull();
  });

  it('gives nothing when there is nothing to place the play by', () => {
    expect(priceAtPlay(detailWith(null), 'nfl-1:2')).toBeNull();
    expect(priceAtPlay(detail, 'nfl-1:nope')).toBeNull();
    // A price recorded only after the play leaves it with none.
    expect(priceAtPlay(detailWith(history([['18:00', 0.9]])), 'nfl-1:2')).toBeNull();
  });
});
