/**
 * The game as it stood at the play being looked at.
 *
 * Reported from a screenshot: stepping back to play 5 of 158 left the scoreboard
 * and the scorebug showing 35 to 14 beside a clock reading Q1 13:33, which is a
 * final score and a first quarter presented as one moment.
 */
import { describe, expect, it } from 'vitest';
import type { GameSummary } from '../shared/model';
import { gameAtFrame, type PlayFrame } from '../shared/replayFrames';
import { game, situation } from './helpers/builders';

const final = game({ id: 'nfl-1', kind: 'final', home: 14, away: 35, period: 4, clock: null });

const frame = (over: Partial<PlayFrame> = {}): PlayFrame =>
  ({
    play: { id: 'nfl-1:p5', order: 4, period: 1, clock: '13:33' },
    index: 4,
    total: 158,
    drive: null,
    situation: situation(),
    fromYard: null,
    toYard: null,
    score: { home: 0, away: 7 },
    ...over,
  }) as PlayFrame;

describe('looking at an earlier play', () => {
  it('shows the score as it was then, not the one the game finished at', () => {
    const shown = gameAtFrame(final, frame());
    expect(shown.score).toEqual({ home: 0, away: 7 });
    expect(final.score).toEqual({ home: 14, away: 35 });
  });

  it('shows the clock and the period of that play, and calls the game what it was then', () => {
    const shown = gameAtFrame(final, frame());
    expect(shown.status.kind).toBe('in_progress');
    expect(shown.status.period).toBe(1);
    expect(shown.status.clock).toBe('13:33');
  });

  it("drops the provider's status text, because it describes a moment that has not happened yet", () => {
    const withText = { ...final, status: { ...final.status, detail: 'Final' } };
    expect(gameAtFrame(withText, frame()).status.detail).toBeNull();
    // And the clock in seconds, which is not known for a past play and is worse stale than absent.
    expect(gameAtFrame(withText, frame()).status.clockSeconds).toBeNull();
  });

  it('carries the situation the play left behind', () => {
    expect(gameAtFrame(final, frame()).situation).not.toBeNull();
    expect(gameAtFrame(final, frame({ situation: null })).situation).toBeNull();
  });

  it('leaves everything that is a fact about the fixture rather than the moment', () => {
    const shown = gameAtFrame(final, frame());
    expect(shown.home).toBe(final.home);
    expect(shown.away).toBe(final.away);
    expect(shown.venue).toEqual(final.venue);
    expect(shown.broadcasts).toEqual(final.broadcasts);
    expect(shown.startTime).toBe(final.startTime);
  });
});

describe('the last play of a finished game', () => {
  it('is the final whistle and still says so', () => {
    const last = frame({ index: 157, score: { home: 14, away: 35 } });
    const shown = gameAtFrame(final, last);
    expect(shown.status.kind).toBe('final');
    expect(shown.score).toEqual({ home: 14, away: 35 });
  });

  it('is not the final whistle while the game is still going', () => {
    const live = game({ id: 'nfl-2', kind: 'in_progress', home: 3, away: 0 });
    const last = frame({ index: 157 });
    expect(gameAtFrame(live, last).status.kind).toBe('in_progress');
  });
});

describe('not looking at a play', () => {
  it('hands the game back exactly as it came, so live is untouched', () => {
    const live: GameSummary = game({ id: 'nfl-3', kind: 'in_progress' });
    expect(gameAtFrame(live, null)).toBe(live);
  });
});
