import { describe, expect, it } from 'vitest';
import {
  attackDirection,
  describeProgress,
  firstDownTarget,
  isInRedZone,
  labelFromProgress,
  progressFromHomeYardLine,
  progressFromLabel,
  progressFromSchematicYard,
  progressFromYardsToEndzone,
  schematicYardFromProgress,
  worldXFromProgress,
  yardsGained,
} from '../shared/field';

const teams = { home: { abbreviation: 'NE' }, away: { abbreviation: 'BUF' } };

describe('reported spot → offense progress', () => {
  it('reads own and opponent labels from the offense perspective', () => {
    expect(progressFromLabel('BUF 20', 'away', teams)).toBe(20);
    expect(progressFromLabel('BUF 35', 'away', teams)).toBe(35);
    expect(progressFromLabel('NE 25', 'away', teams)).toBe(75);
    expect(progressFromLabel('NE 1', 'away', teams)).toBe(99);
    // the same labels with the home team on offense
    expect(progressFromLabel('NE 20', 'home', teams)).toBe(20);
    expect(progressFromLabel('BUF 25', 'home', teams)).toBe(75);
  });

  it('treats midfield as 50 whatever the label style', () => {
    expect(progressFromLabel('50', 'away', teams)).toBe(50);
    expect(progressFromLabel('MID 50', 'home', teams)).toBe(50);
    expect(progressFromLabel('NE 50', 'away', teams)).toBe(50);
  });

  it('refuses labels it cannot place instead of guessing', () => {
    expect(progressFromLabel('KC 35', 'away', teams)).toBeNull();
    expect(progressFromLabel('', 'away', teams)).toBeNull();
    expect(progressFromLabel('BUF 60', 'away', teams)).toBeNull();
    expect(progressFromLabel(undefined, 'away', teams)).toBeNull();
  });

  it('uses distance to the opponent end zone directly', () => {
    expect(progressFromYardsToEndzone(80)).toBe(20); // own 20
    expect(progressFromYardsToEndzone(50)).toBe(50);
    expect(progressFromYardsToEndzone(1)).toBe(99); // opponent 1
    expect(progressFromYardsToEndzone(0)).toBe(100); // goal line
    expect(progressFromYardsToEndzone(100)).toBe(0); // own goal line (a safety)
    expect(progressFromYardsToEndzone(-3)).toBeNull();
    expect(progressFromYardsToEndzone(null)).toBeNull();
  });

  it('converts a yard line measured from the home goal line', () => {
    // Observed in ESPN play data: CIN (home) at its own 20 reports yardLine 20;
    // TB (away) at its own 25 reports yardLine 75.
    expect(progressFromHomeYardLine(20, 'home')).toBe(20);
    expect(progressFromHomeYardLine(75, 'away')).toBe(25);
    expect(progressFromHomeYardLine(46, 'away')).toBe(54); // TB at CIN 46
    expect(progressFromHomeYardLine(68, 'home')).toBe(68); // CIN at TB 32
  });
});

describe('progress → labels and text', () => {
  it('round-trips through labels', () => {
    expect(labelFromProgress(35, 'away', teams)).toBe('BUF 35');
    expect(labelFromProgress(75, 'away', teams)).toBe('NE 25');
    expect(labelFromProgress(50, 'home', teams)).toBe('50');
    expect(labelFromProgress(99, 'home', teams)).toBe('BUF 1');
    expect(describeProgress(35)).toBe('own 35');
    expect(describeProgress(75)).toBe('opponent 25');
    expect(describeProgress(50)).toBe('midfield');
  });
});

describe('schematic orientation and render placement', () => {
  it('places the away offense attacking right and the home offense attacking left', () => {
    expect(attackDirection('away')).toBe(1);
    expect(attackDirection('home')).toBe(-1);
    expect(schematicYardFromProgress(35, 'away')).toBe(35);
    expect(schematicYardFromProgress(35, 'home')).toBe(65);
    expect(worldXFromProgress(35, 'away')).toBe(-15);
    expect(worldXFromProgress(35, 'home')).toBe(15); // mirrored
    expect(worldXFromProgress(50, 'home')).toBe(0);
  });

  it('keeps the ball in the same place when possession changes hands', () => {
    // BUF (away) intercepted at its own 40: NE now has the ball at BUF 40, its opponent 40.
    const before = progressFromLabel('BUF 40', 'away', teams)!;
    const after = progressFromLabel('BUF 40', 'home', teams)!;
    expect(before).toBe(40);
    expect(after).toBe(60);
    expect(schematicYardFromProgress(before, 'away')).toBe(schematicYardFromProgress(after, 'home'));
    expect(progressFromSchematicYard(schematicYardFromProgress(after, 'home'), 'home')).toBe(60);
  });

  it('follows a 40-yard gain from the own 35', () => {
    const start = progressFromLabel('BUF 35', 'away', teams)!;
    const end = start + 40;
    expect(start).toBe(35);
    expect(end).toBe(75);
    expect(labelFromProgress(end, 'away', teams)).toBe('NE 25');
    expect(worldXFromProgress(end, 'away')).toBe(25);
    expect(worldXFromProgress(end, 'home')).toBe(-25);
    expect(yardsGained({ progress: start, offense: 'away' }, { progress: end, offense: 'away' })).toBe(40);
  });
});

describe('line to gain', () => {
  it('draws a first-down marker ahead of the spot', () => {
    expect(firstDownTarget(35, 10, false)).toEqual({ progress: 45, kind: 'line' });
  });

  it('targets the goal line when it is goal to go, never a marker in the end zone', () => {
    expect(firstDownTarget(95, 5, true)).toEqual({ progress: 100, kind: 'goal' });
    expect(firstDownTarget(92, 10, false)).toEqual({ progress: 100, kind: 'goal' });
  });

  it('draws nothing without a known spot or distance', () => {
    expect(firstDownTarget(null, 10, false)).toBeNull();
    expect(firstDownTarget(40, null, false)).toBeNull();
  });
});

describe('red zone, touchback, safety, turnover', () => {
  it('knows the red zone starts at the opponent 20', () => {
    expect(isInRedZone(79)).toBe(false);
    expect(isInRedZone(80)).toBe(true);
    expect(isInRedZone(null)).toBeNull();
  });

  it('places a touchback where the provider reports the next spot', () => {
    // College kickoff touchback observed as "WKU 25", yardsToEndzone 75.
    expect(progressFromYardsToEndzone(75)).toBe(25);
    expect(progressFromLabel('WKU 25', 'away', { home: { abbreviation: 'UGA' }, away: { abbreviation: 'WKU' } })).toBe(25);
  });

  it('places a safety at the offense own goal line', () => {
    expect(progressFromYardsToEndzone(100)).toBe(0);
    expect(worldXFromProgress(0, 'away')).toBe(-50);
    expect(worldXFromProgress(0, 'home')).toBe(50);
  });

  it('measures a turnover return in the original offense frame', () => {
    // BUF throws from its own 30; NE intercepts and returns to the BUF 10 (NE progress 90).
    expect(yardsGained({ progress: 30, offense: 'away' }, { progress: 90, offense: 'home' })).toBe(-20);
  });
});
