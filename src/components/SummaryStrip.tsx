import { ListFilter, PanelRightClose, PanelRightOpen, Rows3, LayoutGrid } from 'lucide-react';
import type { Division } from '../../shared/model';
import { DIVISION_LABEL, isLiveOrPaused } from '../../shared/model';
import { navigate } from '../app/router';
import { useMediaQuery } from '../lib/media';
import type { SlateModel } from '../state/hooks';
import { DEFAULT_FILTERS, usePrefs, type SortMode } from '../state/prefs';
import { activeFilterCount, bestSummary, isFavoriteGame } from '../state/selectors';
import { useUi } from '../state/ui';
import { IconButton, Popover, Segmented, Switch } from './controls';

const SORTS: Array<{ value: SortMode; label: string }> = [
  { value: 'watch', label: 'Watch next' },
  { value: 'kickoff', label: 'Kickoff time' },
  { value: 'favorites', label: 'Favorites first' },
  { value: 'closest', label: 'Closest score' },
];

const COLLEGE_DIVISIONS: Division[] = ['FBS', 'FCS', 'D2', 'D3'];

export function FilterControls({ model }: { model: SlateModel }) {
  const filters = usePrefs((s) => s.filters);
  const league = usePrefs((s) => s.league);
  const divisions = usePrefs((s) => s.divisions);
  const closeMargin = usePrefs((s) => s.alertRules.closeMargin);
  const setFilter = usePrefs.getState().setFilter;
  const conferences = model.world.coverage?.conferences ?? [];
  const count = activeFilterCount(filters);
  return (
    <Popover
      label="Filters"
      trigger={
        <>
          <ListFilter size={15} strokeWidth={1.9} aria-hidden="true" />
          <span>Filters</span>
          {count > 0 && <span className="count-pill mono">{count}</span>}
        </>
      }
    >
      <div className="filter-panel">
        <p className="eyebrow">Show</p>
        <Switch label="Live games only" checked={filters.liveOnly} onChange={(v) => setFilter({ liveOnly: v })} />
        <Switch label="Red zone" description="The offense is inside the opponent 20, as reported" checked={filters.redZone} onChange={(v) => setFilter({ redZone: v })} />
        <Switch label="Close games" description={`Live and within ${closeMargin} points`} checked={filters.close} onChange={(v) => setFilter({ close: v })} />
        <Switch label="Favorite teams" checked={filters.favoritesOnly} onChange={(v) => setFilter({ favoritesOnly: v })} />
        {filters.teams.length > 0 && (
          <div className="filter-board">
            <span>Board teams: {filters.teams.length}</span>
            <button type="button" className="link-btn" onClick={() => setFilter({ teams: [] })}>
              Clear
            </button>
          </div>
        )}
        {league !== 'nfl' && (
          <>
            <label className="form-row">
              <span className="form-label">Conference</span>
              <select value={filters.conference ?? ''} onChange={(e) => setFilter({ conference: e.target.value || null })}>
                <option value="">All conferences</option>
                {conferences.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.shortName}
                  </option>
                ))}
              </select>
              {conferences.length === 0 && <span className="form-hint">Conference names appear once the provider has named them for this day.</span>}
            </label>
            <fieldset className="form-row">
              <legend className="form-label">College divisions</legend>
              <div className="check-row">
                {COLLEGE_DIVISIONS.map((d) => (
                  <label key={d} className="check">
                    <input
                      type="checkbox"
                      checked={divisions.includes(d)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...divisions, d] : divisions.filter((x) => x !== d);
                        if (next.length) usePrefs.getState().set({ divisions: COLLEGE_DIVISIONS.filter((x) => next.includes(x)) });
                      }}
                    />
                    <span>{DIVISION_LABEL[d]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm" disabled={count === 0} onClick={() => usePrefs.getState().set({ filters: DEFAULT_FILTERS })}>
          Clear filters
        </button>
      </div>
    </Popover>
  );
}

export function SummaryStrip({ model }: { model: SlateModel }) {
  const pinned = usePrefs((s) => s.pinned);
  const focusGames = usePrefs((s) => s.focusGames);
  const sort = usePrefs((s) => s.sort);
  const density = usePrefs((s) => s.density);
  const railOpen = usePrefs((s) => s.railOpen);
  const query = useUi((s) => s.slateQuery);
  const wide = useMediaQuery('(min-width: 1280px)');
  const set = usePrefs.getState().set;

  const live = model.inScope.filter((g) => isLiveOrPaused(g.status.kind));
  const monitoredIds = new Set([...pinned, ...focusGames, ...model.inScope.filter((g) => isFavoriteGame(g, model.favorites)).map((g) => g.id)]);
  const monitored = model.inScope.filter((g) => monitoredIds.has(g.id)).length;
  const redZone = live.filter((g) => (g.situation?.spot.progress ?? -1) >= 80).length;
  const tier = (n: number) => model.watch.filter((w) => w.tier === n).length;
  const notable = [
    tier(0) ? `${tier(0)} in overtime` : null,
    tier(1) ? `${tier(1)} one-score ${tier(1) === 1 ? 'game' : 'games'} late` : null,
    redZone ? `${redZone} in the red zone` : null,
    tier(3) ? `${tier(3)} on fourth down` : null,
  ].filter(Boolean);
  const top = model.watch.filter((w) => !w.stale).slice(0, 3);

  return (
    <section className="strip" aria-label="Summary">
      <div className="strip-row">
        <div className="strip-stats">
          <p className="stat">
            <span className={`stat-value${live.length ? ' is-live' : ''}`}>{live.length}</span>
            <span className="stat-label">live</span>
          </p>
          <p className="stat">
            <span className="stat-value">{monitored}</span>
            <span className="stat-label">monitored</span>
          </p>
          <p className="strip-notable">{notable.length ? notable.join(' · ') : live.length ? 'No notable situations right now' : 'Nothing in progress'}</p>
        </div>
        <div className="strip-controls">
          <label className="search-field">
            <span className="sr-only">Filter games by team, venue or network</span>
            <input type="search" placeholder="Filter games" value={query} onChange={(e) => useUi.getState().setSlateQuery(e.target.value)} />
          </label>
          <label className="select">
            <span className="sr-only">Sort games</span>
            <select value={sort} onChange={(e) => set({ sort: e.target.value as SortMode })}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <FilterControls model={model} />
          <Segmented
            label="Card density"
            className="seg-icons"
            value={density}
            options={[
              { value: 'comfortable', label: 'Comfortable cards', icon: LayoutGrid, hideLabel: true },
              { value: 'compact', label: 'Compact cards', icon: Rows3, hideLabel: true },
            ]}
            onChange={(v) => set({ density: v })}
          />
          {wide && <IconButton label={railOpen ? 'Hide moments' : 'Show moments'} icon={railOpen ? PanelRightClose : PanelRightOpen} onClick={() => set({ railOpen: !railOpen })} />}
        </div>
      </div>
      {top.length > 0 && (
        <div className="watch-next">
          <h2 className="eyebrow">Watch next</h2>
          <ol className="watch-list">
            {top.map((w) => {
              const g = bestSummary(model.world, w.gameId);
              if (!g) return null;
              return (
                <li key={w.gameId}>
                  <a
                    href={`/game/${encodeURIComponent(g.id)}`}
                    className="watch-item"
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) return;
                      e.preventDefault();
                      navigate({ name: 'game', id: g.id });
                    }}
                  >
                    <span className="watch-teams">
                      {g.away.abbreviation} at {g.home.abbreviation}
                    </span>
                    <span className="watch-label">{w.label}</span>
                    <span className="watch-reasons mono">{w.reasons.join(' · ')}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
