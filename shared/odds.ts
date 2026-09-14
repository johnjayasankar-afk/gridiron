/**
 * Odds arithmetic and formatting. Everything here converts prices that a
 * sportsbook or an exchange reported; nothing estimates a chance on its own.
 *
 * - American odds: -130 means risking 130 to win 100; +110 means risking 100 to win 110.
 * - A sportsbook's implied chances include its margin, so the two sides add up to
 *   more than 100%. `withoutMargin` scales a pair to 100% for comparison.
 * - An exchange contract's price in dollars (0.55) is the market's implied chance (55%).
 */

export type OddsFormat = 'american' | 'decimal' | 'percent';

const MINUS = '−';

/** American odds from a provider value such as -130, "+110" or "EVEN". Anything else, such as "OFF", is null. */
export function parseAmerican(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && Math.abs(raw) >= 100 ? Math.round(raw) : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(MINUS, '-');
  if (/^even$/i.test(s)) return 100;
  if (!/^[+-]?\d{3,6}$/.test(s)) return null;
  return Number(s);
}

/** The chance American odds imply, 0 to 1, with the sportsbook's margin still in it. */
export function impliedChance(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

/** Decimal odds (the total return for each unit staked) for American odds. */
export function decimalOdds(odds: number): number {
  return odds < 0 ? 1 + 100 / -odds : 1 + odds / 100;
}

/** American odds that imply `chance` (strictly between 0 and 1). */
export function americanFromChance(chance: number): number | null {
  if (!(chance > 0 && chance < 1)) return null;
  return chance >= 0.5 ? -Math.round((chance / (1 - chance)) * 100) : Math.round(((1 - chance) / chance) * 100);
}

/** Two implied chances scaled to add up to 1, which removes the sportsbook's margin. */
export function withoutMargin(a: number, b: number): [number, number] | null {
  const sum = a + b;
  return sum > 0 ? [a / sum, b / sum] : null;
}

/** A dollar price such as "0.5500", as a number from 0 to 1. */
export function parseDollars(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * The price to show for an exchange contract: the midpoint of the best bid and ask
 * while they are at most 5 cents apart, otherwise the last trade. Null when the
 * market has neither a tight quote nor a trade.
 */
export function quotePrice(bid: number | null, ask: number | null, last: number | null): number | null {
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid && ask - bid <= 0.05 + 1e-9) return Math.round(((bid + ask) / 2) * 1000) / 1000;
  if (last !== null && last > 0 && last < 1) return last;
  return null;
}

const oneDecimal = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** "+110", "−130", or "EVEN" at plus or minus 100. Empty for null. */
export function formatAmerican(odds: number | null): string {
  if (odds === null) return '';
  if (Math.abs(odds) === 100) return 'EVEN';
  return odds > 0 ? `+${odds}` : `${MINUS}${-odds}`;
}

/** "55%". A chance strictly between 0% and 1%, or 99% and 100%, reads "<1%" or ">99%" instead of rounding to a certainty. */
export function formatChance(chance: number | null): string {
  if (chance === null) return '';
  const pct = chance * 100;
  if (pct > 0 && pct < 1) return '<1%';
  if (pct > 99 && pct < 100) return '>99%';
  return `${Math.round(pct)}%`;
}

/** Sportsbook odds in the chosen format. Percent is the chance the odds imply, margin included. */
export function formatBookOdds(odds: number | null, format: OddsFormat): string {
  if (odds === null) return '';
  if (format === 'decimal') return decimalOdds(odds).toFixed(2);
  if (format === 'percent') return formatChance(impliedChance(odds));
  return formatAmerican(odds);
}

/** An exchange price in the chosen format: the chance itself, or odds that imply it. */
export function formatMarketPrice(price: number | null, format: OddsFormat): string {
  if (price === null) return '';
  if (format === 'american') return formatAmerican(americanFromChance(price));
  if (format === 'decimal') return price > 0 ? (1 / price).toFixed(2) : '';
  return formatChance(price);
}

/** A team's spread: "−2.5", "+2.5", or "PK" for a pick'em. */
export function formatSpread(line: number | null): string {
  if (line === null) return '';
  if (line === 0) return 'PK';
  return line > 0 ? `+${oneDecimal(line)}` : `${MINUS}${oneDecimal(-line)}`;
}

/** A points total: "43.5". */
export function formatTotal(line: number | null): string {
  return line === null ? '' : oneDecimal(line);
}

/** The change between two chances in percentage points: "+8", "−3" or "0". */
export function formatSwing(delta: number): string {
  const points = Math.round(delta * 100);
  if (points === 0) return '0';
  return points > 0 ? `+${points}` : `${MINUS}${-points}`;
}
