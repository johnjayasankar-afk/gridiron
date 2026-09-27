/**
 * Where the provider's model and the exchange disagree about who is winning.
 *
 * Two independent numbers already arrive for a live game and nothing has ever
 * compared them: the provider's own win probability model, and the price a
 * prediction market is charging for that team to win. Both are reported. The
 * distance between them is subtraction, not a third opinion, and this file
 * never produces one.
 *
 * It is worth surfacing because the two disagree for reasons a scoreboard
 * cannot show. A model reads down, distance, clock and score. A market reads
 * whatever the people trading it know, which on a given afternoon includes an
 * injury, a quarterback change, weather at the stadium or simply that the last
 * six minutes have not gone the way the box score suggests.
 *
 * Measured before it was believed, and the measurement is sobering. On a
 * captured NFL Sunday these two tracked each other closely: a median of 0.9
 * points apart, and three moments in 97 that reached ten. Most of the time the
 * exchange is agreeing with the model, so this finds a handful of moments an
 * afternoon, not a running commentary. That is the honest size of it.
 *
 * What this is not: a prediction, a recommendation, a blend of the two, or a
 * judgement that either side is right. It reports both numbers and the gap.
 */
import type { GameSummary, Side } from './model.js';
import { isLiveOrPaused } from './model.js';

export interface Disagreement {
  /** The model's chance the home team wins outright, 0 to 1, exactly as reported. */
  model: number;
  /** The exchange's price for the home team to win, 0 to 1, exactly as quoted. */
  market: number;
  /** The distance between them, in points from 0 to 100. Always positive. */
  points: number;
  /** The side the exchange rates higher than the model does. */
  favours: Side;
  /** The exchange, for attribution. */
  source: string;
}

/**
 * Eight points, from measurement rather than by analogy.
 *
 * Ten was the first choice, borrowed from the bar `winProbability` uses for a
 * swing worth naming. Nothing justified it. Measured instead: 97 moments across
 * a captured NFL Sunday where both sources were present and the exchange was
 * fresh. The two sat a median of 0.9 points apart, 2.9 at the seventy fifth
 * percentile, 7.9 at the ninetieth, and 18.7 at their furthest.
 *
 * So eight, which is the top tenth of how far apart these two actually get.
 *
 * Worth recording how nearly this went wrong. The first search for a threshold
 * walked a single replay session from one position to the next, and reported
 * gaps of eleven points that do not exist: seeking leaves the model and the
 * exchange momentarily out of step, which is the lag this comparison refuses,
 * so the search was measuring the artifact it was meant to exclude. Every
 * number above comes from a separate session created at its own position.
 *
 * Calibrated on one afternoon of well traded NFL games and no more than that. A
 * thin college market may behave differently, and if this starts appearing on
 * ordinary cards the number is wrong rather than the games.
 */
export const MIN_DISAGREEMENT = 0.08;

/**
 * The gap for one game, or null when there is nothing honest to compare.
 *
 * Refused, each for its own reason:
 *
 * - A game that is not being played. The model only reports during play, and a
 *   game that has finished has no disagreement left to have.
 * - A missing number on either side. Most obviously before kickoff, when the
 *   exchange is already trading and the model has said nothing yet.
 * - A stale exchange price. This is the one that matters. A price that has not
 *   moved while the game has is lag, and lag looks exactly like disagreement:
 *   the model updates every play, the exchange when somebody trades. Reporting
 *   it would manufacture a signal out of a thin market, most often on the small
 *   games where there is least trading, which is precisely where it would be
 *   least deserved.
 *
 * The home side is compared directly and never derived from the away price. The
 * two contracts are quoted separately and need not add up to one, so turning
 * one into the other would invent the number being compared.
 */
export function disagreement(game: GameSummary): Disagreement | null {
  if (!isLiveOrPaused(game.status.kind)) return null;
  const model = game.winProbability ?? null;
  const market = game.market ?? null;
  if (!model || !market || market.stale) return null;
  const quote = market.moneyline?.home ?? null;
  if (!quote) return null;
  const a = model.home;
  const b = quote.price;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return {
    model: a,
    market: b,
    points: Math.abs(b - a) * 100,
    favours: b > a ? 'home' : 'away',
    source: market.source,
  };
}

/**
 * True when the gap is wide enough to be worth a reader's attention rather than
 * noise between two models.
 *
 * The tolerance is not decoration. These are differences of binary fractions,
 * and a market at 0.6 against a model at 0.5 is exactly ten points to a reader
 * and 9.999999999999998 to the machine, which would drop the boundary case that
 * the threshold was chosen to include.
 */
export function disagrees(game: GameSummary): boolean {
  const d = disagreement(game);
  return d !== null && d.points >= MIN_DISAGREEMENT * 100 - 1e-9;
}

/**
 * Games ordered by how far apart the two sources are, widest first. Games with
 * nothing to compare keep their existing order behind those that do.
 */
export function byDisagreement(a: GameSummary, b: GameSummary): number {
  const da = disagreement(a);
  const db = disagreement(b);
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return db.points - da.points;
}
