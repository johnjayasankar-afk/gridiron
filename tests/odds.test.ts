import { describe, expect, it } from 'vitest';
import {
  americanFromChance,
  decimalOdds,
  formatAmerican,
  formatBookOdds,
  formatChance,
  formatMarketPrice,
  formatSpread,
  formatSwing,
  formatTotal,
  impliedChance,
  parseAmerican,
  parseDollars,
  quotePrice,
  withoutMargin,
} from '../shared/odds';

const MINUS = '−';

describe('odds arithmetic', () => {
  it('reads American odds from provider values and rejects anything else', () => {
    expect(parseAmerican('-130')).toBe(-130);
    expect(parseAmerican('+110')).toBe(110);
    expect(parseAmerican(114)).toBe(114);
    expect(parseAmerican('EVEN')).toBe(100);
    expect(parseAmerican('OFF')).toBeNull();
    expect(parseAmerican('')).toBeNull();
    expect(parseAmerican('-50')).toBeNull();
    expect(parseAmerican(null)).toBeNull();
  });

  it('converts American odds to the chance they imply and to decimal odds, and back', () => {
    expect(impliedChance(-130)).toBeCloseTo(130 / 230, 9);
    expect(impliedChance(110)).toBeCloseTo(100 / 210, 9);
    expect(decimalOdds(-130)).toBeCloseTo(1.7692, 4);
    expect(decimalOdds(110)).toBeCloseTo(2.1, 9);
    expect(americanFromChance(0.55)).toBe(-122);
    expect(americanFromChance(0.4)).toBe(150);
    expect(americanFromChance(0)).toBeNull();
    expect(americanFromChance(1)).toBeNull();
  });

  it('removes the sportsbook margin from a pair of prices', () => {
    const [home, away] = withoutMargin(impliedChance(-135), impliedChance(114))!;
    expect(home + away).toBeCloseTo(1, 9);
    expect(home).toBeGreaterThan(0.55);
    expect(home).toBeLessThan(0.56);
    expect(withoutMargin(0, 0)).toBeNull();
  });

  it('prices an exchange contract from a close bid and ask, or else from its last trade', () => {
    expect(parseDollars('0.5500')).toBe(0.55);
    expect(parseDollars('1.2')).toBeNull();
    expect(parseDollars(undefined)).toBeNull();
    expect(quotePrice(0.54, 0.55, 0.55)).toBe(0.545);
    expect(quotePrice(0.4, 0.6, 0.47)).toBe(0.47);
    expect(quotePrice(null, null, null)).toBeNull();
    expect(quotePrice(0.3, 0.9, 0)).toBeNull();
  });

  it('writes odds, chances, spreads and totals without rounding a live game to a certainty', () => {
    expect(formatAmerican(-130)).toBe(`${MINUS}130`);
    expect(formatAmerican(110)).toBe('+110');
    expect(formatAmerican(-100)).toBe('EVEN');
    expect(formatChance(0.545)).toBe('55%');
    expect(formatChance(0.004)).toBe('<1%');
    expect(formatChance(0.996)).toBe('>99%');
    expect(formatChance(1)).toBe('100%');
    expect(formatBookOdds(-130, 'decimal')).toBe('1.77');
    expect(formatBookOdds(-130, 'percent')).toBe('57%');
    expect(formatMarketPrice(0.55, 'american')).toBe(`${MINUS}122`);
    expect(formatMarketPrice(0.4, 'decimal')).toBe('2.50');
    expect(formatMarketPrice(0.4, 'percent')).toBe('40%');
    expect(formatSpread(-2.5)).toBe(`${MINUS}2.5`);
    expect(formatSpread(3)).toBe('+3');
    expect(formatSpread(0)).toBe('PK');
    expect(formatTotal(43.5)).toBe('43.5');
    expect(formatSwing(0.081)).toBe('+8');
    expect(formatSwing(-0.034)).toBe(`${MINUS}3`);
  });
});
