/**
 * For the honest empty state: the next day with scheduled kickoffs and the most
 * recent day with final results, read from the same server as everything else.
 * Only runs when the selected day has nothing live. A day whose feed never
 * answered counts as a failed lookup, never as a day without games.
 */
import { useEffect, useState } from 'react';
import { anyFeedUnknown, unknownLeagues } from '../../shared/availability';
import type { GameSummary, LeagueId, SlateSnapshot } from '../../shared/model';
import { shiftDateKey } from '../../shared/util';
import { getJson } from '../data/api';
import { useLive } from './live';

export interface DayGames {
  date: string;
  games: GameSummary[];
}

export interface Lookaround {
  loading: boolean;
  upcoming: DayGames | null;
  recent: DayGames | null;
  /** A day ahead could not be read, and none of the days read had kickoffs. */
  aheadFailed: boolean;
  /** A day behind could not be read, and none of the days read had results. */
  behindFailed: boolean;
}

const cache = new Map<string, { at: number; snapshot: SlateSnapshot | null }>();
const TTL = 10 * 60_000;
const RETRY = 60_000;
const IDLE: Lookaround = { loading: false, upcoming: null, recent: null, aheadFailed: false, behindFailed: false };
const byKickoff = (a: GameSummary, b: GameSummary) => (a.startTime ?? '').localeCompare(b.startTime ?? '');

async function fetchDay(base: string, date: string): Promise<SlateSnapshot | null> {
  const key = `${base}|${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.snapshot;
  try {
    const snapshot = await getJson<SlateSnapshot>(`${base}/slate?date=${date}`);
    // a day the provider did not answer for is asked again in a minute, not kept for ten
    cache.set(key, { at: anyFeedUnknown(snapshot.freshness) ? Date.now() - TTL + RETRY : Date.now(), snapshot });
    return snapshot;
  } catch {
    cache.set(key, { at: Date.now() - TTL + RETRY, snapshot: null });
    return null;
  }
}

export function useLookaround(enabled: boolean, baseDate: string | null, options: { ahead: boolean; behind: boolean; leagues: readonly LeagueId[] }): Lookaround {
  const source = useLive((s) => s.source);
  const [state, setState] = useState<Lookaround>(IDLE);
  const { ahead, behind } = options;
  const leagueKey = options.leagues.join(',');

  useEffect(() => {
    if (!enabled || !baseDate || source.kind === 'replay') {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    const base = '/api';
    const leagues = leagueKey.split(',').filter(Boolean) as LeagueId[];
    setState((s) => ({ ...s, loading: true }));
    void (async () => {
      let upcoming: DayGames | null = null;
      let recent: DayGames | null = null;
      let aheadMisses = 0;
      let behindMisses = 0;
      if (ahead) {
        for (let i = 1; i <= 7 && !cancelled && !upcoming; i++) {
          const date = shiftDateKey(baseDate, i);
          const s = await fetchDay(base, date);
          const games = (s?.games ?? []).filter((g) => g.status.kind === 'scheduled').sort(byKickoff);
          if (games.length) upcoming = { date, games: games.slice(0, 6) };
          else if (!s || unknownLeagues(s.freshness, leagues).length) aheadMisses++;
        }
      }
      if (behind) {
        for (let i = 1; i <= 3 && !cancelled && !recent; i++) {
          const date = shiftDateKey(baseDate, -i);
          const s = await fetchDay(base, date);
          const games = (s?.games ?? []).filter((g) => g.status.kind === 'final');
          if (games.length) recent = { date, games: games.slice(0, 6) };
          else if (!s || unknownLeagues(s.freshness, leagues).length) behindMisses++;
        }
      }
      if (!cancelled) setState({ loading: false, upcoming, recent, aheadFailed: !upcoming && aheadMisses > 0, behindFailed: !recent && behindMisses > 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, baseDate, source, ahead, behind, leagueKey]);

  return state;
}
