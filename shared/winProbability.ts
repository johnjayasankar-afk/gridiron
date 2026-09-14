/**
 * Win probability for meters and charts, from the provider's reported values only.
 * Nothing here estimates a chance: it picks, orders and positions what the provider's
 * model reported after each play. The chart's x axis is the game clock, shared with
 * the game flow chart.
 */
import { gameAxis, type FlowPeriod } from './gameFlow.js';
import type { GameDetail, GameSummary, MatchupPredictor, WinProbability, WinProbabilityPoint } from './model.js';

export interface ProbabilityPoint {
  /** Position across the game, 0 to 1. */
  x: number;
  /** Home team's chance after this play, 0 to 1. */
  home: number;
  tie: number;
  playId: string;
  /** The play's order in the detail, when the play is known. */
  order: number | null;
  /** "Q3 4:12". */
  label: string;
  description: string | null;
  /** Change in the home team's chance since the previous point; null for the first. */
  swing: number | null;
}

export interface ProbabilitySeries {
  points: ProbabilityPoint[];
  periods: FlowPeriod[];
  /** Up to five of the biggest swings of at least 10 points, in game order. */
  swings: ProbabilityPoint[];
}

const MIN_SWING = 0.1;

/** The chart series: one point per reported value, placed at its play's clock. Null with fewer than two values. */
export function winProbabilitySeries(summary: GameSummary, detail: GameDetail): ProbabilitySeries | null {
  const reported = detail.winProbability ?? [];
  if (reported.length < 2) return null;
  const plays = new Map(detail.plays.map((p) => [p.id, p]));
  const axis = gameAxis(summary, detail.plays);
  const perPeriod = new Map<number, number>();
  for (const p of detail.plays) if (p.period !== null) perPeriod.set(p.period, (perPeriod.get(p.period) ?? 0) + 1);
  const seen = new Map<number, number>();

  const points: ProbabilityPoint[] = [];
  for (const entry of reported) {
    const play = plays.get(entry.playId) ?? null;
    const prev = points[points.length - 1] ?? null;
    let x = prev?.x ?? 0;
    let label = prev?.label ?? 'Kickoff';
    if (play && play.period !== null) {
      const index = seen.get(play.period) ?? 0;
      seen.set(play.period, index + 1);
      const at = axis.at(play.period, play.clock, index, perPeriod.get(play.period) ?? 1);
      if (at !== null) x = Math.max(prev?.x ?? 0, at);
      label = [axis.label(play.period), play.clock].filter(Boolean).join(' ');
    }
    points.push({ x, home: entry.home, tie: entry.tie, playId: entry.playId, order: play?.order ?? null, label, description: play?.description ?? null, swing: prev ? entry.home - prev.home : null });
  }

  const swings = points
    .filter((p) => p.swing !== null && Math.abs(p.swing) >= MIN_SWING)
    .sort((a, b) => Math.abs(b.swing as number) - Math.abs(a.swing as number))
    .slice(0, 5)
    .sort((a, b) => a.x - b.x || (a.order ?? 0) - (b.order ?? 0));
  return { points, periods: axis.periods, swings };
}

/**
 * The latest win probability for a game: the summary's value when it is for the latest
 * reported play and the detail has not caught up, otherwise the detail's last value.
 */
export function currentWinProbability(game: GameSummary, detail: GameDetail | null): WinProbability | null {
  const fromSummary = game.winProbability ?? null;
  const series = detail?.winProbability ?? [];
  const last = series[series.length - 1];
  const fromDetail: WinProbability | null = last ? { home: last.home, tie: last.tie, playId: last.playId, source: fromSummary?.source ?? 'ESPN' } : null;
  if (!fromDetail || !fromSummary) return fromDetail ?? fromSummary;
  const latestPlay = game.situation?.lastPlay?.id ?? null;
  return fromSummary.playId !== null && fromSummary.playId === latestPlay && fromDetail.playId !== latestPlay ? fromSummary : fromDetail;
}

/** The value after a given play, with the change that play made. */
export function probabilityAtPlay(detail: GameDetail, playId: string): (WinProbabilityPoint & { swing: number | null }) | null {
  const series = detail.winProbability ?? [];
  const i = series.findIndex((p) => p.playId === playId);
  if (i < 0) return null;
  return { ...series[i], swing: i > 0 ? series[i].home - series[i - 1].home : null };
}

/** The change the latest reported play made to the home team's chance. */
export function lastSwing(detail: GameDetail | null): number | null {
  const series = detail?.winProbability ?? [];
  return series.length >= 2 ? series[series.length - 1].home - series[series.length - 2].home : null;
}

/** The home team's share of the matchup predictor, scaled so the two sides add up to 1. */
export function predictorShare(predictor: MatchupPredictor): number | null {
  const sum = predictor.home + predictor.away;
  return sum > 0 ? predictor.home / sum : null;
}
