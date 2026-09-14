/**
 * A live game tracker in its own small always-on-top window (Document
 * Picture-in-Picture), for following a game while it plays on TV. It shows
 * what the page shows, with the same spoiler delay: score, clock, win
 * probability, situation, the drive strip and the latest play. Offered only
 * where the browser supports it.
 */
import { useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { downDistance, spotLabel, teamFor } from '../../shared/format';
import { isLiveOrPaused } from '../../shared/model';
import { accentFor } from '../field/color';
import { useIsDark, useResolvedTheme } from '../lib/theme';
import { usePresentedWorld } from '../state/live';
import { usePrefs } from '../state/prefs';
import { bestSummary, displaySituation } from '../state/selectors';
import { DriveStrip } from './DriveStrip';
import { Score } from './Score';
import { StatusPill } from './StatusPill';
import { TeamLogo } from './TeamLogo';
import { WinProbabilityMeter } from './WinProbabilityMeter';

interface PictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

type OpenPopout = { window: Window; gameId: string } | null;

let current: OpenPopout = null;
const listeners = new Set<() => void>();
const publish = (next: OpenPopout) => {
  current = next;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const pictureInPicture = (): PictureInPictureApi | null =>
  typeof window !== 'undefined' && 'documentPictureInPicture' in window ? (window as unknown as { documentPictureInPicture: PictureInPictureApi }).documentPictureInPicture : null;

export const popoutSupported = () => pictureInPicture() !== null;

/** The page's styles, copied into the tracker window: rules where they can be read, links otherwise. */
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
      target.head.appendChild(style);
    } catch {
      if (!sheet.href) continue;
      const link = target.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      target.head.appendChild(link);
    }
  }
}

/** Opens the tracker for a game, replacing any tracker already open. Resolves false when the browser declines. */
export async function openPopout(gameId: string): Promise<boolean> {
  const api = pictureInPicture();
  if (!api) return false;
  current?.window.close();
  let win: Window;
  try {
    win = await api.requestWindow({ width: 400, height: 280 });
  } catch {
    return false;
  }
  copyStyles(win.document);
  const root = win.document.documentElement;
  root.lang = 'en';
  root.dataset.theme = document.documentElement.dataset.theme ?? 'dark';
  root.dataset.effects = document.documentElement.dataset.effects ?? 'full';
  win.document.title = 'Gridiron tracker';
  win.document.body.classList.add('popout-body');
  win.addEventListener('pagehide', () => {
    if (current?.window === win) publish(null);
  });
  publish({ window: win, gameId });
  return true;
}

function Tracker({ gameId }: { gameId: string }) {
  const world = usePresentedWorld();
  const dark = useIsDark();
  const showOdds = usePrefs((s) => s.showOdds);
  const game = bestSummary(world, gameId);
  const entry = world.details[gameId];
  if (!game) {
    return (
      <div className="popout">
        <p className="popout-wait">Waiting for the game…</p>
      </div>
    );
  }
  const live = isLiveOrPaused(game.status.kind);
  const { situation } = displaySituation(game, entry?.detail ?? null);
  const offense = live && situation ? teamFor(game, situation.possession) : null;
  const line = live && situation ? [offense ? `${offense.abbreviation} ball` : null, downDistance(situation), spotLabel(situation.spot, game)].filter(Boolean).join(' · ') : null;
  const style = { '--team-away': accentFor(game.away.color, dark), '--team-home': accentFor(game.home.color, dark) } as CSSProperties;
  return (
    <div className="popout" style={style}>
      <div className="popout-score">
        <span className="popout-team">
          <TeamLogo team={game.away} size={30} />
          <span className="popout-abbr">{game.away.abbreviation}</span>
        </span>
        <Score value={game.score.away} className="popout-num" />
        <span className="popout-status">
          <StatusPill game={game} />
        </span>
        <Score value={game.score.home} className="popout-num" />
        <span className="popout-team is-home">
          <span className="popout-abbr">{game.home.abbreviation}</span>
          <TeamLogo team={game.home} size={30} />
        </span>
      </div>
      {showOdds && (live || game.status.kind === 'scheduled') && <WinProbabilityMeter game={game} detail={entry?.detail ?? null} className="popout-wp" />}
      {line && <p className="popout-line mono">{line}</p>}
      {live && (
        <div className="popout-field">
          <DriveStrip game={game} entry={entry} situation={situation} compact={false} />
        </div>
      )}
      {live && situation?.lastPlay && <p className="popout-last">{situation.lastPlay.description}</p>}
    </div>
  );
}

/** Rendered once by the app: the tracker, portalled into its window while one is open. */
export function PopoutHost() {
  const popout = useSyncExternalStore(subscribe, () => current, () => null);
  const theme = useResolvedTheme();
  useEffect(() => {
    if (popout) popout.window.document.documentElement.dataset.theme = theme;
  }, [popout, theme]);
  useEffect(() => () => current?.window.close(), []);
  return popout ? createPortal(<Tracker gameId={popout.gameId} />, popout.window.document.body) : null;
}
