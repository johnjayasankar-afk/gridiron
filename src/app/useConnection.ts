/**
 * Chooses the data source (live, or a replay lab session from ?replay=), keeps
 * the server told what this tab needs (day, divisions, focused, visible and
 * monitored games), and applies the spoiler delay.
 */
import { useEffect, useRef } from 'react';
import { isDateKey } from '../../shared/util';
import { replayApi } from '../data/api';
import type { Interest } from '../data/transport';
import { useLive } from '../state/live';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { useLocation, type Route } from './router';

function favoriteGameIds(): string[] {
  const favorites = new Set(usePrefs.getState().favorites.map((f) => f.key));
  if (!favorites.size) return [];
  return Object.values(useLive.getState().world.games)
    .filter((g) => favorites.has(g.home.key) || favorites.has(g.away.key))
    .map((g) => g.id);
}

export function buildInterest(route: Route): Interest {
  const p = usePrefs.getState();
  const ui = useUi.getState();
  const focus = route.name === 'game' ? [route.id] : route.name === 'focus' ? p.focusGames.slice(0, 4) : [];
  return {
    date: p.dayMode === 'date' ? p.date : null,
    divisions: p.divisions,
    focus,
    visible: ui.visible.slice(0, 64),
    monitored: [...new Set([...p.pinned, ...p.focusGames, ...favoriteGameIds()])].slice(0, 64),
    alertsAllGames: p.alertRules.scope === 'all',
  };
}

export function useConnection() {
  const { route, params } = useLocation();
  const replay = params.get('replay');
  const routeRef = useRef(route);
  routeRef.current = route;

  // A date in the URL opens that day.
  const urlDate = params.get('date');
  useEffect(() => {
    if (isDateKey(urlDate) && (usePrefs.getState().dayMode !== 'date' || usePrefs.getState().date !== urlDate)) {
      usePrefs.getState().set({ dayMode: 'date', date: urlDate });
    }
  }, [urlDate]);

  const sessionNonce = useLive((s) => s.sessionNonce);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (replay) {
        try {
          // Optional start state for shareable demo links: ?replay=<scenario>&at=0.4&speed=30&paused=1
          const search = new URLSearchParams(window.location.search);
          const at = Number(search.get('at'));
          const speed = Number(search.get('speed'));
          const session = await replayApi.create(replay, {
            progress: search.has('at') && Number.isFinite(at) ? Math.min(1, Math.max(0, at)) : undefined,
            speed: search.has('speed') && Number.isFinite(speed) ? Math.min(600, Math.max(1, speed)) : undefined,
            playing: search.get('paused') === '1' ? false : undefined,
          });
          if (cancelled) return;
          await useLive.getState().connect({ kind: 'replay', sessionId: session.id, scenario: session.scenario, label: session.label }, buildInterest(routeRef.current));
        } catch (e) {
          if (!cancelled) {
            useLive.setState({ connection: { status: 'offline', transport: null, error: `The replay lab could not start: ${(e as Error).message}`, lastMessageAt: null } });
          }
        }
      } else {
        await useLive.getState().connect({ kind: 'live' }, buildInterest(routeRef.current));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replay, sessionNonce]);

  useEffect(() => {
    const push = () => useLive.getState().updateInterest(buildInterest(routeRef.current));
    const offPrefs = usePrefs.subscribe((s, p) => {
      if (s.dayMode !== p.dayMode || s.date !== p.date || s.divisions !== p.divisions || s.focusGames !== p.focusGames || s.pinned !== p.pinned || s.favorites !== p.favorites || s.alertRules.scope !== p.alertRules.scope) push();
    });
    const offUi = useUi.subscribe((s, p) => {
      if (s.visible !== p.visible) push();
    });
    const offLive = useLive.subscribe((s, p) => {
      if (s.world.date !== p.world.date || s.world.loaded !== p.world.loaded) push();
    });
    return () => {
      offPrefs();
      offUi();
      offLive();
    };
  }, []);

  useEffect(() => {
    useLive.getState().updateInterest(buildInterest(route));
  }, [route]);

  const dayMode = usePrefs((s) => s.dayMode);
  useEffect(() => {
    useLive.getState().followYesterday(dayMode === 'live' && !replay);
  }, [dayMode, replay]);

  const delaySeconds = usePrefs((s) => s.delaySeconds);
  useEffect(() => {
    useLive.getState().setDelay(delaySeconds * 1000);
  }, [delaySeconds]);
}
