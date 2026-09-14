import { describe, expect, it } from 'vitest';
import { flowStats, type FlowPoint, type FlowSeries } from '../shared/gameFlow';

const point = (x: number, away: number, home: number): FlowPoint => ({ x, home, away, margin: home - away, event: null, team: null, label: '' });
const series = (points: FlowPoint[], end: FlowPoint | null = null): FlowSeries => ({ points: [point(0, 0, 0), ...points], periods: [], end, extent: 7 });

describe('game flow stats', () => {
  it('counts lead changes through ties and the largest lead for each team', () => {
    const s = series([point(0.1, 0, 7), point(0.2, 7, 7), point(0.3, 14, 7), point(0.5, 14, 17), point(0.7, 14, 24)]);
    expect(flowStats(s)).toEqual({ leadChanges: 2, ties: 1, largestLead: { home: 10, away: 7 } });
  });

  it('reports a scoreless game and a lone field goal plainly', () => {
    expect(flowStats(series([]))).toEqual({ leadChanges: 0, ties: 0, largestLead: { home: 0, away: 0 } });
    expect(flowStats(series([point(0.4, 3, 0)]))).toEqual({ leadChanges: 0, ties: 0, largestLead: { home: 0, away: 3 } });
  });

  it('uses the current score only when it changes the margin', () => {
    expect(flowStats(series([point(0.5, 0, 7)], point(1, 10, 7)))).toEqual({ leadChanges: 1, ties: 0, largestLead: { home: 7, away: 3 } });
    expect(flowStats(series([point(0.5, 0, 7)], point(1, 0, 7)))).toEqual({ leadChanges: 0, ties: 0, largestLead: { home: 7, away: 0 } });
  });
});
