import { AudioWaveform, Bell, BookOpen, ChevronLeft, ChevronRight, Columns2, FlaskConical, Keyboard, LayoutGrid, Monitor, Moon, MoreHorizontal, Search, Settings2, SlidersHorizontal, Star, Sun, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { shiftDateKey } from '../../shared/util';
import { navigate, setParams, useLocation } from '../app/router';
import { useResolvedTheme } from '../lib/theme';
import { dateKeyToInput, inputToDateKey } from '../lib/time';
import { useFeed } from '../state/feed';
import { useLive } from '../state/live';
import { usePartyStore } from '../state/party';
import { usePrefs, type DayMode, type LeagueFilter } from '../state/prefs';
import { useUi } from '../state/ui';
import { IconButton, Menu, Segmented } from './controls';
import { FreshnessIndicator } from './FreshnessIndicator';
import { Wordmark } from './Logo';

/** Watch party entry point. Polled deployments cannot hold a party, so the button is hidden there unless a party is already open. */
function PartyButton() {
  const role = usePartyStore((s) => s.role);
  const members = usePartyStore((s) => s.members);
  const polled = useLive((s) => s.health?.transport === 'poll');
  if (polled && !role) return null;
  return (
    <button
      type="button"
      className={`icon-btn party-btn${role ? ' is-active' : ''}`}
      aria-label={role ? `Watch party, ${members} in the party` : 'Start a watch party'}
      title="Watch party"
      onClick={() => useUi.getState().setDialog('party')}
    >
      <Users size={16} strokeWidth={1.9} aria-hidden="true" />
      {role && members > 0 && <span className="count-badge mono">{members}</span>}
    </button>
  );
}

export function Header() {
  const { route } = useLocation();
  const dayMode = usePrefs((s) => s.dayMode);
  const date = usePrefs((s) => s.date);
  const league = usePrefs((s) => s.league);
  const favoritesOnly = usePrefs((s) => s.filters.favoritesOnly);
  const favoriteCount = usePrefs((s) => s.favorites.length);
  const theme = useResolvedTheme();
  const railOpen = usePrefs((s) => s.railOpen);
  const [scrolled, setScrolled] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  // A light sweeps along the header rule when new data is presented (at most every few seconds).
  const rev = useLive((s) => s.presented.world.rev);
  const [pulse, setPulse] = useState(0);
  const seenRev = useRef<number | null>(null);
  const lastPulse = useRef(0);
  useEffect(() => {
    if (seenRev.current === null || rev === seenRev.current) {
      seenRev.current = rev;
      return;
    }
    seenRev.current = rev;
    const now = Date.now();
    if (now - lastPulse.current < 3000) return;
    lastPulse.current = now;
    setPulse((p) => p + 1);
  }, [rev]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  // The header wraps on narrower screens; sticky content below it (the game page field) reads its real height.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty('--hdr-height', `${Math.round(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--hdr-height');
    };
  }, []);
  const today = useLive((s) => s.hello?.today ?? s.health?.today ?? null);
  const unread = useFeed((s) => s.unread);
  const ui = useUi.getState();
  const set = usePrefs.getState().set;
  const current = dayMode === 'date' ? date : today;
  const layout = route.name === 'focus' ? 'focus' : route.name === 'wall' ? 'wall' : route.name === 'tape' ? 'tape' : 'slate';

  const pickDay = (key: string | null) => {
    if (!key) return;
    if (key === today) {
      set({ dayMode: 'today', date: null });
      setParams({ date: null });
    } else {
      set({ dayMode: 'date', date: key });
      setParams({ date: key });
    }
    if (route.name === 'game' || route.name === 'team') navigate({ name: 'slate' });
  };

  const openMoments = () => {
    if (window.matchMedia('(min-width: 1280px)').matches) set({ railOpen: !railOpen });
    else ui.setDrawer(true);
  };

  return (
    <header ref={headerRef} className={`hdr${scrolled ? ' is-scrolled' : ''}`}>
      {pulse > 0 && <span key={pulse} className="hdr-scan" aria-hidden="true" />}
      <div className="hdr-inner">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate({ name: 'slate' });
          }}
          aria-label="Gridiron, go to the slate"
        >
          <Wordmark />
        </a>

        <div className="hdr-controls">
          <Segmented<DayMode>
            label="Day"
            value={dayMode === 'date' ? null : dayMode}
            options={[
              { value: 'live', label: 'Live' },
              { value: 'today', label: 'Today' },
            ]}
            onChange={(v) => {
              set({ dayMode: v, date: null });
              setParams({ date: null });
            }}
          />
          <div className={`date-nav${dayMode === 'date' ? ' is-active' : ''}`} role="group" aria-label="Date">
            <IconButton label="Previous day" icon={ChevronLeft} size={15} onClick={() => current && pickDay(shiftDateKey(current, -1))} disabled={!current} />
            <label className="date-field">
              <span className="sr-only">Choose a date</span>
              <input type="date" value={dateKeyToInput(current)} onChange={(e) => pickDay(inputToDateKey(e.target.value))} />
            </label>
            <IconButton label="Next day" icon={ChevronRight} size={15} onClick={() => current && pickDay(shiftDateKey(current, 1))} disabled={!current} />
          </div>
          <Segmented<LeagueFilter>
            label="League"
            value={league}
            options={[
              { value: 'all', label: 'All' },
              { value: 'nfl', label: 'NFL' },
              { value: 'cfb', label: 'College' },
            ]}
            onChange={(v) => set({ league: v })}
          />
          <Segmented
            label="Layout"
            className="seg-icons"
            value={layout}
            options={[
              { value: 'slate', label: 'Slate', icon: LayoutGrid, hideLabel: true },
              { value: 'focus', label: 'Focus', icon: Columns2, hideLabel: true },
              { value: 'wall', label: 'Wall', icon: Monitor, hideLabel: true },
              { value: 'tape', label: 'Tape', icon: AudioWaveform, hideLabel: true },
            ]}
            onChange={(v) => navigate({ name: v })}
          />
        </div>

        <div className="hdr-actions">
          <button type="button" className="search-btn" onClick={() => ui.setPalette(true)} aria-keyshortcuts="Meta+K Control+K" aria-label="Search games, teams and commands">
            <Search size={16} strokeWidth={1.9} aria-hidden="true" />
            <span className="search-label">Search</span>
            <kbd>⌘K</kbd>
          </button>
          <IconButton
            label={favoriteCount ? (favoritesOnly ? 'Show all teams' : 'Show favorite teams only') : 'Favorite teams: search for a team to add one'}
            icon={Star}
            pressed={favoritesOnly}
            className={favoritesOnly ? 'is-starred' : ''}
            onClick={() => (favoriteCount ? usePrefs.getState().setFilter({ favoritesOnly: !favoritesOnly }) : ui.setPalette(true))}
          />
          <button type="button" className="icon-btn bell-btn" aria-label={`Moments${unread ? `, ${unread} new` : ''}`} title="Moments" onClick={openMoments}>
            <Bell size={16} strokeWidth={1.9} aria-hidden="true" />
            {unread > 0 && <span className="count-badge mono">{unread > 99 ? '99+' : unread}</span>}
          </button>
          <PartyButton />
          <IconButton label="Alert settings" icon={SlidersHorizontal} className="alerts-btn" onClick={() => ui.setDialog('alerts')} />
          <IconButton label={theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance'} icon={theme === 'dark' ? Sun : Moon} onClick={() => set({ theme: theme === 'dark' ? 'light' : 'dark' })} />
          <FreshnessIndicator />
          <Menu
            label="More"
            trigger={<MoreHorizontal size={16} strokeWidth={1.9} aria-hidden="true" />}
            items={[
              { label: 'Alert settings', icon: SlidersHorizontal, onSelect: () => ui.setDialog('alerts') },
              { label: 'Watch party', icon: Users, onSelect: () => ui.setDialog('party') },
              { label: 'Boards', icon: LayoutGrid, onSelect: () => ui.setDialog('boards') },
              { label: 'Replay lab', icon: FlaskConical, onSelect: () => ui.setDialog('replay') },
              { label: 'Display settings', icon: Settings2, onSelect: () => ui.setDialog('settings') },
              'separator',
              { label: 'Data and sources', icon: BookOpen, onSelect: () => ui.setDialog('help') },
              { label: 'Keyboard shortcuts', icon: Keyboard, hint: '?', onSelect: () => ui.setDialog('shortcuts') },
            ]}
          />
        </div>
      </div>
    </header>
  );
}
