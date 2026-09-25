/**
 * The moments rail is what a Sunday accumulates: every score, turnover and lead
 * change from every game on the card, and the rail draws all of them. A session
 * left open through an afternoon was measured growing from 1,700 DOM nodes to
 * 6,200, and the only thing that stops that becoming the whole day is the cap
 * in the store. Nothing held it, so this does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AlertChange } from '../shared/alerts';
import type { Alert } from '../shared/model';
import { useFeed } from '../src/state/feed';

const OPTIONS = {
  now: 1_700_000_000_000,
  toastFor: () => false,
  announceFor: () => false,
  describeGame: () => 'a game',
};

const alertAt = (n: number): Alert => ({
  id: `a:${n}`,
  revision: 1,
  kind: 'touchdown',
  gameId: `nfl-${n % 13}`,
  title: `Score ${n}`,
  detail: 'detail',
  team: 'home',
  period: 1,
  clock: '10:00',
  receivedAt: OPTIONS.now + n,
  sourceTime: null,
  late: false,
  status: 'active',
  playId: null,
  priority: 2,
});

const created = (n: number): AlertChange => ({ type: 'created', alert: alertAt(n) });

describe('the moments rail', () => {
  beforeEach(() => useFeed.getState().clear());

  it('stops at its cap however long the afternoon runs', () => {
    // A heavy Sunday, four times over.
    for (let n = 0; n < 1000; n++) useFeed.getState().apply([created(n)], OPTIONS);
    expect(useFeed.getState().moments.length).toBe(250);
  });

  it('keeps the newest and drops the oldest, so the rail reads as a feed', () => {
    for (let n = 0; n < 400; n++) useFeed.getState().apply([created(n)], OPTIONS);
    const moments = useFeed.getState().moments;
    expect(moments[0].id).toBe('a:399');
    expect(moments[moments.length - 1].id).toBe('a:150');
    expect(moments.some((m) => m.id === 'a:0')).toBe(false);
  });

  it('holds the cap when a whole burst arrives in one poll, not one at a time', () => {
    useFeed.getState().apply(Array.from({ length: 900 }, (_, n) => created(n)), OPTIONS);
    expect(useFeed.getState().moments.length).toBe(250);
  });

  it('never counts the same moment twice, however often it is reported', () => {
    for (let i = 0; i < 20; i++) useFeed.getState().apply([created(7)], OPTIONS);
    expect(useFeed.getState().moments.length).toBe(1);
  });

  it('updates a moment in place rather than adding another', () => {
    useFeed.getState().apply([created(1)], OPTIONS);
    const corrected: AlertChange = { type: 'updated', alert: { ...alertAt(1), revision: 2, status: 'withdrawn', title: 'Score 1 withdrawn' } };
    useFeed.getState().apply([corrected], OPTIONS);
    const moments = useFeed.getState().moments;
    expect(moments.length).toBe(1);
    expect(moments[0].title).toBe('Score 1 withdrawn');
  });
});
