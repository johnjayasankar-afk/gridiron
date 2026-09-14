/**
 * Notices when the viewer comes back and prepares "While you were away".
 *
 * A snapshot of every game (score, status, last play seen) is taken when the tab
 * is hidden and, for live data, every minute. Coming back after a few minutes, or
 * opening Gridiron again the same day, compares the snapshot with what has been
 * reported since. Replay sessions compare only within the same session.
 */
import { useEffect } from 'react';
import { buildDigest, takeDigestSnapshot, type DigestSnapshot } from '../../shared/digest';
import type { GameDetail, GameId } from '../../shared/model';
import { useDigest } from '../state/digest';
import { useLive, type Source, type World } from '../state/live';
import { usePrefs } from '../state/prefs';
import { slateGames } from '../state/selectors';

const STORAGE_KEY = 'gridiron.digest.v1';
/** Time away before a digest is offered. */
export const DIGEST_MIN_AWAY_MS = 4 * 60_000;
const MAX_AGE_MS = 12 * 3_600_000;
/** After opening, wait for play-by-play to load so the digest can name plays. */
const SETTLE_MS = 6000;

declare global {
  interface Window {
    /** Test hook: shortens the time away before a digest is offered. */
    __gridironDigestMinAwayMs?: number;
    /** Diagnostics used by the verification suite. */
    __gridironDigestState?: () => { memory: number | null; pending: number | null; hiddenAt: number | null; key: string | null; shown: boolean };
  }
}

interface KeyedSnapshot extends DigestSnapshot {
  key: string;
}

const minAway = () => window.__gridironDigestMinAwayMs ?? DIGEST_MIN_AWAY_MS;

function sourceKey(): string | null {
  const live = useLive.getState();
  const world = live.presented.world;
  if (!world.date) return null;
  return live.source.kind === 'live' ? `live|${world.date}` : `replay|${live.source.sessionId}|${world.date}`;
}

const detailsOf = (world: World): Record<GameId, GameDetail | null> => Object.fromEntries(Object.entries(world.details).map(([id, d]) => [id, d.detail]));

/** A reconnect to the same live feed or replay session is not a new source. */
const sourceIdentity = (source: Source) => (source.kind === 'live' ? 'live' : `replay|${source.sessionId}`);

export function useDigestDriver() {
  useEffect(() => {
    let memory: KeyedSnapshot | null = null;
    let hiddenAt: number | null = null;
    let pending: KeyedSnapshot | null = null;
    /** The pending snapshot came from an earlier visit, so wait for play-by-play before comparing. */
    let pendingFromStorage = false;
    let readySince: number | null = null;

    const snapshot = (): KeyedSnapshot | null => {
      const presented = useLive.getState().presented;
      const key = sourceKey();
      if (presented.status !== 'ready' || !presented.world.loaded || !key) return null;
      const world = presented.world;
      return { ...takeDigestSnapshot(slateGames(world), detailsOf(world), Date.now()), key };
    };

    const persist = (s: KeyedSnapshot) => {
      if (useLive.getState().source.kind !== 'live') return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      } catch {
        /* storage is optional */
      }
    };

    const tryPending = () => {
      if (!pending) return;
      const presented = useLive.getState().presented;
      if (presented.status !== 'ready' || !presented.world.loaded) return;
      if (readySince === null) readySince = Date.now();
      if (pendingFromStorage && Date.now() - readySince < SETTLE_MS) return;
      const base = pending;
      pending = null;
      pendingFromStorage = false;
      if (base.key !== sourceKey()) return;
      const world = presented.world;
      const digest = buildDigest(base, slateGames(world), detailsOf(world), { bigPlayYards: usePrefs.getState().alertRules.bigPlayYards });
      if (digest.entries.length) useDigest.getState().show(digest);
    };

    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as KeyedSnapshot | null;
      if (stored && typeof stored.at === 'number' && typeof stored.key === 'string' && stored.games) {
        const age = Date.now() - stored.at;
        if (age >= minAway() && age <= MAX_AGE_MS) {
          pending = stored;
          pendingFromStorage = true;
        }
      }
    } catch {
      /* ignore a malformed snapshot */
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // A repeated hidden event keeps the first snapshot: the summary starts from when the viewer left.
        if (hiddenAt !== null) return;
        hiddenAt = Date.now();
        memory = snapshot();
        if (memory) persist(memory);
      } else if (hiddenAt !== null) {
        const away = Date.now() - hiddenAt;
        hiddenAt = null;
        if (away >= minAway() && memory) {
          pending = memory;
          pendingFromStorage = false;
          memory = null;
          tryPending();
        }
      }
    };

    window.__gridironDigestState = () => ({ memory: memory?.at ?? null, pending: pending?.at ?? null, hiddenAt, key: sourceKey(), shown: useDigest.getState().digest !== null });
    document.addEventListener('visibilitychange', onVisibility);
    const offLive = useLive.subscribe((s, p) => {
      if (s.presented !== p.presented) tryPending();
      if (sourceIdentity(s.source) !== sourceIdentity(p.source)) {
        pending = null;
        pendingFromStorage = false;
        memory = null;
        readySince = null;
        useDigest.getState().dismiss();
      }
    });
    const timer = setInterval(() => {
      tryPending();
      if (document.visibilityState === 'visible') {
        const s = snapshot();
        if (s) persist(s);
      }
    }, 60_000);
    const settleTimer = setInterval(tryPending, 2000);
    tryPending();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      delete window.__gridironDigestState;
      offLive();
      clearInterval(timer);
      clearInterval(settleTimer);
    };
  }, []);
}
