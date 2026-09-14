import { describe, expect, it } from 'vitest';
import { buildDigest, takeDigestSnapshot } from '../shared/digest';
import { detail, game, play } from './helpers/builders';

const options = { bigPlayYards: 20 };

describe('while you were away', () => {
  it('reports nothing for games that did not change', () => {
    const g = game({ id: 'nfl-1', home: 7, away: 3 });
    const snapshot = takeDigestSnapshot([g], {}, 1000);
    expect(buildDigest(snapshot, [g], {}, options)).toEqual({ since: 1000, entries: [], totals: { scores: 0, turnovers: 0, finals: 0, kickoffs: 0 } });
  });

  it('labels a scoreboard-only change as a score change, without classifying it', () => {
    const before = game({ id: 'nfl-1', home: 7, away: 3 });
    const after = game({ id: 'nfl-1', home: 14, away: 3 });
    const digest = buildDigest(takeDigestSnapshot([before], {}, 0), [after], {}, options);
    expect(digest.entries[0].items).toEqual([{ order: null, when: '', text: 'Score changed: 3-7 to 3-14', tone: 'score' }]);
    expect(digest.totals.scores).toBe(1);
  });

  it('lists scores and turnovers reported after the last play seen, never earlier history', () => {
    const g0 = game({ id: 'nfl-1', home: 0, away: 0 });
    const early = [play({ n: 0, kind: 'touchdown_rush', startProgress: 95, endProgress: 100, scoring: true, away: 6, description: 'Earlier touchdown' })];
    const snapshot = takeDigestSnapshot([g0], { 'nfl-1': detail(g0, early) }, 0);
    expect(snapshot.games['nfl-1'].lastOrder).toBe(0);
    const later = [
      ...early,
      play({ n: 1, kind: 'rush', startProgress: 20, endProgress: 25 }),
      play({ n: 2, kind: 'interception', offense: 'home', startProgress: 30, endProgress: 70, endOffense: 'away', turnover: true, description: 'Picked off' }),
      play({ n: 3, kind: 'touchdown_pass', startProgress: 80, endProgress: 100, scoring: true, away: 13, description: 'Later touchdown' }),
    ];
    const g1 = game({ id: 'nfl-1', home: 0, away: 13 });
    const entry = buildDigest(snapshot, [g1], { 'nfl-1': detail(g1, later) }, options).entries[0];
    expect(entry.items.map((i) => [i.order, i.tone])).toEqual([
      [2, 'turnover'],
      [3, 'score'],
    ]);
    expect(entry.items.some((i) => i.text.includes('Earlier touchdown'))).toBe(false);
    expect(entry.headline).toBe('1 score, 1 turnover');
  });

  it('does not replay history when play-by-play arrived only after the snapshot', () => {
    const before = game({ id: 'nfl-1', home: 7, away: 0 });
    const after = game({ id: 'nfl-1', home: 14, away: 0 });
    const plays = [play({ n: 0, kind: 'touchdown_rush', offense: 'home', startProgress: 95, endProgress: 100, scoring: true, home: 7 }), play({ n: 1, kind: 'touchdown_rush', offense: 'home', startProgress: 90, endProgress: 100, scoring: true, home: 14 })];
    const entry = buildDigest(takeDigestSnapshot([before], {}, 0), [after], { 'nfl-1': detail(after, plays) }, options).entries[0];
    expect(entry.items).toEqual([{ order: null, when: '', text: 'Score changed: 0-7 to 0-14', tone: 'score' }]);
  });

  it('covers kickoffs and finals, and puts the busiest games first', () => {
    const scheduled = game({ id: 'nfl-1', kind: 'scheduled' });
    const quiet = game({ id: 'nfl-2', home: 3, away: 0 });
    const snapshot = takeDigestSnapshot([scheduled, quiet], {}, 0);
    const finished = game({ id: 'nfl-1', kind: 'final', home: 21, away: 17 });
    const scored = game({ id: 'nfl-2', home: 3, away: 7 });
    const plays = [play({ n: 0, gameId: 'nfl-1', kind: 'touchdown_pass', offense: 'home', startProgress: 70, endProgress: 100, scoring: true, home: 7 })];
    const digest = buildDigest(snapshot, [scored, finished], { 'nfl-1': detail(finished, plays) }, options);
    expect(digest.entries.map((e) => e.gameId)).toEqual(['nfl-1', 'nfl-2']);
    expect(digest.entries[0].items.map((i) => i.text)).toEqual(['Kicked off', expect.stringContaining('touchdown'), 'Final: AWY 17, HOM 21']);
    expect(digest.totals).toEqual({ scores: 2, turnovers: 0, finals: 1, kickoffs: 1 });
  });
});
