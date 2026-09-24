/**
 * The sportsbook's line as it was seen over time.
 *
 * The provider reports a line twice: an opening one and a latest one, with
 * nothing between them and no times attached. That is two numbers, not a
 * history, which is why a game page could tell you the price a prediction market
 * traded at during any play and could not tell you the same about the book.
 *
 * So Gridiron keeps its own record: whenever the latest line it is given differs
 * from the one it last wrote down, that is a new point, stamped with when it was
 * seen. It is a record of what was reported to us and when, never an estimate of
 * what a book was offering at a moment nobody looked. Where the record says
 * nothing about a moment, the page says so rather than reaching for the nearest
 * number.
 */
import type { BettingLines, GameDetail, LineHistory, LinePoint } from './model.js';

/** Every number a reading carries. A change in any of them is a new reading. */
const FIGURES = ['spreadHome', 'spreadAway', 'spreadOddsHome', 'spreadOddsAway', 'total', 'totalOddsOver', 'totalOddsUnder', 'moneylineHome', 'moneylineAway'] as const satisfies readonly (keyof LinePoint)[];

/** Beyond this many points a game is pathological; the oldest go. */
export const MAX_LINE_POINTS = 240;

/** The numbers that move. Null throughout when the provider gave none of them. */
export function linePointFrom(lines: BettingLines | null | undefined, at: string): LinePoint | null {
  if (!lines) return null;
  const point: LinePoint = {
    at,
    spreadHome: lines.spread?.home.latest?.line ?? null,
    spreadAway: lines.spread?.away.latest?.line ?? null,
    spreadOddsHome: lines.spread?.home.latest?.odds ?? null,
    spreadOddsAway: lines.spread?.away.latest?.odds ?? null,
    total: lines.total?.over.latest?.line ?? null,
    totalOddsOver: lines.total?.over.latest?.odds ?? null,
    totalOddsUnder: lines.total?.under.latest?.odds ?? null,
    moneylineHome: lines.moneyline?.home.latest ?? null,
    moneylineAway: lines.moneyline?.away.latest ?? null,
  };
  /* A reading where the book quoted nothing is not a reading. */
  const empty = FIGURES.every((k) => point[k] === null);
  return empty ? null : point;
}

export function sameLine(a: LinePoint | null, b: LinePoint | null): boolean {
  if (!a || !b) return a === b;
  return FIGURES.every((k) => a[k] === b[k]);
}

/**
 * Adds a reading to the record, or returns the record unchanged when it says
 * nothing new. Returning the same object matters: everything downstream can then
 * skip its work when a poll brought the same line as the last one, which is what
 * most polls bring.
 */
export function recordLine(history: LineHistory | null, lines: BettingLines | null | undefined, at: string): LineHistory | null {
  const point = linePointFrom(lines, at);
  if (!point) return history;
  const provider = lines!.provider;
  if (!history) return { provider, points: [point], captured: false };
  const last = history.points[history.points.length - 1] ?? null;
  if (sameLine(last, point)) return history;
  const points = [...history.points, point];
  return { ...history, provider, points: points.length > MAX_LINE_POINTS ? points.slice(points.length - MAX_LINE_POINTS) : points };
}

export function sameLineHistory(a: LineHistory | null | undefined, b: LineHistory | null | undefined): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return a.provider === b.provider && a.points.length === b.points.length && sameLine(a.points[a.points.length - 1] ?? null, b.points[b.points.length - 1] ?? null);
}

export interface LineAtPlay {
  provider: string;
  point: LinePoint;
  /** How long before the play the line was seen. */
  ageSeconds: number;
  /** The reading standing at the play before this one, when there was one. */
  before: LinePoint | null;
}

/**
 * The line as it stood when a play happened: the last reading taken at or before
 * that play's wall-clock time, the same rule the exchange's price uses.
 *
 * A reading taken after the play is never used, because it was not known then,
 * and a play the provider gave no wall-clock time for cannot be placed at all.
 */
export function lineAtPlay(detail: GameDetail, playId: string): LineAtPlay | null {
  const history = detail.lineHistory;
  if (!history || !history.points.length) return null;
  const index = detail.plays.findIndex((p) => p.id === playId);
  if (index < 0) return null;
  const when = detail.plays[index].wallclock ? Date.parse(detail.plays[index].wallclock!) : Number.NaN;
  if (!Number.isFinite(when)) return null;

  const standing = (moment: number): LinePoint | null => {
    let found: LinePoint | null = null;
    for (const point of history.points) {
      const t = Date.parse(point.at);
      if (!Number.isFinite(t)) continue;
      if (t > moment) break;
      found = point;
    }
    return found;
  };

  const now = standing(when);
  if (!now) return null;
  let before: LinePoint | null = null;
  for (let i = index - 1; i >= 0; i--) {
    const earlier = detail.plays[i].wallclock ? Date.parse(detail.plays[i].wallclock!) : Number.NaN;
    if (!Number.isFinite(earlier)) continue;
    before = standing(earlier);
    break;
  }
  return { provider: history.provider, point: now, ageSeconds: Math.max(0, Math.round((when - Date.parse(now.at)) / 1000)), before: sameLine(before, now) ? null : before };
}

/** How far before a play the book was last heard from. */
function seenBefore(seconds: number): string {
  if (seconds < 90) return 'moments before this play';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min before this play`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour before this play' : `${hours} hours before this play`;
}

/**
 * What the sportsbook block is showing, in the words the page uses. The
 * distinction that matters is between a play the record covers, a play it does
 * not, and a game it was never kept for: the first two are about this game's
 * record, the last is about the provider reporting no line during a game at all.
 */
export function lineHeading(at: LineAtPlay | null, state: { inspecting: boolean; recorded: boolean; replay: boolean; final: boolean; live: boolean }): string {
  if (at) return `As reported ${seenBefore(at.ageSeconds)}`;
  if (state.inspecting) return state.recorded ? 'No line recorded at this play' : 'Opening and closing lines, not play by play';
  // A replay with a recording is showing the line that stood at the replay clock, which is not the line it closed at.
  if (state.replay) return state.recorded ? 'As recorded, at the replay clock' : 'Closing lines, as captured';
  if (state.final) return 'Closing lines';
  return state.live ? 'Latest lines reported' : 'Current lines';
}

/** One figure's readings over time, for drawing how it moved. */
export interface LineTrack {
  points: Array<{ at: string; value: number }>;
  first: number;
  last: number;
  /** Where it ended up against where it started, in points of line. */
  change: number;
}

/**
 * How one figure moved across the record: the home spread, or the total.
 *
 * Null with fewer than two readings, because one reading is a line and not a
 * movement, and null when nothing ever changed, because a flat line drawn as a
 * trend says a book was doing something it was not.
 */
export function lineTrack(history: LineHistory | null | undefined, figure: 'spreadHome' | 'total', until?: number): LineTrack | null {
  if (!history) return null;
  const points: LineTrack['points'] = [];
  for (const point of history.points) {
    const value = point[figure];
    if (value === null) continue;
    const at = Date.parse(point.at);
    if (!Number.isFinite(at) || (until !== undefined && at > until)) continue;
    points.push({ at: point.at, value });
  }
  if (points.length < 2) return null;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  if (points.every((p) => p.value === first)) return null;
  return { points, first, last, change: last - first };
}
