/** The moments feed: every alert this session, newest first, with jump, focus and play links. */
import { PanelRightClose, PanelRightOpen, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { attackDirection } from '../../shared/field';
import type { Alert, GameSummary, PlayEvent } from '../../shared/model';
import { periodShort } from '../../shared/util';
import { navigate } from '../app/router';
import { endZoneTint } from '../field/color';
import { useMediaQuery } from '../lib/media';
import { clockTime } from '../lib/time';
import { useFeed } from '../state/feed';
import { usePresentedWorld, type World } from '../state/live';
import { usePrefs } from '../state/prefs';
import { bestSummary, isFavoriteGame } from '../state/selectors';
import { useUi } from '../state/ui';
import { IconButton, Segmented } from './controls';
import { Dialog } from './Dialog';

type MomentFilter = 'all' | 'scores' | 'favorites';
const SCORE_KINDS = new Set(['touchdown', 'field_goal', 'safety', 'score_change', 'final']);

const LOSS_KINDS = new Set(['interception', 'fumble_lost', 'punt_blocked', 'field_goal_blocked']);
const KICK_KINDS = new Set(['field_goal_good', 'field_goal_missed', 'extra_point']);

/** A thumbnail strip of the field with the play's reported start and end spots. Schematic, like the big field. */
function MomentField({ game, play }: { game: GameSummary; play: PlayEvent }) {
  const from = play.start?.spot.schematicYard ?? null;
  const offense = play.start?.spot.offense ?? play.offense;
  if (from === null || !offense) return null;
  const dir = attackDirection(offense);
  const kick = KICK_KINDS.has(play.kind);
  const to = kick ? (dir === 1 ? 110 : -10) : (play.end?.spot.schematicYard ?? null);
  if (to === null) return null;
  const x = (yard: number) => 10 + Math.min(110, Math.max(-10, yard));
  const loss = !kick && (LOSS_KINDS.has(play.kind) || play.turnover === true || (to - from) * dir < 0);
  return (
    <svg className="moment-field" viewBox="0 0 120 22" aria-hidden="true" focusable="false">
      <rect className="mf-turf" x="0" y="0" width="120" height="22" rx="5" />
      <path d="M5,0H10V22H5A5,5 0 0 1 0,17V5A5,5 0 0 1 5,0Z" style={{ fill: endZoneTint(game.away.color) }} />
      <path d="M110,0H115A5,5 0 0 1 120,5V17A5,5 0 0 1 115,22H110Z" style={{ fill: endZoneTint(game.home.color) }} />
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => (
        <line key={k} className={k === 5 ? 'mf-mid' : 'mf-line'} x1={10 + k * 10} x2={10 + k * 10} y1="3" y2="19" />
      ))}
      <line className={`mf-path${loss ? ' is-loss' : ''}${kick ? ' is-kick' : ''}`} x1={x(from)} x2={x(to)} y1="11" y2="11" />
      <circle className="mf-start" cx={x(from)} cy="11" r="1.6" />
      <circle className={`mf-end${loss ? ' is-loss' : ''}`} cx={x(to)} cy="11" r="2.8" />
    </svg>
  );
}

function MomentItem({ alert, world }: { alert: Alert; world: World }) {
  const game = bestSummary(world, alert.gameId);
  const when = [periodShort(alert.period), alert.clock].filter(Boolean).join(' ');
  const playId = alert.playId ? alert.playId.slice(alert.playId.lastIndexOf(':') + 1) : null;
  const play = playId ? (world.details[alert.gameId]?.detail?.plays.find((p) => p.providerId === playId) ?? null) : null;
  return (
    <li className={`moment kind-${alert.kind} status-${alert.status}`}>
      <span className="moment-dot" aria-hidden="true" />
      <div className="moment-main">
        <p className="moment-meta mono">
          <time dateTime={new Date(alert.receivedAt).toISOString()}>{clockTime(alert.receivedAt)}</time>
          {game && <span> · {game.away.abbreviation} at {game.home.abbreviation}</span>}
          {when && <span> · {when}</span>}
        </p>
        <p className="moment-title">{alert.title}</p>
        {alert.detail && <p className="moment-detail">{alert.detail}</p>}
        {game && play && alert.status !== 'withdrawn' && <MomentField game={game} play={play} />}
        {(alert.status !== 'active' || alert.late) && (
          <p className="moment-tags">
            {alert.status === 'corrected' && <span className="tag">Corrected</span>}
            {alert.status === 'withdrawn' && <span className="tag">Withdrawn by a correction</span>}
            {alert.late && <span className="tag">Late update</span>}
          </p>
        )}
        <div className="moment-actions">
          <button type="button" className="link-btn" onClick={() => navigate({ name: 'game', id: alert.gameId })}>
            Open game
          </button>
          <button type="button" className="link-btn" onClick={() => usePrefs.getState().addToFocus(alert.gameId)}>
            Add to focus
          </button>
          {playId && (
            <button type="button" className="link-btn" onClick={() => navigate({ name: 'game', id: alert.gameId }, { params: { play: playId } })}>
              View play
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function MomentsPanel({ onHide }: { onHide?: () => void }) {
  const moments = useFeed((s) => s.moments);
  const unread = useFeed((s) => s.unread);
  const world = usePresentedWorld();
  const favorites = usePrefs((s) => s.favorites);
  const [filter, setFilter] = useState<MomentFilter>('all');

  useEffect(() => {
    if (unread && document.visibilityState === 'visible') {
      const t = setTimeout(() => useFeed.getState().markRead(), 1500);
      return () => clearTimeout(t);
    }
  }, [unread]);

  const list = useMemo(() => {
    const favSet = new Set(favorites.map((f) => f.key));
    return moments.filter((m) => {
      if (filter === 'scores') return SCORE_KINDS.has(m.kind);
      if (filter === 'favorites') {
        const g = bestSummary(world, m.gameId);
        return !!g && isFavoriteGame(g, favSet);
      }
      return true;
    });
  }, [moments, filter, favorites, world]);

  return (
    <div className="moments">
      <header className="moments-head">
        <h2 className="moments-title">Moments</h2>
        <div className="moments-tools">
          <IconButton label="Alert settings" icon={SlidersHorizontal} onClick={() => useUi.getState().setDialog('alerts')} />
          {onHide && <IconButton label="Hide moments" icon={PanelRightClose} onClick={onHide} />}
        </div>
      </header>
      <Segmented<MomentFilter>
        label="Show moments"
        className="seg-full"
        value={filter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'scores', label: 'Scores' },
          { value: 'favorites', label: 'Favorites' },
        ]}
        onChange={setFilter}
      />
      {list.length === 0 ? (
        <p className="empty-note">
          {moments.length === 0
            ? 'Nothing yet. Scores, turnovers, lead changes and other moments appear here as they are reported. Games already in progress when you arrived are not replayed as new.'
            : 'No moments match this filter.'}
        </p>
      ) : (
        <ol className="moments-list">
          {list.map((m) => (
            <MomentItem key={m.id} alert={m} world={world} />
          ))}
        </ol>
      )}
    </div>
  );
}

export function MomentsRail() {
  const wide = useMediaQuery('(min-width: 1280px)');
  const railOpen = usePrefs((s) => s.railOpen);
  const drawerOpen = useUi((s) => s.drawerOpen);
  const unread = useFeed((s) => s.unread);

  if (wide) {
    return (
      <aside className={`rail${railOpen ? ' is-open' : ' is-closed'}`} aria-label="Moments">
        {railOpen ? (
          <MomentsPanel onHide={() => usePrefs.getState().set({ railOpen: false })} />
        ) : (
          <div className="rail-collapsed">
            <button type="button" className="icon-btn" aria-label={`Show moments${unread ? `, ${unread} new` : ''}`} title="Show moments" onClick={() => usePrefs.getState().set({ railOpen: true })}>
              <PanelRightOpen size={16} strokeWidth={1.9} aria-hidden="true" />
            </button>
            {unread > 0 && <span className="count-badge mono">{unread > 99 ? '99+' : unread}</span>}
          </div>
        )}
      </aside>
    );
  }
  return (
    <Dialog open={drawerOpen} onClose={() => useUi.getState().setDrawer(false)} title="Moments" className="drawer" size="sm">
      <MomentsPanel />
    </Dialog>
  );
}
