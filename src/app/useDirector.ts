/**
 * Runs Director mode against the presented timeline while it is switched on in
 * Focus or on the Wall, and announces each change of game politely.
 */
import { useEffect } from 'react';
import { directorNext } from '../../shared/director';
import { isLiveOrPaused } from '../../shared/model';
import { useDirector } from '../state/director';
import { useFeed } from '../state/feed';
import { currentSlateModel } from '../state/hooks';
import { useLive } from '../state/live';
import { usePrefs } from '../state/prefs';
import { bestSummary } from '../state/selectors';

export function useDirectorDriver() {
  useEffect(() => {
    const tick = () => {
      const prefs = usePrefs.getState();
      const director = useDirector.getState();
      if (!prefs.director.focus && !prefs.director.wall) {
        if (director.state.gameId) director.reset();
        return;
      }
      const presented = useLive.getState().presented;
      if (presented.status !== 'ready' || !presented.world.loaded) return;
      const now = Date.now();
      const model = currentSlateModel(now);
      const live = new Set(model.inScope.filter((g) => isLiveOrPaused(g.status.kind)).map((g) => g.id));
      const previous = director.state;
      const next = directorNext(previous, {
        now,
        watch: model.watch,
        moments: useFeed.getState().moments,
        live,
        muted: new Set(prefs.mutedGames),
        skipped: director.skipped,
      });
      director.apply(next);
      if (next.gameId && next.gameId !== previous.gameId) {
        const game = bestSummary(presented.world, next.gameId);
        if (game) {
          useFeed.setState({ announcement: { text: `Director now following ${game.away.shortName} at ${game.home.shortName}. ${next.reason ?? ''}`, at: now } });
        }
      }
    };

    tick();
    const timer = setInterval(tick, 2500);
    const offLive = useLive.subscribe((s, p) => {
      if (s.presented !== p.presented) tick();
    });
    const offFeed = useFeed.subscribe((s, p) => {
      if (s.moments !== p.moments) tick();
    });
    const offPrefs = usePrefs.subscribe((s, p) => {
      if (s.director !== p.director || s.mutedGames !== p.mutedGames || s.league !== p.league || s.divisions !== p.divisions) tick();
    });
    const offDirector = useDirector.subscribe((s, p) => {
      if (s.skipped !== p.skipped || s.state.locked !== p.state.locked) queueMicrotask(tick);
    });
    return () => {
      clearInterval(timer);
      offLive();
      offFeed();
      offPrefs();
      offDirector();
    };
  }, []);
}
