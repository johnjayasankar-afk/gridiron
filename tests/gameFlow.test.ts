import { describe, expect, it } from 'vitest';
import { gameFlow } from '../shared/gameFlow';
import type { ScoreEvent } from '../shared/model';
import { game } from './helpers/builders';

const score = (period: number, clock: string, away: number, home: number, team: 'home' | 'away' = 'away', id = `${period}-${clock}`): ScoreEvent => ({
  id,
  gameId: 'nfl-1',
  playId: null,
  period,
  clock,
  team,
  kind: 'touchdown',
  description: 'Score',
  scoreAfter: { home, away },
});

const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 4);

describe('game flow', () => {
  it('steps the margin at each reported score along the game clock', () => {
    const g = game({ kind: 'final', home: 10, away: 7, period: 4 });
    const flow = gameFlow(g, [score(1, '10:00', 7, 0), score(2, '0:03', 7, 3, 'home'), score(4, '2:00', 7, 10, 'home')]);
    expect(flow.points.map((p) => p.margin)).toEqual([0, -7, -4, 3]);
    close(flow.points[1].x, 300 / 3600);
    close(flow.points[2].x, (900 + 897) / 3600);
    close(flow.points[3].x, (2700 + 780) / 3600);
    expect(flow.end).toMatchObject({ x: 1, margin: 3, label: 'Final' });
    expect(flow.periods.map((p) => p.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(flow.extent).toBe(7);
  });

  it('adds an NFL overtime segment placed by its clock', () => {
    const g = game({ kind: 'final', home: 31, away: 24, period: 5 });
    const flow = gameFlow(g, [score(4, '0:30', 24, 24, 'home'), score(5, '6:07', 24, 31, 'home')]);
    expect(flow.periods.map((p) => p.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'OT']);
    close(flow.points[2].x, (3600 + (600 - 367)) / 4200);
    expect(flow.extent).toBe(7);
  });

  it('rounds the vertical extent up to a multiple of 7', () => {
    const g = game({ kind: 'final', home: 3, away: 13, period: 4 });
    expect(gameFlow(g, [score(2, '5:00', 10, 0), score(3, '5:00', 13, 3, 'away')]).extent).toBe(14);
  });

  it('spaces untimed college overtime scores in the order reported', () => {
    const g = { ...game({ league: 'cfb', kind: 'final', home: 48, away: 45, period: 6 }), league: 'cfb' as const };
    const flow = gameFlow(g, [score(5, '0:00', 38, 38, 'home', 'a'), score(5, '0:00', 45, 38, 'away', 'b'), score(6, '0:00', 45, 45, 'home', 'c'), score(6, '0:00', 45, 48, 'home', 'd')]);
    const total = 3600 + 1200;
    close(flow.points[1].x, (3600 + 200) / total);
    close(flow.points[2].x, (3600 + 400) / total);
    close(flow.points[3].x, (4200 + 200) / total);
    expect(flow.periods.map((p) => p.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'OT', '2OT']);
  });

  it('marks where a live game stands and ignores scores reported without a score', () => {
    const g = game({ kind: 'in_progress', home: 3, away: 0, period: 2, clock: '7:30' });
    g.status.clockSeconds = 450;
    const flow = gameFlow(g, [score(1, '4:00', 0, 3, 'home'), { ...score(2, '9:00', 0, 0), scoreAfter: { home: null, away: null } }]);
    expect(flow.points).toHaveLength(2);
    close(flow.end!.x, (900 + 450) / 3600);
    expect(flow.end).toMatchObject({ margin: 3, label: 'Q2 7:30' });
  });

  it('has no end point before kickoff', () => {
    const flow = gameFlow(game({ kind: 'scheduled' }), []);
    expect(flow.points).toHaveLength(1);
    expect(flow.end).toBeNull();
  });
});
