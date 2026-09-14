/** Focus: one, two or four games at a large size. Director mode can take the first slot and follow the action. */
import { ChevronLeft, ChevronRight, Radio, X } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { statusShort } from '../../shared/format';
import type { GameId, GameSummary } from '../../shared/model';
import { DirectorRibbon, nextKickoff } from '../components/DirectorRibbon';
import { GameCard } from '../components/GameCard';
import { IconButton, Segmented } from '../components/controls';
import { SummaryStrip } from '../components/SummaryStrip';
import { useDirector } from '../state/director';
import { useSlateModel, type SlateModel } from '../state/hooks';
import { useLive } from '../state/live';
import { usePrefs, type FocusSize } from '../state/prefs';
import { bestSummary, sectionOf } from '../state/selectors';
import { BufferingState, LoadingState } from './SlateView';

function GamePicker({ value, candidates, label, onPick }: { value: GameId | null; candidates: GameSummary[]; label: string; onPick: (id: GameId) => void }) {
  const groups: Array<[string, GameSummary[]]> = [
    ['Live', candidates.filter((g) => sectionOf(g) === 'live')],
    ['Up next', candidates.filter((g) => sectionOf(g) === 'upcoming')],
    ['Final', candidates.filter((g) => sectionOf(g) === 'final')],
  ];
  return (
    <label className="select select-sm">
      <span className="sr-only">{label}</span>
      <select value="" onChange={(e) => e.target.value && onPick(e.target.value)}>
        <option value="">{value ? 'Replace…' : 'Choose a game…'}</option>
        {groups.map(([name, games]) =>
          games.length ? (
            <optgroup key={name} label={name}>
              {games.map((g) => (
                <option key={g.id} value={g.id} disabled={g.id === value}>
                  {g.away.abbreviation} at {g.home.abbreviation} · {statusShort(g.status)}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
    </label>
  );
}

function FocusSlot({ index, id, slots, model, candidates }: { index: number; id: GameId | null; slots: number; model: SlateModel; candidates: GameSummary[] }) {
  const focusGames = usePrefs((s) => s.focusGames);
  const prefs = usePrefs.getState();
  const game = id ? bestSummary(model.world, id) : null;
  const pick = (next: GameId) => (id ? prefs.replaceFocus(index, next) : prefs.setFocusGames([...focusGames.slice(0, index).filter(Boolean), next, ...focusGames.slice(index)]));

  if (!id || !game) {
    return (
      <div className="focus-slot is-empty">
        <p className="eyebrow">Slot {index + 1}</p>
        <p className="focus-empty-text">{id ? 'This game is not on the selected day.' : 'Choose a game to watch here.'}</p>
        <div className="focus-empty-actions">
          <GamePicker value={null} candidates={candidates} label={`Choose a game for slot ${index + 1}`} onPick={pick} />
          {id && <IconButton label="Remove from focus" icon={X} onClick={() => prefs.removeFromFocus(id)} />}
        </div>
      </div>
    );
  }

  const controls = (
    <>
      <GamePicker value={id} candidates={candidates} label={`Replace the game in slot ${index + 1}`} onPick={pick} />
      <IconButton label="Move to the previous slot" icon={ChevronLeft} disabled={index === 0} onClick={() => prefs.swapFocus(index, index - 1)} />
      <IconButton label="Move to the next slot" icon={ChevronRight} disabled={index >= slots - 1 || !focusGames[index + 1]} onClick={() => prefs.swapFocus(index, index + 1)} />
      <IconButton label="Remove from focus" icon={X} onClick={() => prefs.removeFromFocus(id)} />
    </>
  );
  return (
    <div className="focus-slot">
      <GameCard game={game} detail={model.world.details[id]} variant="card" stale={model.stale.has(id)} afterGap={model.world.afterGap} watch={model.watchById.get(id) ?? null} slotControls={controls} />
    </div>
  );
}

function DirectorSlot({ model }: { model: SlateModel }) {
  const state = useDirector((s) => s.state);
  const cuts = useDirector((s) => s.cuts);
  const game = state.gameId ? bestSummary(model.world, state.gameId) : null;
  const next = game ? null : nextKickoff(model.sections.upcoming);
  const shown = game ?? next;
  return (
    <div className="focus-slot director-slot">
      <DirectorRibbon game={game} next={next} />
      {shown ? (
        <GameCard key={shown.id} game={shown} detail={model.world.details[shown.id]} variant="card" stale={model.stale.has(shown.id)} afterGap={model.world.afterGap} watch={model.watchById.get(shown.id) ?? null} cutToken={game ? cuts : undefined} />
      ) : (
        <div className="director-empty">
          <p>Nothing is live and no more games are scheduled on this day.</p>
        </div>
      )}
    </div>
  );
}

export function FocusView() {
  const model = useSlateModel();
  const focusGames = usePrefs((s) => s.focusGames);
  const focusSize = usePrefs((s) => s.focusSize);
  const director = usePrefs((s) => s.director);
  const presented = useLive((s) => s.presented);
  const candidates = useMemo(() => [...model.sections.live, ...model.sections.upcoming, ...model.sections.final], [model]);

  useEffect(() => {
    document.title = 'Focus · Gridiron';
  }, []);

  if (presented.status === 'buffering') return <BufferingState readyInMs={presented.readyInMs} />;
  if (!model.world.loaded) return <LoadingState title="Loading your focus games" />;

  const manualSlots = director.focus ? focusSize - 1 : focusSize;
  const fill = () => {
    const ids = [...new Set([...focusGames, ...model.watch.map((w) => w.gameId), ...model.sections.live.map((g) => g.id), ...model.sections.upcoming.map((g) => g.id)])];
    usePrefs.getState().setFocusGames(ids.slice(0, Math.max(1, manualSlots)));
  };
  const slots = Array.from({ length: manualSlots }, (_, i) => focusGames[i] ?? null);

  return (
    <>
      <SummaryStrip model={model} />
      <div className="view-bar">
        <h1 className="view-title">Focus</h1>
        <Segmented<string>
          label="Games in focus"
          value={String(focusSize)}
          options={[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '4', label: '4' },
          ]}
          onChange={(v) => usePrefs.getState().set({ focusSize: Number(v) as FocusSize })}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm director-toggle"
          aria-pressed={director.focus}
          onClick={() => usePrefs.getState().set({ director: { ...director, focus: !director.focus } })}
          title="An automatic slot that follows the most important live situation"
        >
          <Radio size={14} aria-hidden="true" /> Director
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={fill} disabled={!candidates.length || manualSlots === 0}>
          Fill empty slots
        </button>
        {focusGames.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => usePrefs.getState().setFocusGames([])}>
            Clear
          </button>
        )}
      </div>
      <div className={`focus-grid size-${focusSize}`}>
        {director.focus && <DirectorSlot model={model} />}
        {slots.map((id, i) => (
          <FocusSlot key={`${i}-${id ?? 'empty'}`} index={i} id={id} slots={manualSlots} model={model} candidates={candidates} />
        ))}
      </div>
      {focusGames.length > manualSlots && (
        <p className="muted focus-note">
          {focusGames.length - manualSlots} more {focusGames.length - manualSlots === 1 ? 'game is' : 'games are'} in focus but hidden at this size.
        </p>
      )}
    </>
  );
}
