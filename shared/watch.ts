/**
 * "Watch next": a deterministic, explainable ranking of games worth opening.
 *
 * Each game is placed in the highest tier whose conditions are all KNOWN to be
 * true. A missing clock, spot or score cannot qualify a game. Stale games are
 * pushed below fresh ones and say why. No probabilities, no invented scores.
 */
import type { GameId, GameSummary, TeamKey } from './model.js';
import { isLiveOrPaused } from './model.js';
import { describeProgress } from './field.js';
import { downDistance, margin, teamFor } from './format.js';

export interface WatchContext {
  favorites: TeamKey[];
  /** Presentation time of the most recent major moment per game (touchdown, turnover, lead change). */
  recentMajor: Map<GameId, { at: number; label: string }>;
  staleGames: Set<GameId>;
  now: number;
  closeMargin?: number;
  lateSeconds?: number;
  recentWindowMs?: number;
}

export interface WatchItem {
  gameId: GameId;
  tier: number;
  label: string;
  reasons: string[];
  stale: boolean;
}

export const WATCH_TIERS = [
  'Overtime',
  'One-score game late',
  'Tying or go-ahead chance in the red zone',
  'Fourth down',
  'Just happened',
  'Favorite team',
] as const;

export function watchNext(games: GameSummary[], ctx: WatchContext): WatchItem[] {
  const closeMargin = ctx.closeMargin ?? 8;
  const lateSeconds = ctx.lateSeconds ?? 300;
  const recentWindow = ctx.recentWindowMs ?? 3 * 60_000;
  const items: Array<WatchItem & { sort: [number, number, number, string] }> = [];

  for (const g of games) {
    if (!isLiveOrPaused(g.status.kind)) continue;
    const st = g.status;
    const m = margin(g);
    const reasons: string[] = [];
    let tier = -1;
    const sit = g.situation;
    const regulation = st.regulationPeriods;
    const inOT = st.period !== null && st.period > regulation;
    const late = st.period === regulation && st.clockSeconds !== null && st.clockSeconds <= lateSeconds && st.kind === 'in_progress';
    const offense = sit ? teamFor(g, sit.possession) : null;
    const offenseMargin =
      sit?.possession && g.score.home !== null && g.score.away !== null
        ? (sit.possession === 'home' ? g.score.home - g.score.away : g.score.away - g.score.home)
        : null;
    const spotKnown = sit !== null && sit.spot.progress !== null;

    if (inOT) {
      tier = 0;
      reasons.push(st.period! - regulation === 1 ? 'Overtime' : `${st.period! - regulation} overtimes`);
      if (m !== null) reasons.push(m === 0 ? 'Tied' : `${m}-point game`);
    } else if (late && m !== null && m <= closeMargin) {
      tier = 1;
      reasons.push(m === 0 ? 'Tied' : `${m}-point game`, `${st.clock} left`);
      if (spotKnown && offense) reasons.push(`${offense.abbreviation} at ${describeProgress(sit!.spot.progress!)}`);
    } else if (spotKnown && sit!.spot.progress! >= 80 && offenseMargin !== null && offenseMargin <= 0 && offenseMargin >= -closeMargin) {
      tier = 2;
      reasons.push(offenseMargin === 0 ? 'Tied' : `${offense?.abbreviation ?? 'Offense'} down ${-offenseMargin}`, `offense at ${describeProgress(sit!.spot.progress!)}`);
    } else if (sit?.down === 4) {
      tier = 3;
      reasons.push(`${offense?.abbreviation ?? 'Offense'} faces ${downDistance(sit) ?? '4th down'}`);
      if (spotKnown) reasons.push(`at ${describeProgress(sit.spot.progress!)}`);
    } else if (ctx.recentMajor.has(g.id) && ctx.now - ctx.recentMajor.get(g.id)!.at <= recentWindow) {
      tier = 4;
      const r = ctx.recentMajor.get(g.id)!;
      const mins = Math.max(0, Math.round((ctx.now - r.at) / 60_000));
      reasons.push(`${r.label} ${mins === 0 ? 'just now' : `${mins} min ago`}`);
    } else if (ctx.favorites.includes(g.home.key) || ctx.favorites.includes(g.away.key)) {
      tier = 5;
      reasons.push('Favorite team');
    }
    if (tier < 0) continue;

    const stale = ctx.staleGames.has(g.id);
    if (stale) reasons.push('updates delayed');
    items.push({
      gameId: g.id,
      tier: stale ? tier + 10 : tier,
      label: WATCH_TIERS[tier],
      reasons,
      stale,
      sort: [stale ? tier + 10 : tier, m ?? 99, st.clockSeconds ?? 9999, `${g.startTime ?? ''}|${g.id}`],
    });
  }

  items.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2] || a.sort[3].localeCompare(b.sort[3]));
  return items.map(({ sort: _sort, ...item }) => item);
}
