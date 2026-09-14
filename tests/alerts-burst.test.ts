import { describe, expect, it } from 'vitest';
import { AlertEngine, BURST_PLAYS } from '../shared/alerts';
import { detail, game, play } from './helpers/builders';

describe('delayed bursts of plays', () => {
  it('announces a single new play normally and a held-up batch as late updates', () => {
    const engine = new AlertEngine();
    const start = game({ id: 'nfl-1', home: 0, away: 0 });
    const first = [play({ n: 0, kind: 'rush', startProgress: 25, endProgress: 30 })];
    expect(engine.observe(start, detail(start, first), 0)).toEqual([]);

    const withBigPlay = [...first, play({ n: 1, kind: 'pass_complete', startProgress: 30, endProgress: 70, yards: 40 })];
    const single = engine.observe(start, detail(start, withBigPlay), 10_000);
    expect(single.map((c) => [c.alert.kind, c.alert.late])).toEqual([['big_play', false]]);

    const batch = [
      ...withBigPlay,
      ...Array.from({ length: BURST_PLAYS }, (_, i) => play({ n: 2 + i, kind: 'rush', startProgress: 70 + i, endProgress: 71 + i })),
      play({ n: 9, kind: 'touchdown_rush', startProgress: 90, endProgress: 100, scoring: true, away: 6 }),
    ];
    const scored = game({ id: 'nfl-1', home: 0, away: 6 });
    const changes = engine.observe(scored, detail(scored, batch), 20_000);
    const touchdown = changes.find((c) => c.alert.kind === 'touchdown');
    expect(touchdown?.alert.late).toBe(true);
    expect(changes.some((c) => c.alert.kind === 'score_change')).toBe(false);
  });
});
