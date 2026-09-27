import { describe, expect, it } from 'vitest';
import { byDisagreement, disagreement, disagrees, MIN_DISAGREEMENT } from '../shared/consensus';
import type { GameSummary, MarketPrices } from '../shared/model';
import { game } from './helpers/builders';

const quote = (price: number) => ({ price, bid: price, ask: price, source: 'Kalshi' }) as unknown as NonNullable<NonNullable<MarketPrices['moneyline']>['home']>;

const market = (home: number | null, away: number | null = null, stale = false): MarketPrices => ({
  source: 'Kalshi',
  moneyline: { home: home === null ? null : quote(home), away: away === null ? null : quote(away) },
  spread: null,
  total: null,
  changedAt: '2026-09-27T18:00:00Z',
  stale,
});

/** A live game carrying both reported numbers. */
const both = (modelHome: number, marketHome: number | null, opts: { stale?: boolean; kind?: GameSummary['status']['kind'] } = {}): GameSummary => {
  const g = game({ kind: opts.kind ?? 'in_progress', home: 17, away: 14 });
  return {
    ...g,
    winProbability: { home: modelHome, tie: 0, playId: 'p1', source: 'ESPN' },
    market: market(marketHome, null, opts.stale ?? false),
  };
};

describe('where the model and the exchange disagree', () => {
  it('reports both numbers and the distance between them, and invents no third one', () => {
    const d = disagreement(both(0.96, 0.74))!;
    expect(d.model).toBe(0.96);
    expect(d.market).toBe(0.74);
    expect(d.points).toBeCloseTo(22, 6);
    expect(d.source).toBe('Kalshi');
  });

  it('names the side the exchange rates higher, not the side that is winning', () => {
    expect(disagreement(both(0.3, 0.7))!.favours).toBe('home');
    expect(disagreement(both(0.7, 0.3))!.favours).toBe('away');
  });

  it('refuses a stale exchange price, because lag is not disagreement', () => {
    expect(disagreement(both(0.96, 0.4, { stale: true }))).toBeNull();
    // The same prices, not stale, are a disagreement. So staleness is what refused it.
    expect(disagreement(both(0.96, 0.4))).not.toBeNull();
  });

  it('refuses a game that is not being played', () => {
    expect(disagreement(both(0.96, 0.4, { kind: 'scheduled' }))).toBeNull();
    expect(disagreement(both(0.96, 0.4, { kind: 'final' }))).toBeNull();
  });

  it('refuses when either side is missing, rather than filling one in', () => {
    const noModel = { ...both(0.9, 0.5), winProbability: null };
    expect(disagreement(noModel)).toBeNull();
    expect(disagreement(both(0.9, null))).toBeNull();
  });

  it('never derives the home price from the away price, because the two contracts are quoted apart', () => {
    const awayOnly = { ...both(0.9, null), market: market(null, 0.2) };
    expect(disagreement(awayOnly)).toBeNull();
  });

  it('draws the line where the measurement put it, not at a round number', () => {
    // Eight points: the top tenth of how far apart these two were measured to
    // get across 97 moments of a captured NFL Sunday, median 0.9, max 18.7.
    expect(MIN_DISAGREEMENT).toBe(0.08);
    expect(disagrees(both(0.5, 0.58))).toBe(true);
    expect(disagrees(both(0.5, 0.579))).toBe(false);
  });

  it('stays quiet at the gap these two usually sit at', () => {
    // The measured median, and the seventy fifth percentile. A marker that
    // fires at either would be reporting the ordinary state of the world.
    expect(disagrees(both(0.5, 0.509))).toBe(false);
    expect(disagrees(both(0.5, 0.529))).toBe(false);
  });

  it('orders the widest gaps first and leaves games with nothing to compare behind them', () => {
    const wide = both(0.95, 0.55);
    const narrow = both(0.5, 0.55);
    const none = game({ kind: 'final' });
    const sorted = [none, narrow, wide].sort(byDisagreement);
    expect(sorted[0]).toBe(wide);
    expect(sorted[1]).toBe(narrow);
    expect(sorted[2]).toBe(none);
  });

  it('is stable when neither game has anything to compare', () => {
    const a = game({ id: 'a', kind: 'final' });
    const b = game({ id: 'b', kind: 'final' });
    expect(byDisagreement(a, b)).toBe(0);
  });
});
