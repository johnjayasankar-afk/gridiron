/** Cmd/Ctrl+K: find games and teams, and run any command, from the keyboard. */
import { Search } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { statusShort } from '../../shared/format';
import type { Team } from '../../shared/model';
import { isLiveOrPaused } from '../../shared/model';
import { isTeamPageId, navigate } from '../app/router';
import { copyText } from '../lib/share';
import { useResolvedTheme } from '../lib/theme';
import { usePresentedWorld } from '../state/live';
import { DEFAULT_FILTERS, usePrefs } from '../state/prefs';
import { searchText, slateGames } from '../state/selectors';
import { useUi } from '../state/ui';

interface Item {
  id: string;
  group: 'Games' | 'Teams' | 'Commands';
  label: string;
  hint?: string;
  run: () => void;
  secondary?: () => void;
}

interface Command {
  id: string;
  label: string;
  keywords: string;
  hint?: string;
  run: () => void;
}

function commands(theme: 'light' | 'dark', query: string): Command[] {
  const p = usePrefs.getState();
  const ui = useUi.getState();
  const list: Command[] = [
    { id: 'slate', label: 'Go to the slate', keywords: 'view grid cards home', hint: '1', run: () => navigate({ name: 'slate' }) },
    { id: 'focus', label: 'Go to Focus', keywords: 'view large', hint: '2', run: () => navigate({ name: 'focus' }) },
    { id: 'wall', label: 'Open the wall', keywords: 'fullscreen tv second screen', hint: '3', run: () => navigate({ name: 'wall' }) },
    { id: 'live', label: 'Show the live day', keywords: 'today now', hint: 'L', run: () => p.set({ dayMode: 'live', date: null }) },
    { id: 'today', label: 'Show today', keywords: 'date day', run: () => p.set({ dayMode: 'today', date: null }) },
    { id: 'nfl', label: 'Show NFL games only', keywords: 'league pro', run: () => p.set({ league: 'nfl' }) },
    { id: 'cfb', label: 'Show college games only', keywords: 'league ncaa fbs fcs', run: () => p.set({ league: 'cfb' }) },
    { id: 'all', label: 'Show all leagues', keywords: 'league nfl college', run: () => p.set({ league: 'all' }) },
    { id: 'theme', label: theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance', keywords: 'theme mode appearance', run: () => p.set({ theme: theme === 'dark' ? 'light' : 'dark' }) },
    { id: 'alerts', label: 'Alert settings', keywords: 'notifications sound quiet snooze mute push', run: () => ui.setDialog('alerts') },
    { id: 'boards', label: 'Boards', keywords: 'save share layout', run: () => ui.setDialog('boards') },
    { id: 'display', label: 'Display settings', keywords: 'effects 2d 3d density delay spoiler field style holographic', run: () => ui.setDialog('settings') },
    { id: 'replay', label: 'Replay lab', keywords: 'demo test captured', run: () => ui.setDialog('replay') },
    { id: 'party', label: 'Watch party', keywords: 'share together friends sync follow invite qr', run: () => ui.setDialog('party') },
    { id: 'help', label: 'Data and sources', keywords: 'help coverage provider espn about', run: () => ui.setDialog('help') },
    { id: 'keys', label: 'Keyboard shortcuts', keywords: 'help keys', hint: '?', run: () => ui.setDialog('shortcuts') },
    {
      id: 'moments',
      label: 'Show or hide moments',
      keywords: 'rail feed alerts',
      hint: 'M',
      run: () => (window.matchMedia('(min-width: 1280px)').matches ? p.set({ railOpen: !p.railOpen }) : ui.setDrawer(true)),
    },
    { id: 'fx-full', label: 'Effects: full 3D', keywords: 'graphics performance mode', run: () => p.set({ effects: 'full' }) },
    { id: 'fx-reduced', label: 'Effects: reduced motion', keywords: 'graphics performance mode', run: () => p.set({ effects: 'reduced' }) },
    { id: 'fx-flat', label: 'Effects: 2D fields', keywords: 'graphics performance mode battery', run: () => p.set({ effects: 'flat' }) },
    { id: 'delay-0', label: 'Spoiler delay: off', keywords: 'delay', run: () => p.setDelay(0) },
    { id: 'delay-30', label: 'Spoiler delay: 30 seconds', keywords: 'delay', run: () => p.setDelay(30) },
    { id: 'delay-60', label: 'Spoiler delay: 60 seconds', keywords: 'delay', run: () => p.setDelay(60) },
    { id: 'f-live', label: 'Filter: live games only', keywords: 'filter', run: () => p.setFilter({ liveOnly: true }) },
    { id: 'f-red', label: 'Filter: red zone', keywords: 'filter', run: () => p.setFilter({ redZone: true }) },
    { id: 'f-close', label: 'Filter: close games', keywords: 'filter', run: () => p.setFilter({ close: true }) },
    { id: 'f-fav', label: 'Filter: favorite teams', keywords: 'filter star', run: () => p.setFilter({ favoritesOnly: true }) },
    {
      id: 'f-clear',
      label: 'Clear filters',
      keywords: 'filter reset',
      run: () => {
        p.set({ filters: DEFAULT_FILTERS });
        ui.setSlateQuery('');
      },
    },
    { id: 'reset', label: 'Reset layout', keywords: 'defaults', run: () => p.resetLayout() },
    {
      id: 'copy-link',
      label: 'Copy a link to this page',
      keywords: 'share url',
      run: () => void copyText(window.location.href).then((ok) => ui.showNotice(ok ? 'Link copied' : 'Could not copy the link')),
    },
  ];
  if (query.trim()) {
    list.unshift({
      id: 'filter-query',
      label: `Filter the slate by “${query.trim()}”`,
      keywords: query,
      run: () => {
        ui.setSlateQuery(query.trim());
        navigate({ name: 'slate' });
      },
    });
  }
  return list;
}

function Palette() {
  const world = usePresentedWorld();
  const favorites = usePrefs((s) => s.favorites);
  const theme = useResolvedTheme();
  const recent = usePrefs((s) => s.recentSearches);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const close = () => useUi.getState().setPalette(false);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    input.current?.focus();
    document.body.classList.add('modal-open');
    return () => {
      document.body.classList.remove('modal-open');
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const items = useMemo<Item[]>(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (text: string) => tokens.every((t) => text.includes(t));
    const games = slateGames(world);
    const gameItems: Item[] = games
      .filter((g) => (tokens.length ? match(searchText(g)) : isLiveOrPaused(g.status.kind)))
      .slice(0, tokens.length ? 8 : 5)
      .map((g) => ({
        id: `game:${g.id}`,
        group: 'Games',
        label: `${g.away.shortName} at ${g.home.shortName}`,
        hint: `${statusShort(g.status)}${g.score.home !== null && g.score.away !== null ? ` · ${g.score.away}-${g.score.home}` : ''}`,
        run: () => navigate({ name: 'game', id: g.id }),
        secondary: () => usePrefs.getState().addToFocus(g.id),
      }));
    const teams = new Map<string, Team>();
    for (const g of games) {
      teams.set(g.home.key, g.home);
      teams.set(g.away.key, g.away);
    }
    const favoriteKeys = new Set(favorites.map((f) => f.key));
    const teamItems: Item[] = tokens.length
      ? [...teams.values()]
          .filter((t) => match(`${t.displayName} ${t.abbreviation} ${t.shortName} ${t.location ?? ''}`.toLowerCase()))
          .slice(0, 6)
          .map((t) => {
            const isFavorite = favoriteKeys.has(t.key);
            const toggle = () => {
              usePrefs.getState().toggleFavorite({ key: t.key, league: t.league, abbreviation: t.abbreviation, name: t.displayName, logo: t.logo, color: t.color });
              useUi.getState().showNotice(isFavorite ? `Removed ${t.abbreviation} from favorites` : `Added ${t.abbreviation} to favorites`);
            };
            // Teams with a page open it; Shift+Enter still stars them.
            if (isTeamPageId(t.key)) {
              return {
                id: `team:${t.key}`,
                group: 'Teams',
                label: `${t.displayName} (${t.abbreviation})`,
                hint: `Team page · Shift+Enter ${isFavorite ? 'unstars' : 'stars'}`,
                run: () => navigate({ name: 'team', id: t.key }),
                secondary: toggle,
              };
            }
            return { id: `team:${t.key}`, group: 'Teams', label: `${t.displayName} (${t.abbreviation})`, hint: isFavorite ? 'Favorite · Enter removes' : 'Enter adds to favorites', run: toggle };
          })
      : [];
    const commandItems: Item[] = commands(theme, query)
      .filter((c) => !tokens.length || c.id === 'filter-query' || match(`${c.label} ${c.keywords}`.toLowerCase()))
      .slice(0, tokens.length ? 8 : 12)
      .map((c) => ({ id: `cmd:${c.id}`, group: 'Commands', label: c.label, hint: c.hint, run: c.run }));
    return [...gameItems, ...teamItems, ...commandItems];
  }, [query, world, favorites, theme]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`#palette-item-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runItem = (item: Item, secondary: boolean) => {
    close();
    const q = query.trim();
    if (q && item.group !== 'Commands') {
      const p = usePrefs.getState();
      p.set({ recentSearches: [q, ...p.recentSearches.filter((x) => x !== q)].slice(0, 8) });
    }
    (secondary && item.secondary ? item.secondary : item.run)();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (item) runItem(item, e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') e.preventDefault();
  };

  return createPortal(
    <div
      className="overlay palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search games, teams and commands">
        <div className="palette-input">
          <Search size={18} strokeWidth={1.9} aria-hidden="true" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={items.length ? `palette-item-${active}` : undefined}
            placeholder="Search games, teams or commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd>Esc</kbd>
        </div>
        {!query && recent.length > 0 && (
          <div className="palette-recent">
            <span className="eyebrow">Recent</span>
            {recent.slice(0, 5).map((r) => (
              <button key={r} type="button" className="chip" onClick={() => setQuery(r)}>
                {r}
              </button>
            ))}
          </div>
        )}
        <ul id="palette-list" ref={list} role="listbox" aria-label="Results" className="palette-list">
          {items.length === 0 && (
            <li className="palette-empty" role="presentation">
              Nothing matches “{query}”.
            </li>
          )}
          {items.map((item, i) => (
            <Fragment key={item.id}>
              {(i === 0 || items[i - 1].group !== item.group) && (
                <li role="presentation" className="palette-group eyebrow">
                  {item.group}
                </li>
              )}
              <li
                id={`palette-item-${i}`}
                role="option"
                aria-selected={i === active}
                className="palette-item"
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runItem(item, e.shiftKey);
                }}
              >
                <span className="palette-label">{item.label}</span>
                {item.hint && <span className="palette-hint mono">{item.hint}</span>}
              </li>
            </Fragment>
          ))}
        </ul>
        <p className="palette-foot mono">↑↓ move · Enter open · Shift+Enter focus a game or star a team · Esc close</p>
      </div>
    </div>,
    document.body,
  );
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  return open ? <Palette /> : null;
}
