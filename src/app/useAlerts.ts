/**
 * Runs the alert engine against the PRESENTED world, so alerts respect the
 * spoiler delay, then feeds the moments rail, toasts, badges, sound,
 * notifications and the screen-reader announcement.
 */
import { useEffect } from 'react';
import { AlertEngine, type AlertChange } from '../../shared/alerts';
import type { GameId } from '../../shared/model';
import { isLiveOrPaused } from '../../shared/model';
import { playChime } from '../lib/sound';
import { useFeed, type Toast } from '../state/feed';
import { useLive, type Presented, type Source, type World } from '../state/live';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { bestSummary, describeGame } from '../state/selectors';

function notify(toasts: Toast[]) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState === 'visible' || !toasts.length) return;
  try {
    const title = toasts.length > 1 ? `${toasts.length} new moments` : toasts[0].title;
    const body = toasts.length > 1 ? toasts.map((t) => t.title).join(' · ') : toasts[0].detail;
    new Notification(title, { body, tag: 'gridiron-moments', silent: true });
  } catch {
    /* notifications are optional */
  }
}

const sameSource = (a: Source, b: Source) => a.kind === b.kind && (a.kind === 'live' || (b.kind === 'replay' && a.sessionId === b.sessionId));

export function useAlerts() {
  useEffect(() => {
    const engine = new AlertEngine();
    const applyRules = () => {
      const p = usePrefs.getState();
      engine.setRules(p.alertRules);
      engine.setContext({ favorites: p.favorites.map((f) => f.key), monitored: [...new Set([...p.pinned, ...p.focusGames])], muted: p.mutedGames });
    };
    applyRules();
    const offPrefs = usePrefs.subscribe((s, p) => {
      if (s.alertRules !== p.alertRules || s.favorites !== p.favorites || s.pinned !== p.pinned || s.focusGames !== p.focusGames || s.mutedGames !== p.mutedGames) applyRules();
    });

    let lastWorld: World | null = null;
    let lastSource: Source = useLive.getState().source;
    let lastDelay = useLive.getState().presented.delayMs;
    let lastEpoch = useLive.getState().timelineEpoch;
    let rebaselineUntil = 0;
    let known = new Set<GameId>();

    const onPresented = (presented: Presented) => {
      const live = useLive.getState();
      // A new source or a new delay moves the timeline: start a fresh baseline rather than announce the jump.
      if (!sameSource(live.source, lastSource) || presented.delayMs !== lastDelay) {
        engine.reset();
        known = new Set();
        useFeed.getState().clearToasts();
        lastSource = live.source;
        lastDelay = presented.delayMs;
      }
      // A replay seek: updates from both sides of the jump can still be arriving, so keep re-baselining briefly.
      if (live.timelineEpoch !== lastEpoch) {
        lastEpoch = live.timelineEpoch;
        rebaselineUntil = Date.now() + 4000;
        useFeed.getState().clearToasts();
      }
      if (Date.now() < rebaselineUntil) {
        engine.reset();
        known = new Set();
      }
      if (presented.status !== 'ready' || presented.world === lastWorld) return;
      const world = presented.world;
      lastWorld = world;
      const now = Date.now();
      const p = usePrefs.getState();
      const ui = useUi.getState();
      const interested = new Set([...p.pinned, ...p.focusGames, ...ui.visible]);
      const changes: AlertChange[] = [];
      const present = new Set<GameId>();
      for (const id of Object.keys(world.games)) {
        const game = bestSummary(world, id);
        if (!game) continue;
        present.add(id);
        const entry = world.details[id];
        const detailExpected = !!entry?.detail || ((p.alertRules.scope === 'all' || interested.has(id)) && game.coverage.level !== 'score-only' && isLiveOrPaused(game.status.kind));
        changes.push(...engine.observe(game, entry?.detail ?? null, now, { gap: world.afterGap, detailExpected }));
      }
      for (const id of known) if (!present.has(id)) engine.forget(id);
      known = present;
      if (!changes.length) return;

      const snoozed = p.snoozeUntil !== null && p.snoozeUntil > now;
      const fresh = useFeed.getState().apply(changes, {
        now,
        toastFor: (a) => !p.quiet && !snoozed && a.priority <= 2,
        announceFor: (a) => !snoozed && p.announce.includes(a.kind),
        describeGame: (id) => describeGame(world, id),
      });
      const timely = fresh.filter((t) => !t.late);
      if (timely.length && p.sound && !p.quiet && !snoozed) playChime(timely.some((t) => t.tone === 'score') ? 'score' : 'attention');
      if (timely.length && p.notifications && !snoozed) notify(timely);
    };

    onPresented(useLive.getState().presented);
    const offLive = useLive.subscribe((s, prev) => {
      if (s.presented !== prev.presented || !sameSource(s.source, prev.source)) onPresented(s.presented);
    });
    return () => {
      offPrefs();
      offLive();
    };
  }, []);
}
