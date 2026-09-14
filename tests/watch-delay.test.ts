import { describe, expect, it } from 'vitest';
import { PresentationBuffer, clampDelaySeconds } from '../shared/delay';
import { accessibleSummary, downDistance, situationLine, statusShort } from '../shared/format';
import type { GameSummary } from '../shared/model';
import { watchNext } from '../shared/watch';
import { game, situation } from './helpers/builders';

const late = (g: GameSummary, clock: string, seconds: number, period = 4): GameSummary => ({ ...g, status: { ...g.status, clock, clockSeconds: seconds, period } });
const ctx = (over: Partial<Parameters<typeof watchNext>[1]> = {}) => ({ favorites: [], recentMajor: new Map(), staleGames: new Set<string>(), now: 5_000_000, ...over });

describe('watch next', () => {
  it('orders games by explainable tiers', () => {
    const ot = game({ id: 'nfl-1', period: 5, home: 20, away: 20 });
    const close = late(game({ id: 'nfl-2', home: 17, away: 14, situation: situation({ possession: 'away', progress: 88 }) }), '2:14', 134);
    const redZone = game({ id: 'nfl-3', home: 10, away: 7, period: 2, situation: situation({ possession: 'away', progress: 90 }) });
    const fourth = game({ id: 'nfl-4', home: 0, away: 21, period: 2, situation: situation({ down: 4, distance: 3, progress: 40 }) });
    const blowout = game({ id: 'nfl-5', home: 42, away: 0, period: 3 });
    const list = watchNext([blowout, fourth, redZone, close, ot], ctx());
    expect(list.map((i) => i.gameId)).toEqual(['nfl-1', 'nfl-2', 'nfl-3', 'nfl-4']);
    expect(list[1].reasons.join(' · ')).toBe('3-point game · 2:14 left · AWY at opponent 12');
    expect(list[2].reasons.join(' · ')).toBe('AWY down 3 · offense at opponent 10');
  });

  it('never qualifies a game on a field it does not know', () => {
    const noClock = late(game({ id: 'nfl-6', home: 17, away: 14 }), '', 0);
    const unknownClock = { ...noClock, status: { ...noClock.status, clock: null, clockSeconds: null } };
    const noSpot = game({ id: 'nfl-7', home: 10, away: 7, period: 2, situation: situation({ possession: 'away', progress: null }) });
    const noScore = late(game({ id: 'nfl-8', home: null, away: null }), '1:00', 60);
    expect(watchNext([unknownClock, noSpot, noScore], ctx())).toEqual([]);
  });

  it('includes a recent major moment and favorites, and pushes stale games down with a reason', () => {
    const recent = game({ id: 'nfl-9', home: 28, away: 7, period: 3 });
    const fav = game({ id: 'nfl-10', home: 3, away: 24, period: 2 });
    const staleOt = game({ id: 'nfl-11', period: 5, home: 17, away: 17 });
    const list = watchNext([fav, recent, staleOt], ctx({
      recentMajor: new Map([['nfl-9', { at: 5_000_000 - 60_000, label: 'Touchdown' }]]),
      favorites: ['nfl-HOM'],
      staleGames: new Set(['nfl-11']),
    }));
    expect(list.map((i) => i.gameId)).toEqual(['nfl-9', 'nfl-10', 'nfl-11']);
    expect(list[0].reasons).toEqual(['Touchdown 1 min ago']);
    expect(list[2]).toMatchObject({ stale: true });
    expect(list[2].reasons).toContain('updates delayed');
  });

  it('ignores scheduled and final games', () => {
    expect(watchNext([game({ kind: 'scheduled' }), game({ kind: 'final', period: 5 })], ctx())).toEqual([]);
  });
});

describe('presentation buffer for the spoiler delay', () => {
  type World = { score: string; spot: number };

  it('shows the newest state received at least the delay ago, score and field together', () => {
    const b = new PresentationBuffer<World>();
    b.push({ score: '0-0', spot: 25 }, 0);
    b.push({ score: '7-0', spot: 100 }, 10_000);
    b.push({ score: '7-3', spot: 70 }, 40_000);
    expect(b.present(45_000, 0)).toMatchObject({ status: 'ready', state: { value: { score: '7-3', spot: 70 } } });
    const delayed = b.present(45_000, 30_000);
    expect(delayed).toMatchObject({ status: 'ready', state: { value: { score: '7-0', spot: 100 }, receivedAt: 10_000 } });
    expect(b.present(70_000, 30_000)).toMatchObject({ status: 'ready', state: { value: { score: '7-3', spot: 70 } } });
  });

  it('reports buffering honestly when earlier states were never received', () => {
    const b = new PresentationBuffer<World>();
    b.push({ score: '14-10', spot: 55 }, 100_000);
    expect(b.present(120_000, 60_000)).toEqual({ status: 'buffering', delayMs: 60_000, readyInMs: 40_000 });
    expect(b.present(160_000, 60_000)).toMatchObject({ status: 'ready' });
  });

  it('prunes old states but keeps one to answer the oldest delayed view', () => {
    const b = new PresentationBuffer<number>(60_000);
    for (let t = 0; t <= 200_000; t += 10_000) b.push(t, t);
    // 140s to 200s remain: the oldest kept entry sits exactly at the edge of the 60-second window
    expect(b.size).toBe(7);
    expect(b.at(140_000)?.value).toBe(140_000);
    expect(b.at(139_999)).toBeNull();
  });

  it('never lets receipt time run backwards', () => {
    const b = new PresentationBuffer<string>();
    b.push('a', 50);
    b.push('b', 40);
    expect(b.latest()).toEqual({ value: 'b', receivedAt: 50 });
    expect(clampDelaySeconds(9999)).toBe(300);
    expect(clampDelaySeconds(-5)).toBe(0);
  });
});

describe('formatting', () => {
  it('writes situations without inventing missing parts', () => {
    const g = game({ situation: situation({ possession: 'away', progress: 35, down: 3, distance: 7 }) });
    expect(situationLine(g)).toBe('AWY ball · 3rd & 7 · AWY 35');
    const unknown = game({ situation: situation({ possession: 'home', progress: null, down: 2, distance: 5 }) });
    expect(situationLine(unknown)).toBe('HOM ball · 2nd & 5 · Ball spot unavailable');
    expect(downDistance({ down: 1, distance: 5, goalToGo: true })).toBe('1st & Goal');
    expect(accessibleSummary(unknown)).toContain('the ball spot is unavailable');
  });

  it('labels overtime finals and pauses by status, not by a live flag', () => {
    expect(statusShort(game({ kind: 'final', period: 5 }).status)).toBe('Final/OT');
    expect(statusShort(game({ kind: 'final', period: 6 }).status)).toBe('Final/2OT');
    expect(statusShort(game({ kind: 'halftime', period: 2 }).status)).toBe('Halftime');
    expect(statusShort(game({ kind: 'delayed', period: 3 }).status)).toBe('Delayed · Q3');
    expect(statusShort(game({ kind: 'in_progress', period: 2, clock: '7:42' }).status)).toBe('Q2 7:42');
  });
});
