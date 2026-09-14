/**
 * Game flow: the reported score margin across game time, for a compact chart.
 *
 * The x axis is the game clock, not wall time. Regulation quarters are 15
 * minutes. Each overtime period is an equal segment: the NFL's overtime clock
 * places its moments (10 minutes in the regular season, longer when the reported
 * clock says so); college overtime has no clock, so its moments are spaced in the
 * order they were reported. Scoring plays without a reported score are left out.
 */
import type { GameStatus, GameSummary, ScoreEvent, Side } from './model.js';
import { isLiveOrPaused } from './model.js';
import { clockToSeconds, periodShort } from './util.js';

const QUARTER_SECONDS = 900;
const OVERTIME_UNITS = 600;

export interface FlowPoint {
  /** Position across the game, 0 to 1. */
  x: number;
  home: number;
  away: number;
  /** Home minus away. */
  margin: number;
  event: ScoreEvent | null;
  team: Side | null;
  /** "Q2 7:42", "OT", "Final". */
  label: string;
}

export interface FlowPeriod {
  x0: number;
  x1: number;
  label: string;
}

export interface FlowSeries {
  /** Starts at 0-0 and steps at each scoring play. */
  points: FlowPoint[];
  periods: FlowPeriod[];
  /** Where the game stands now: the live clock position, or the end for a final. Null before kickoff. */
  end: FlowPoint | null;
  /** Symmetric vertical extent, in points, rounded up to a multiple of 7 (at least 7). */
  extent: number;
}

interface Segment {
  period: number;
  start: number;
  units: number;
  label: string;
  clockLength: number | null;
}

/** The game clock as a 0 to 1 axis, shared by the game flow and win probability charts. */
export interface GameAxis {
  periods: FlowPeriod[];
  /** Position of a moment in `period`: by its clock where the period has one, otherwise `index` of `count` moments. Null outside the axis. */
  at(period: number, clock: string | null, index: number, count: number): number | null;
  /** Position of a reported status: the end of the period at a break, the live clock otherwise. Null when it has no period on the axis. */
  now(status: GameStatus): number | null;
  /** "Q2", "OT", for a period on the axis. */
  label(period: number): string | null;
}

/** An axis long enough for the game's status and every moment given; NFL overtime stretches to the longest clock reported in it. */
export function gameAxis(summary: GameSummary, moments: ReadonlyArray<{ period: number | null; clock: string | null }>): GameAxis {
  const regulation = summary.status.regulationPeriods;
  const placed = moments.filter((m): m is { period: number; clock: string | null } => m.period !== null);
  const lastPeriod = Math.max(regulation, summary.status.period ?? 0, ...placed.map((m) => m.period));

  const segments: Segment[] = [];
  let start = 0;
  for (let period = 1; period <= lastPeriod; period++) {
    const overtime = period > regulation;
    let clockLength: number | null = QUARTER_SECONDS;
    if (overtime) {
      if (summary.league === 'nfl') {
        const clocks = [...placed.filter((m) => m.period === period).map((m) => clockToSeconds(m.clock) ?? 0), summary.status.period === period ? (summary.status.clockSeconds ?? 0) : 0];
        clockLength = Math.max(OVERTIME_UNITS, ...clocks);
      } else clockLength = null;
    }
    const units = overtime ? OVERTIME_UNITS : QUARTER_SECONDS;
    segments.push({ period, start, units, label: periodShort(period, regulation) ?? `P${period}`, clockLength });
    start += units;
  }
  const total = start;

  const offsetIn = (segment: Segment, clock: string | null, index: number, count: number): number => {
    const seconds = clockToSeconds(clock);
    if (segment.clockLength !== null && seconds !== null) {
      const elapsed = Math.min(segment.clockLength, Math.max(0, segment.clockLength - seconds));
      return (elapsed / segment.clockLength) * segment.units;
    }
    return segment.units * ((index + 1) / (count + 1));
  };
  const segmentOf = (period: number) => segments.find((s) => s.period === period) ?? null;

  return {
    periods: segments.map((s) => ({ x0: s.start / total, x1: (s.start + s.units) / total, label: s.label })),
    at(period, clock, index, count) {
      const segment = segmentOf(period);
      return segment ? (segment.start + offsetIn(segment, clock, index, count)) / total : null;
    },
    now(status) {
      const segment = status.period === null ? null : segmentOf(status.period);
      if (!segment) return null;
      return status.kind === 'halftime' || status.kind === 'end_of_period' ? (segment.start + segment.units) / total : (segment.start + offsetIn(segment, status.clock, 0, 1)) / total;
    },
    label: (period) => segmentOf(period)?.label ?? null,
  };
}

export function gameFlow(summary: GameSummary, scoring: ScoreEvent[]): FlowSeries {
  const reported = scoring.filter((s) => s.scoreAfter.home !== null && s.scoreAfter.away !== null && s.period !== null);
  const axis = gameAxis(summary, reported);

  const points: FlowPoint[] = [{ x: 0, home: 0, away: 0, margin: 0, event: null, team: null, label: 'Kickoff' }];
  const periods = [...new Set(reported.map((s) => s.period as number))].sort((a, b) => a - b);
  for (const period of periods) {
    const inPeriod = reported.filter((s) => s.period === period);
    inPeriod.forEach((event, i) => {
      const home = event.scoreAfter.home as number;
      const away = event.scoreAfter.away as number;
      points.push({
        x: axis.at(period, event.clock, i, inPeriod.length) ?? 0,
        home,
        away,
        margin: home - away,
        event,
        team: event.team,
        label: [axis.label(period), event.clock].filter(Boolean).join(' '),
      });
    });
  }
  // Scores reported in the same instant keep their order; never step backwards in x.
  for (let i = 1; i < points.length; i++) points[i].x = Math.max(points[i].x, points[i - 1].x);

  let end: FlowPoint | null = null;
  const { home, away } = summary.score;
  const status = summary.status;
  if (home !== null && away !== null && status.kind !== 'scheduled' && status.kind !== 'postponed' && status.kind !== 'canceled') {
    if (status.kind === 'final') end = { x: 1, home, away, margin: home - away, event: null, team: null, label: 'Final' };
    else if (isLiveOrPaused(status.kind) && status.period !== null) {
      const x = axis.now(status);
      if (x !== null) {
        end = { x: Math.max(x, points[points.length - 1].x), home, away, margin: home - away, event: null, team: null, label: [axis.label(status.period), status.clock].filter(Boolean).join(' ') || 'Now' };
      }
    }
  }

  const biggest = Math.max(0, ...points.map((p) => Math.abs(p.margin)), end ? Math.abs(end.margin) : 0);
  return {
    points,
    periods: axis.periods,
    end,
    extent: Math.max(7, Math.ceil(biggest / 7) * 7),
  };
}

export interface FlowStats {
  leadChanges: number;
  /** Times a score tied the game, not counting kickoff. */
  ties: number;
  largestLead: Record<Side, number>;
}

/**
 * Lead changes, ties and each team's largest lead, read from the reported
 * scoring. A tie between two leaders still counts as one lead change. The
 * current score counts only when it differs from the last itemized score.
 */
export function flowStats(series: FlowSeries): FlowStats {
  const sequence = [...series.points];
  const last = sequence[sequence.length - 1];
  if (series.end && last && series.end.margin !== last.margin) sequence.push(series.end);
  let leadChanges = 0;
  let ties = 0;
  let leader = 0;
  const largestLead: Record<Side, number> = { home: 0, away: 0 };
  for (let i = 1; i < sequence.length; i++) {
    const margin = sequence[i].margin;
    const sign = Math.sign(margin);
    if (sign === 0) {
      if (sequence[i - 1].margin !== 0) ties++;
    } else {
      if (leader !== 0 && sign !== leader) leadChanges++;
      leader = sign;
    }
    largestLead.home = Math.max(largestLead.home, margin);
    largestLead.away = Math.max(largestLead.away, -margin);
  }
  return { leadChanges, ties, largestLead };
}
