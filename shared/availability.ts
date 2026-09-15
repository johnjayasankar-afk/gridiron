/**
 * Whether a league's games are known. A feed that has never answered for a day
 * leaves its games unknown, not absent, so no screen may say "no games" for it.
 */
import type { Freshness, LeagueId } from './model.js';

/** The provider has not answered for this day at all, so nothing about its games is known. */
export function feedUnknown(freshness: Freshness | null | undefined): boolean {
  return !!freshness && freshness.health === 'unavailable' && !freshness.lastSuccessAt;
}

/** The leagues in view whose games are unknown, in the order given. */
export function unknownLeagues(freshness: Partial<Record<LeagueId, Freshness>> | null | undefined, leagues: readonly LeagueId[]): LeagueId[] {
  return leagues.filter((l) => feedUnknown(freshness?.[l]));
}

/** Whether any feed in a slate is unknown, for callers that do not filter by league. */
export function anyFeedUnknown(freshness: Partial<Record<LeagueId, Freshness>> | null | undefined): boolean {
  return Object.values(freshness ?? {}).some((f) => feedUnknown(f));
}

const NAMES: Record<LeagueId, string> = { nfl: 'NFL', cfb: 'college' };

/** "NFL", "college" or "NFL and college", capitalized to start a sentence. */
export function leagueNames(leagues: readonly LeagueId[], capitalized = false): string {
  const text = leagues.map((l) => NAMES[l]).join(' and ');
  return capitalized ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
