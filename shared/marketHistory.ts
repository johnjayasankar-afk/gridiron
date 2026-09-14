/**
 * Prediction market prices across time, beside the provider's win probability. Nothing here
 * estimates a chance. It orders an exchange's recorded prices and places each one on the game
 * clock by the wall-clock times of the reported plays around it.
 */
import type { GameDetail, MarketHistory, MarketPricePoint, Side } from './model.js';
import { quotePrice } from './odds.js';
import type { ProbabilitySeries } from './winProbability.js';

/** One recorded period: when it ended (Unix seconds), then its closing best bid, best ask and last trade, in dollars. */
export type PriceCandle = [end: number, bid: number | null, ask: number | null, last: number | null];

/**
 * Price points from recorded periods, oldest first. Each is the middle of a close bid and ask,
 * otherwise the last trade, the same rule as a live quote. A period with neither is left out, and
 * a run of unchanged prices keeps only its first and last point, which draws the same line.
 */
export function pricePoints(candles: readonly PriceCandle[]): MarketPricePoint[] {
  const out: MarketPricePoint[] = [];
  for (const [end, bid, ask, last] of [...candles].sort((a, b) => a[0] - b[0])) {
    const price = quotePrice(bid, ask, last);
    if (price === null || !Number.isFinite(end)) continue;
    const point = { at: new Date(end * 1000).toISOString(), price };
    const n = out.length;
    if (n >= 2 && out[n - 1].price === price && out[n - 2].price === price) out[n - 1] = point;
    else out.push(point);
  }
  return out;
}

/** A contract price in cents: "55¢", or "54.5¢" for a midpoint between two cents. */
export const formatCents = (price: number): string => `${Math.round(price * 1000) / 10}¢`;

export function sameHistory(a: MarketHistory | null | undefined, b: MarketHistory | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.source !== b.source || a.team !== b.team || a.captured !== b.captured || a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i++) if (a.points[i].at !== b.points[i].at || a.points[i].price !== b.points[i].price) return false;
  return true;
}

export interface PriceSummary {
  first: MarketPricePoint;
  last: MarketPricePoint;
  low: number;
  high: number;
  /** The latest price minus the first. */
  change: number;
}

/** The first and latest price, the range between them, and the change. Null with fewer than two points. */
export function priceSummary(history: MarketHistory | null | undefined): PriceSummary | null {
  const points = history?.points ?? [];
  if (points.length < 2) return null;
  let low = 1;
  let high = 0;
  for (const p of points) {
    low = Math.min(low, p.price);
    high = Math.max(high, p.price);
  }
  const first = points[0];
  const last = points[points.length - 1];
  return { first, last, low, high, change: last.price - first.price };
}

export interface MarketTrackPoint {
  /** Position across the game, 0 to 1, on the win probability chart's axis. */
  x: number;
  price: number;
  at: string;
}

export interface MarketTrack {
  source: string;
  team: Side;
  captured: boolean;
  points: MarketTrackPoint[];
}

/**
 * Places the home team's recorded prices on the win probability chart. Each reported play with a
 * wall-clock time anchors its point on the game clock, and a price recorded between two plays sits
 * between them in proportion to the time. The last price before the first play starts the line.
 * Prices recorded after the latest play shown are left out, so the market never runs ahead of the
 * plays on the page, including under a spoiler delay. Null without two placed prices.
 */
export function marketTrack(series: ProbabilitySeries, detail: GameDetail): MarketTrack | null {
  const history = detail.marketHistory;
  if (!history || history.team !== 'home' || history.points.length < 2) return null;
  const wall = new Map(detail.plays.map((p) => [p.id, p.wallclock ? Date.parse(p.wallclock) : Number.NaN]));
  const anchors: Array<{ t: number; x: number }> = [];
  for (const p of series.points) {
    const t = wall.get(p.playId);
    if (t === undefined || !Number.isFinite(t)) continue;
    const prev = anchors[anchors.length - 1];
    if (prev && t <= prev.t) continue;
    anchors.push({ t, x: Math.max(prev?.x ?? 0, p.x) });
  }
  if (anchors.length < 2) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];

  const points: MarketTrackPoint[] = [];
  let opening: MarketPricePoint | null = null;
  let j = 0;
  for (const p of history.points) {
    const t = Date.parse(p.at);
    if (!Number.isFinite(t)) continue;
    if (t < first.t) {
      opening = p;
      continue;
    }
    if (t > last.t) break;
    while (j < anchors.length - 2 && anchors[j + 1].t <= t) j++;
    const a = anchors[j];
    const b = anchors[j + 1];
    const share = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    points.push({ x: a.x + (b.x - a.x) * share, price: p.price, at: p.at });
  }
  if (opening) points.unshift({ x: first.x, price: opening.price, at: opening.at });
  return points.length >= 2 ? { source: history.source, team: history.team, captured: history.captured, points } : null;
}

/** The track's price at a position on the chart: the last placed price at or before it. */
export function trackPriceAt(track: MarketTrack | null, x: number): MarketTrackPoint | null {
  if (!track) return null;
  let found: MarketTrackPoint | null = null;
  for (const p of track.points) {
    if (p.x > x + 1e-9) break;
    found = p;
  }
  return found;
}
