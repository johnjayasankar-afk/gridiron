import { describe, expect, it } from 'vitest';
import { catchUp, driveResultLabel, filterPlays, frameAt, playTags, scoringOrders, stepOrder } from '../shared/replayFrames';
import { detail, game, play } from './helpers/builders';

const g = game({ id: 'nfl-1', home: 7, away: 7 });
const plays = [
  play({ n: 0, kind: 'kickoff', offense: 'home', startProgress: 35, endProgress: 25, endOffense: 'away' }),
  play({ n: 1, kind: 'rush', offense: 'away', startProgress: 25, endProgress: 31, yards: 6, description: 'Carter up the middle for 6 yards' }),
  play({ n: 2, kind: 'timeout', offense: null, startProgress: null }),
  play({ n: 3, kind: 'pass_complete', offense: 'away', startProgress: 31, endProgress: 75, yards: 44, description: 'Deep pass right to Moss for 44 yards' }),
  play({ n: 4, kind: 'touchdown_rush', offense: 'away', startProgress: 75, endProgress: 100, yards: 25, scoring: true, scoringTeam: 'away', away: 6 }),
  play({ n: 5, kind: 'extra_point', offense: 'away', startProgress: 85, endProgress: 85, scoring: true, away: 7 }),
  play({ n: 6, kind: 'interception', offense: 'home', startProgress: 30, endProgress: 60, endOffense: 'away', turnover: true, driveId: 'nfl-1:drive:2', away: 7 }),
  play({ n: 7, kind: 'punt', offense: 'away', down: 4, startProgress: 40, endProgress: 80, endOffense: 'home', driveId: 'nfl-1:drive:2', away: 7 }),
  play({ n: 8, kind: 'penalty', offense: 'home', startProgress: 20, endProgress: null, penalty: true, driveId: 'nfl-1:drive:2', away: 7, home: 7 }),
];
const d = detail(g, plays);

describe('historical frames', () => {
  it('shows a play as a move between its reported spots, with the state after it', () => {
    const f = frameAt(d, 3)!;
    expect(f.index).toBe(2); // the timeout is not a frame
    expect(f.total).toBe(8);
    expect([f.fromYard, f.toYard]).toEqual([31, 75]);
    expect(f.situation?.spot.progress).toBe(75);
    expect(f.situation?.lastPlay?.id).toBe(plays[3].id);
  });

  it('uses the home frame for home offenses, mirroring the schematic field', () => {
    const f = frameAt(d, 6)!;
    expect([f.fromYard, f.toYard]).toEqual([70, 60]);
    expect(f.situation?.possession).toBe('away');
  });

  it('does not invent a spot for a play reported without one', () => {
    const f = frameAt(d, 8)!;
    expect(f.toYard).toBeNull();
    expect(f.situation?.spot.schematicYard ?? null).toBeNull();
  });

  it('has no frame for administrative entries', () => {
    expect(frameAt(d, 2)).toBeNull();
  });

  it('steps between plays, skipping timeouts, with sticky ends and drive scope', () => {
    expect(stepOrder(d, null, -1)).toBe(8);
    expect(stepOrder(d, null, 1)).toBeNull();
    expect(stepOrder(d, 3, -1)).toBe(1);
    expect(stepOrder(d, 1, 1)).toBe(3);
    expect(stepOrder(d, 8, 1)).toBe(8);
    expect(stepOrder(d, 0, -1)).toBe(0);
    expect(stepOrder(d, 7, -1, 'nfl-1:drive:2')).toBe(6);
    expect(stepOrder(d, 6, -1, 'nfl-1:drive:2')).toBe(6);
    // An order outside the scope continues from the nearest earlier play.
    expect(stepOrder(d, 2, 1)).toBe(1 + 0 === 1 ? 1 : 1);
    expect(stepOrder(d, 2, 2)).toBe(3);
  });
});

describe('play filters', () => {
  it('tags plays from explicit types and flags only', () => {
    expect([...playTags(plays[4], 20)].sort()).toEqual(['big', 'scoring']);
    expect(playTags(plays[5], 20).has('scoring')).toBe(true);
    expect(playTags(plays[6], 20).has('turnovers')).toBe(true);
    expect(playTags(plays[7], 20).has('fourth')).toBe(true);
    expect(playTags(plays[8], 20).has('penalties')).toBe(true);
    expect(playTags(plays[3], 50).has('big')).toBe(false);
  });

  it('does not treat an overturned touchdown as scoring', () => {
    const overturned = play({ n: 9, kind: 'touchdown_pass', startProgress: 90, endProgress: 100, scoring: false });
    expect(playTags(overturned, 20).has('scoring')).toBe(false);
  });

  it('combines a filter with a multi-word search', () => {
    expect(filterPlays(plays, 'big', 'moss deep').map((p) => p.order)).toEqual([3]);
    expect(filterPlays(plays, 'all', 'middle').map((p) => p.order)).toEqual([1]);
    expect(filterPlays(plays, 'turnovers', '').map((p) => p.order)).toEqual([6]);
  });

  it('jumps between touchdowns, field goals and safeties but not conversions', () => {
    expect(scoringOrders(d)).toEqual([4]);
  });
});

describe('catch-up summary', () => {
  it('summarizes what happened after the last play seen', () => {
    const s = catchUp(d, 1);
    expect(s.newPlays).toBe(6);
    expect(s.items.map((i) => [i.order, i.tone])).toEqual([
      [3, 'big'],
      [4, 'score'],
      [6, 'turnover'],
    ]);
    expect(s.headline).toBe('1 score, 1 turnover, 1 big play in 6 new plays');
    expect(s.scoreBefore).toEqual({ home: 0, away: 0 });
  });

  it('says plainly when nothing is new', () => {
    expect(catchUp(d, 8).headline).toBe('No new plays reported');
  });

  it('labels drive results in plain language', () => {
    expect(driveResultLabel('DOWNS')).toBe('Turnover on downs');
    expect(driveResultLabel('MISSED FG')).toBe('Missed field goal');
    expect(driveResultLabel('END OF HALF')).toBe('End of half');
    expect(driveResultLabel('something new')).toBe('Something new');
    expect(driveResultLabel(null)).toBeNull();
  });
});
