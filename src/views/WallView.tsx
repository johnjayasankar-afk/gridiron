/** The wall: a full-screen grid of 4, 9 or 16 games for a second screen, with an optional Director hero tile. */
import { Maximize, Minimize, Radio, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GameSummary } from '../../shared/model';
import { navigate } from '../app/router';
import { DirectorRibbon, nextKickoff } from '../components/DirectorRibbon';
import { GameCard } from '../components/GameCard';
import { Segmented } from '../components/controls';
import { FreshnessIndicator } from '../components/FreshnessIndicator';
import { Wordmark } from '../components/Logo';
import { useDirector } from '../state/director';
import { useSlateModel } from '../state/hooks';
import { useLive } from '../state/live';
import { usePrefs, type WallSize } from '../state/prefs';
import { bestSummary } from '../state/selectors';

/** Cells the hero tile takes: two columns by two rows, or one row on a 2 by 2 wall. */
const HERO_CELLS: Record<WallSize, number> = { 4: 2, 9: 4, 16: 4 };

export function WallView() {
  const model = useSlateModel();
  const wallSize = usePrefs((s) => s.wallSize);
  const density = usePrefs((s) => s.density);
  const focusGames = usePrefs((s) => s.focusGames);
  const pinned = usePrefs((s) => s.pinned);
  const director = usePrefs((s) => s.director);
  const directorState = useDirector((s) => s.state);
  const cuts = useDirector((s) => s.cuts);
  const presented = useLive((s) => s.presented);
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);

  useEffect(() => {
    document.title = 'Wall · Gridiron';
    document.body.classList.add('wall-mode');
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => undefined);
    }
    return () => {
      document.body.classList.remove('wall-mode');
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const hero = director.wall && directorState.gameId ? bestSummary(model.world, directorState.gameId) : null;
  const showHero = director.wall;
  const next = showHero && !hero ? nextKickoff(model.sections.upcoming) : null;
  const heroShown = hero ?? next;
  const inScope = new Set(model.inScope.map((g) => g.id));
  const tileCount = showHero ? wallSize - HERO_CELLS[wallSize] : wallSize;
  const ordered = [...new Set([...focusGames, ...pinned, ...model.watch.map((w) => w.gameId), ...model.sections.live.map((g) => g.id), ...model.sections.upcoming.map((g) => g.id), ...model.sections.final.map((g) => g.id)])]
    .filter((id) => inScope.has(id) && id !== heroShown?.id)
    .map((id) => bestSummary(model.world, id))
    .filter((g): g is GameSummary => g !== null)
    .slice(0, tileCount);
  const variant = wallSize === 16 || density === 'compact' ? 'compact' : 'card';
  const live = model.sections.live.length;

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div className={`wall size-${wallSize} density-${density}${showHero ? ' has-hero' : ''}`} id="main">
      <div className="wall-bar">
        <Wordmark />
        <span className="wall-count mono">
          {live} live · {model.inScope.length} on the slate
        </span>
        <div className="wall-tools">
          <button
            type="button"
            className="btn btn-ghost btn-sm director-toggle"
            aria-pressed={director.wall}
            onClick={() => usePrefs.getState().set({ director: { ...director, wall: !director.wall } })}
            title="A large tile that follows the most important live situation"
          >
            <Radio size={14} aria-hidden="true" /> Director
          </button>
          <Segmented<string>
            label="Wall size"
            value={String(wallSize)}
            options={[
              { value: '4', label: '4' },
              { value: '9', label: '9' },
              { value: '16', label: '16' },
            ]}
            onChange={(v) => usePrefs.getState().set({ wallSize: Number(v) as WallSize })}
          />
          <Segmented
            label="Density"
            value={density}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
            onChange={(v) => usePrefs.getState().set({ density: v })}
          />
          <FreshnessIndicator />
          <button type="button" className="btn btn-ghost btn-sm" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize size={14} aria-hidden="true" /> : <Maximize size={14} aria-hidden="true" />}
            {fullscreen ? 'Leave full screen' : 'Full screen'}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate({ name: 'slate' })}>
            <X size={14} aria-hidden="true" /> Exit wall
          </button>
        </div>
      </div>
      <h1 className="sr-only">Wall</h1>
      {presented.status === 'buffering' ? (
        <div className="wall-empty">Buffering for the spoiler delay.</div>
      ) : !model.world.loaded ? (
        <div className="wall-empty">Connecting to the live feed.</div>
      ) : ordered.length === 0 && !showHero ? (
        <div className="wall-empty">No games on this day. Exit the wall to pick another day or open the replay lab.</div>
      ) : (
        <div className="wall-grid">
          {showHero && (
            <div className="wall-hero">
              <DirectorRibbon game={hero} next={next} />
              {heroShown ? (
                <GameCard
                  key={heroShown.id}
                  game={heroShown}
                  detail={model.world.details[heroShown.id]}
                  variant="card"
                  stale={model.stale.has(heroShown.id)}
                  afterGap={model.world.afterGap}
                  watch={model.watchById.get(heroShown.id) ?? null}
                  showActions={false}
                  cutToken={hero ? cuts : undefined}
                />
              ) : (
                <div className="director-empty">
                  <p>Nothing is live and no more games are scheduled on this day.</p>
                </div>
              )}
            </div>
          )}
          {ordered.map((g) => (
            <GameCard key={g.id} game={g} detail={model.world.details[g.id]} variant={variant} stale={model.stale.has(g.id)} afterGap={model.world.afterGap} watch={model.watchById.get(g.id) ?? null} showActions={false} />
          ))}
        </div>
      )}
    </div>
  );
}
