/**
 * For the honest empty state: the next day with scheduled kickoffs and the most
 * recent day with final results, read from the same server as everything else.
 * Only runs when the selected day has nothing live.
 */
import { useEffect, useState } from 'react';
import type { GameSummary, SlateSnapshot } from '../../shared/model';
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
  failed: boolean;
}

const cache = new Map<string, { at: number; snapshot: SlateSnapshot | null }>();
const TTL = 10 * 60_000;
const byKickoff = (a: GameSummary, b: GameSummary) => (a.startTime ?? '').localeCompare(b.startTime ?? '');

async function fetchDay(base: string, date: string): Promise<SlateSnapshot | null> {
  const key = `${base}|${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.snapshot;
  try {
    const snapshot = await getJson<SlateSnapshot>(`${base}/slate?date=${date}`);
    cache.set(key, { at: Date.now(), snapshot });
    return snapshot;
  } catch {
    cache.set(key, { at: Date.now() - TTL + 60_000, snapshot: null });
    return null;
  }
}

export function useLookaround(enabled: boolean, baseDate: string | null, options: { ahead: boolean; behind: boolean }): Lookaround {
  const source = useLive((s) => s.source);
  const [state, setState] = useState<Lookaround>({ loading: false, upcoming: null, recent: null, failed: false });
  const { ahead, behind } = options;

  useEffect(() => {
    if (!enabled || !baseDate || source.kind === 'replay') {
      setState({ loading: false, upcoming: null, recent: null, failed: false });
      return;
    }
    let cancelled = false;
    const base = '/api';
    setState((s) => ({ ...s, loading: true }));
    void (async () => {
      let upcoming: DayGames | null = null;
      let recent: DayGames | null = null;
      let failures = 0;
      if (ahead) {
        for (let i = 1; i <= 7 && !cancelled && !upcoming; i++) {
          const date = shiftDateKey(baseDate, i);
          const s = await fetchDay(base, date);
          if (!s) failures++;
          const games = (s?.games ?? []).filter((g) => g.status.kind === 'scheduled').sort(byKickoff);
          if (games.length) upcoming = { date, games: games.slice(0, 6) };
        }
      }
      if (behind) {
        for (let i = 1; i <= 3 && !cancelled && !recent; i++) {
          const date = shiftDateKey(baseDate, -i);
          const s = await fetchDay(base, date);
          if (!s) failures++;
          const games = (s?.games ?? []).filter((g) => g.status.kind === 'final');
          if (games.length) recent = { date, games: games.slice(0, 6) };
        }
      }
      if (!cancelled) setState({ loading: false, upcoming, recent, failed: failures > 0 && !upcoming && !recent });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, baseDate, source, ahead, behind]);

  return state;
}
