/**
 * Situation helpers shared by the server, the replay lab and the client.
 */
import type { GameDetail, GameSummary, PlayEvent, Situation, Team } from './model.js';
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
/**
 * A team as the newest report describes it, keeping the branding that report left
 * out.
 *
 * The provider does not put the same fields on a team in every payload: a
 * scoreboard carries no logo variants at all, while the richer reports carry a
 * dark one. Taking the newest team wholesale meant each poll erased what the
 * other had found, and a logo flicked between its two addresses every few
 * seconds, reloading the image each time.
 *
 * Only branding is kept this way. A name, a colour and a logo are what a team IS
 * and cannot become unknown; a rank and a record are statements about how it is
 * doing, which can change to nothing, so a report that leaves those out is
 * allowed to clear them.
 */
export function mergeTeam(prev: Team, next: Team): Team {
  if (prev.key !== next.key) return next;
  const same =
    next.logo === (next.logo ?? prev.logo) &&
    next.logoDark === (next.logoDark ?? prev.logoDark) &&
    next.color === (next.color ?? prev.color) &&
    next.alternateColor === (next.alternateColor ?? prev.alternateColor) &&
    next.location === (next.location ?? prev.location) &&
    next.conferenceId === (next.conferenceId ?? prev.conferenceId);
  if (same) return next;
  return {
    ...next,
    logo: next.logo ?? prev.logo,
    logoDark: next.logoDark ?? prev.logoDark,
    color: next.color ?? prev.color,
    alternateColor: next.alternateColor ?? prev.alternateColor,
    location: next.location ?? prev.location,
    conferenceId: next.conferenceId ?? prev.conferenceId,
  };
}

export function mergeSummaries(prev: GameSummary, next: GameSummary): GameSummary {
  const prevAt = prev.receivedAt ?? 0;
  const nextAt = next.receivedAt ?? 0;
  if (nextAt < prevAt) return prev;
  const keepSituation = next.situation === null && isLiveOrPaused(next.status.kind) && prev.situation !== null;
  const situation = keepSituation ? prev.situation : next.situation;
  const heldProbability = prev.winProbability;
  return {
    ...next,
    home: mergeTeam(prev.home, next.home),
    away: mergeTeam(prev.away, next.away),
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
    /*
     * A venue's own facts survive a report that left them out, the same rule the
     * teams' branding follows: the summary payload names a venue without its id,
     * its roof or its surface, and taking it wholesale would throw away what the
     * scoreboard and the venue document had already found.
     */
    venue:
      next.venue && prev.venue && next.venue.name === prev.venue.name
        ? { ...next.venue, id: next.venue.id ?? prev.venue.id, indoor: next.venue.indoor ?? prev.venue.indoor, grass: next.venue.grass ?? prev.venue.grass, image: next.venue.image ?? prev.venue.image, capacity: next.venue.capacity ?? prev.venue.capacity }
        : (next.venue ?? prev.venue),
    weather: next.weather ?? prev.weather,
    coverage: next.source === 'summary' && prev.coverage.level !== 'unknown' && next.coverage.level === 'unknown' ? prev.coverage : next.coverage,
  };
}
