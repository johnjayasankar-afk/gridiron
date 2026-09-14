/**
 * Situation helpers shared by the server, the replay lab and the client.
 */
import type { GameDetail, GameSummary, PlayEvent, Situation } from './model.js';
import { ADMIN_KINDS, isLiveOrPaused } from './model.js';

/**
 * The latest reported situation that can be read from play-by-play: the state
 * at the end of the most recent snap. Marked as a post-play spot so the UI can
 * say it is the last known position, not a live pre-snap report.
 */
export function situationFromPlays(plays: PlayEvent[], upToOrder = Number.POSITIVE_INFINITY): Situation | null {
  for (let i = plays.length - 1; i >= 0; i--) {
    const p = plays[i];
    if (p.order > upToOrder || ADMIN_KINDS.has(p.kind) || !p.end) continue;
    const spot = p.end.spot;
    return {
      possession: spot.offense,
      down: p.end.down,
      distance: p.end.distance,
      goalToGo: p.end.goalToGo,
      downDistanceText: p.end.downDistanceText,
      spot,
      isRedZone: spot.progress === null ? null : spot.progress >= 80,
      timeouts: { home: null, away: null },
      lastPlay: { id: p.id, kind: p.kind, description: p.description, yards: p.yards, team: p.offense },
    };
  }
  return null;
}

/** A detail's summary with a situation filled from its plays when the provider gave none. */
export function withDerivedSituation(detail: GameDetail): GameDetail {
  if (detail.summary.situation || !isLiveOrPaused(detail.summary.status.kind)) return detail;
  const situation = situationFromPlays(detail.plays);
  return situation ? { ...detail, summary: { ...detail.summary, situation } } : detail;
}

/**
 * Merge two reports of the same game. The one received later wins, except that
 * a newer report without a situation does not erase a known situation while the
 * game is still live.
 */
export function mergeSummaries(prev: GameSummary, next: GameSummary): GameSummary {
  const prevAt = prev.receivedAt ?? 0;
  const nextAt = next.receivedAt ?? 0;
  if (nextAt < prevAt) return prev;
  const keepSituation = next.situation === null && isLiveOrPaused(next.status.kind) && prev.situation !== null;
  const situation = keepSituation ? prev.situation : next.situation;
  const heldProbability = prev.winProbability;
  return {
    ...next,
    divisions: next.source === 'summary' || next.divisions.length === 0 ? prev.divisions : next.divisions,
    situation,
    // Lines and the pre-game prediction change rarely, so a report without them does not erase them.
    lines: next.lines ?? prev.lines,
    predictor: next.predictor ?? prev.predictor,
    // A win probability belongs to a play: an older one is kept only while the newer report is still at that play.
    winProbability: next.winProbability ?? (heldProbability?.playId && heldProbability.playId === situation?.lastPlay?.id ? heldProbability : undefined),
    // Market prices come from the Gridiron server, not the provider, so a provider report never carries or erases them.
    market: next.market !== undefined ? next.market : prev.market,
    broadcasts: next.broadcasts.length ? next.broadcasts : prev.broadcasts,
    notes: next.notes.length ? next.notes : prev.notes,
    links: { gamePage: next.links.gamePage ?? prev.links.gamePage },
    venue: next.venue ?? prev.venue,
    coverage: next.source === 'summary' && prev.coverage.level !== 'unknown' && next.coverage.level === 'unknown' ? prev.coverage : next.coverage,
  };
}
