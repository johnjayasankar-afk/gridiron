/**
 * The required ball-placement cases, each checked in both attacking directions:
 * own 20, own 35, midfield, opponent 25, opponent 1, the goal line, a touchback,
 * a safety, a turnover, goal to go, and an unknown spot.
 */
import { describe, expect, it } from 'vitest';
import {
  describeProgress,
  firstDownTarget,
  labelFromProgress,
  progressFromLabel,
  progressFromSchematicYard,
  schematicYardFromProgress,
  worldX,
  yardsGained,
  type Side,
} from '../shared/field';
import { SPOT_UNAVAILABLE, spotLabel } from '../shared/format';
import { UNKNOWN_SPOT } from '../shared/model';
import { game, spot } from './helpers/builders';

// Away team BUF defends the left goal line (world x -50); home team NE the right (+50).
const teams = { home: { abbreviation: 'NE' }, away: { abbreviation: 'BUF' } };

const place = (progress: number, offense: Side) => {
  const schematic = schematicYardFromProgress(progress, offense);
  return { schematic, x: worldX(schematic), label: labelFromProgress(progress, offense, teams), words: describeProgress(progress) };
};

describe('required ball placement cases', () => {
  it.each([
    ['own 20', 20, { away: { x: -30, label: 'BUF 20' }, home: { x: 30, label: 'NE 20' } }],
    ['own 35', 35, { away: { x: -15, label: 'BUF 35' }, home: { x: 15, label: 'NE 35' } }],
    ['midfield', 50, { away: { x: 0, label: '50' }, home: { x: 0, label: '50' } }],
    ['opponent 25', 75, { away: { x: 25, label: 'NE 25' }, home: { x: -25, label: 'BUF 25' } }],
    ['opponent 1', 99, { away: { x: 49, label: 'NE 1' }, home: { x: -49, label: 'BUF 1' } }],
    ['opponent goal line', 100, { away: { x: 50, label: 'NE goal line' }, home: { x: -50, label: 'BUF goal line' } }],
  ] as const)('%s', (words, progress, expected) => {
    for (const offense of ['away', 'home'] as const) {
      const p = place(progress, offense);
      expect(p.x).toBe(expected[offense].x);
      expect(p.label).toBe(expected[offense].label);
      expect(progressFromLabel(p.label === 'NE goal line' || p.label === 'BUF goal line' ? `${p.label.split(' ')[0]} 0` : p.label, offense, teams)).toBe(progress);
      expect(p.words).toBe(words === 'opponent goal line' ? 'opponent goal line' : words);
      // Never inside an end zone.
      expect(Math.abs(p.x)).toBeLessThanOrEqual(50);
    }
  });

  it('places a touchback at the spot the provider reports for the next snap', () => {
    expect(progressFromLabel('BUF 25', 'away', teams)).toBe(25);
    expect(place(25, 'away').x).toBe(-25);
    expect(progressFromLabel('NE 20', 'home', teams)).toBe(20);
    expect(place(20, 'home').x).toBe(30);
  });

  it('places a safety at the scoring team’s opponent’s own goal line, not in the end zone', () => {
    expect(place(0, 'away')).toMatchObject({ x: -50, label: 'BUF goal line', words: 'own goal line' });
    expect(place(0, 'home')).toMatchObject({ x: 50, label: 'NE goal line' });
  });

  it('keeps the ball where it is when a turnover changes possession, and measures the play in the original frame', () => {
    const before = { progress: 70, offense: 'away' as const }; // BUF at NE 30
    const schematic = schematicYardFromProgress(before.progress, before.offense);
    const after = { progress: progressFromSchematicYard(schematic, 'home'), offense: 'home' as const };
    expect(after.progress).toBe(30); // NE ball at its own 30
    expect(worldX(schematicYardFromProgress(after.progress, after.offense))).toBe(worldX(schematic));
    expect(yardsGained(before, { progress: 80, offense: 'home' })).toBe(-50); // returned to BUF 20
  });

  it('targets the goal line on goal to go and never draws a marker in the end zone', () => {
    expect(firstDownTarget(95, 5, true)).toEqual({ progress: 100, kind: 'goal' });
    expect(firstDownTarget(92, 10, false)).toEqual({ progress: 100, kind: 'goal' });
    expect(firstDownTarget(60, 10, false)).toEqual({ progress: 70, kind: 'line' });
  });

  it('says the spot is unavailable instead of guessing', () => {
    const g = game();
    expect(spotLabel(UNKNOWN_SPOT, g)).toBe(SPOT_UNAVAILABLE);
    expect(spotLabel(spot(null, 'away'), g)).toBe(SPOT_UNAVAILABLE);
    expect(progressFromLabel('the 50 yard line', 'away', teams)).toBeNull();
    expect(progressFromLabel('KC 30', 'away', teams)).toBeNull();
  });
});
