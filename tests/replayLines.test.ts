/**
 * The sportsbook's line inside a replay.
 *
 * The exchange can be asked after the fact what a contract traded at during a
 * past game, so its history is captured from Kalshi's own endpoint. A book's
 * line cannot: the provider reports an opening line and a closing one, and its
 * line-movement collection exists and is always empty. So a replay can only show
 * a line at a play for a game something was watching at the time, and what it
 * was watching wrote down readings in the shape these tests use.
 */
import { describe, expect, it } from 'vitest';
import { lineHistoryAt, linesAt, type GameTimeline } from '../server/replay/timeline';
import type { LinePoint } from '../shared/model';

const at = (hhmm: string) => `2026-09-13T${hhmm}:00.000Z`;
const t = (hhmm: string) => Date.parse(at(hhmm));

const point = (when: string, spread: number, total: number, home: number, away: number): LinePoint => ({
  at: at(when),
  spreadHome: spread,
  spreadAway: -spread,
  spreadOddsHome: -110,
  spreadOddsAway: -110,
  total,
  totalOddsOver: -110,
  totalOddsUnder: -110,
  moneylineHome: home,
  moneylineAway: away,
});

/** Only the recording matters here, so the rest of a timeline is left empty. */
const timeline = (points: LinePoint[]): GameTimeline => ({ lines: points.length ? { provider: 'Book', points } : null }) as GameTimeline;

const recording = [point('16:00', -3.5, 47.5, -180, 155), point('17:05', -6.5, 45.5, -260, 215), point('18:10', -10.5, 44.5, -600, 440)];

describe('a recorded line, replayed', () => {
  it('shows the line that stood at the replay clock, not the one it closed at', () => {
    const tl = timeline(recording);
    expect(linesAt(tl, t('16:30'))!.spread!.home.latest).toEqual({ line: -3.5, odds: -110 });
    expect(linesAt(tl, t('17:30'))!.spread!.home.latest).toEqual({ line: -6.5, odds: -110 });
    expect(linesAt(tl, t('19:00'))!.spread!.home.latest).toEqual({ line: -10.5, odds: -110 });
  });

  it('carries the whole table, both sides, as the book had it then', () => {
    const lines = linesAt(timeline(recording), t('17:30'))!;
    expect(lines.provider).toBe('Book');
    expect(lines.favorite).toBe('home');
    expect(lines.spread!.away.latest).toEqual({ line: 6.5, odds: -110 });
    expect(lines.moneyline).toEqual({ home: { open: -180, latest: -260 }, away: { open: 155, latest: 215 } });
    expect(lines.total!.over.latest).toEqual({ line: 45.5, odds: -110 });
    expect(lines.total!.under.latest).toEqual({ line: 45.5, odds: -110 });
  });

  it('calls the first reading the opening line, because it is the earliest the record can speak to', () => {
    const lines = linesAt(timeline(recording), t('19:00'))!;
    expect(lines.spread!.home.open).toEqual({ line: -3.5, odds: -110 });
    expect(lines.moneyline!.home.open).toBe(-180);
  });

  it('has nothing before the first reading, as live', () => {
    expect(linesAt(timeline(recording), t('15:00'))).toBeNull();
    expect(linesAt(timeline([]), t('19:00'))).toBeNull();
  });
});

describe('the record a replayed page rewinds', () => {
  it('is cut at the replay clock, so a replay stops where a live session would have', () => {
    const tl = timeline(recording);
    expect(lineHistoryAt(tl, t('16:30'))!.points).toHaveLength(1);
    expect(lineHistoryAt(tl, t('17:30'))!.points).toHaveLength(2);
    expect(lineHistoryAt(tl, t('19:00'))!.points).toHaveLength(3);
    expect(lineHistoryAt(tl, t('15:00'))).toBeNull();
  });

  it('is marked as captured, so the page can say the recording is not this session\'s', () => {
    expect(lineHistoryAt(timeline(recording), t('19:00'))!.captured).toBe(true);
    expect(lineHistoryAt(timeline(recording), t('19:00'))!.provider).toBe('Book');
  });

  it('has nothing to say for a scenario nothing was recording for', () => {
    expect(lineHistoryAt(timeline([]), t('19:00'))).toBeNull();
  });
});
