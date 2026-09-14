/** Page-level notices: watch parties, replay lab controls, spoiler delay, graphics fallback and shared-board links. */
import { FlaskConical, Pause, Play, RotateCcw, SkipForward, TriangleAlert, Users, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { decodeBoard, BOARD_PARAM } from '../../shared/boards';
import { setParams, useLocation } from '../app/router';
import { endParty, followHost, leaveParty } from '../app/usePartySync';
import { ApiError, replayApi, type ReplayStatus } from '../data/api';
import { useGraphics } from '../state/graphics';
import { useLive } from '../state/live';
import { usePartyStore } from '../state/party';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';

const SPEEDS = [1, 5, 15, 30, 60, 120];

export function PartyBanner() {
  const role = usePartyStore((s) => s.role);
  const members = usePartyStore((s) => s.members);
  const following = usePartyStore((s) => s.following);
  const status = usePartyStore((s) => s.status);
  if (!role) return null;
  const count = `${members} in the party`;
  const pending = status === 'connecting' ? ' Connecting…' : status === 'reconnecting' ? ' Reconnecting…' : '';

  if (status === 'ended') {
    return (
      <section className="banner banner-attention party-banner" role="status">
        <Users size={16} aria-hidden="true" />
        <p>The watch party has ended.</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => leaveParty()}>
          Dismiss
        </button>
      </section>
    );
  }
  if (role === 'host') {
    return (
      <section className="banner banner-info party-banner is-host" aria-label="Watch party">
        <span className="party-pulse" aria-hidden="true" />
        <p>
          <strong>Watch party live.</strong> {count}. Guests follow your view.{pending}
        </p>
        <div className="banner-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => useUi.getState().setDialog('party')}>
            Invite
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void endParty()}>
            End party
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="banner banner-info party-banner is-guest" aria-label="Watch party">
      <span className={`party-pulse${following ? '' : ' is-paused'}`} aria-hidden="true" />
      <p>
        {following ? (
          <>
            <strong>Following the host.</strong> {count}.
          </>
        ) : (
          <>
            <strong>Exploring on your own.</strong> The party goes on: {count}.
          </>
        )}
        {pending}
      </p>
      <div className="banner-actions">
        {following ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => followHost(false)}>
            Explore on my own
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => followHost(true)}>
            Follow the host
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => leaveParty()}>
          Leave
        </button>
      </div>
    </section>
  );
}

export function ReplayBar() {
  const source = useLive((s) => s.source);
  const hello = useLive((s) => s.hello);
  const guest = usePartyStore((s) => s.role === 'guest');
  const sessionId = source.kind === 'replay' ? source.sessionId : hello?.mode === 'replay' ? hello.replaySession : null;
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await replayApi.status(sessionId);
        if (!cancelled) {
          setStatus(s);
          setError(null);
          setExpired(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setExpired(e instanceof ApiError && e.status === 404);
        }
      }
    };
    void poll();
    const t = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessionId]);

  if (!sessionId) return null;
  const control = async (command: Parameters<typeof replayApi.control>[1]) => {
    try {
      setStatus(await replayApi.control(sessionId, command));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const virtual = status ? new Date(status.virtualTime) : null;
  // A watch party guest shares the host's replay session, so its clock is the host's to run.
  const canExit = source.kind === 'replay' && !guest;

  return (
    <section className="replay-bar" aria-label="Replay lab">
      <div className="replay-id">
        <FlaskConical size={16} strokeWidth={1.9} aria-hidden="true" />
        <div>
          <p className="replay-title">
            Replay lab{status ? `: ${status.label}` : ''}
            <span className={`tag ${status?.synthetic ? 'tag-attention' : 'tag-info'}`}>{status?.synthetic ? 'Synthetic test scenario' : 'Captured real games, not live'}</span>
          </p>
          <p className="replay-meta mono">
            {virtual ? `Replay time ${virtual.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Starting'}
            {status?.outage ? ' · simulated provider outage' : ''}
            {error ? ` · ${error}` : ''}
          </p>
        </div>
      </div>
      {expired && (
        <div className="replay-controls">
          <span className="replay-meta">This replay session ended: the server restarted or the session sat idle.</span>
          {source.kind === 'replay' && !guest && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setExpired(false);
                setStatus(null);
                useLive.getState().restartSession();
              }}
            >
              Start again
            </button>
          )}
        </div>
      )}
      {status && !expired && guest && (
        <div className="replay-controls">
          <span className="replay-meta">The watch party host runs this replay.</span>
        </div>
      )}
      {status && !expired && !guest && (
        <div className="replay-controls">
          <button type="button" className="icon-btn" aria-label={status.playing ? 'Pause replay' : 'Play replay'} onClick={() => control({ type: status.playing ? 'pause' : 'play' })}>
            {status.playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          </button>
          <button type="button" className="icon-btn" aria-label="Advance one minute of replay time" onClick={() => control({ type: 'step', seconds: 60 })}>
            <SkipForward size={16} aria-hidden="true" />
          </button>
          <label className="select select-sm">
            <span className="sr-only">Replay speed</span>
            <select value={status.speed} onChange={(e) => control({ type: 'speed', speed: Number(e.target.value) })}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </label>
          <label className="replay-seek">
            <span className="sr-only">Replay position</span>
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round(status.progress * 1000)}
              onChange={(e) => {
                useLive.getState().markTimelineJump();
                void control({ type: 'seek', progress: Number(e.target.value) / 1000 });
              }}
            />
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => control({ type: 'outage', seconds: 90 })} title="Make the replay provider fail for 90 seconds of real time">
            <WifiOff size={14} aria-hidden="true" /> Simulate outage
          </button>
          {canExit && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setParams({ replay: null })}>
              Exit to live
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function DelayBanner() {
  const delaySeconds = usePrefs((s) => s.delaySeconds);
  const presented = useLive((s) => s.presented);
  if (!delaySeconds) return null;
  const buffering = presented.status === 'buffering';
  return (
    <section className="banner banner-info" aria-live="polite">
      <p>
        <strong>Spoiler delay {delaySeconds}s.</strong>{' '}
        {buffering ? `Buffering: the first delayed update is ready in about ${Math.ceil(presented.readyInMs / 1000)}s. Nothing newer is shown before then.` : `Everything on screen, including alerts, is what was received ${delaySeconds} seconds ago.`}
      </p>
      <button type="button" className="link-btn" onClick={() => usePrefs.getState().setDelay(0)}>
        Turn off
      </button>
    </section>
  );
}

export function GraphicsNotice() {
  const status = useGraphics((s) => s.status);
  const losses = useGraphics((s) => s.losses);
  const effects = usePrefs((s) => s.effects);

  useEffect(() => {
    if (status !== 'lost' || losses >= 3) return;
    const t = setTimeout(() => useGraphics.getState().retry(), 4000);
    return () => clearTimeout(t);
  }, [status, losses]);

  if (status !== 'lost' || effects === 'flat') return null;
  return (
    <section className="banner banner-attention" role="status">
      <TriangleAlert size={16} aria-hidden="true" />
      <p>
        3D fields paused because the graphics context was lost. Showing 2D fields{losses < 3 ? ' and retrying shortly' : ''}.
      </p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => useGraphics.getState().retry()}>
        <RotateCcw size={14} aria-hidden="true" /> Retry 3D
      </button>
    </section>
  );
}

export function SharedBoardPrompt() {
  const { params } = useLocation();
  const raw = params.get(BOARD_PARAM);
  if (!raw) return null;
  const board = decodeBoard(raw);
  const dismiss = () => setParams({ [BOARD_PARAM]: null });
  if (!board) {
    return (
      <section className="banner banner-attention" role="status">
        <p>This board link is not valid, so nothing was changed.</p>
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismiss}>
          <X size={16} aria-hidden="true" />
        </button>
      </section>
    );
  }
  const apply = (save: boolean) => {
    const p = usePrefs.getState();
    const now = Date.now();
    const saved = {
      id: globalThis.crypto?.randomUUID?.() ?? `b${now}`,
      name: board.name,
      teams: board.teams,
      games: board.games,
      focus: board.focus,
      league: board.league,
      divisions: board.divisions.length ? board.divisions : p.divisions,
      layout: board.layout,
      density: board.density,
      filters: { ...p.filters, teams: board.teams },
      createdAt: now,
      updatedAt: now,
    };
    if (save) p.set({ boards: [...p.boards, saved] });
    p.applyBoard(saved);
    useUi.getState().showNotice(save ? `Saved and applied “${board.name}”` : `Applied “${board.name}”`);
    dismiss();
  };
  return (
    <section className="banner banner-info" role="status">
      <p>
        <strong>Shared board: {board.name}.</strong> {board.teams.length} {board.teams.length === 1 ? 'team' : 'teams'}, {board.games.length} pinned {board.games.length === 1 ? 'game' : 'games'}. Team boards show those teams on whichever day you pick.
      </p>
      <div className="banner-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => apply(false)}>
          Apply
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => apply(true)}>
          Save to my boards
        </button>
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismiss}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

export function ConnectionBanner() {
  const connection = useLive((s) => s.connection);
  const loaded = useLive((s) => s.world.loaded);
  if (connection.status !== 'offline' && !(connection.status === 'reconnecting' && loaded)) return null;
  return (
    <section className="banner banner-attention" role="status">
      <WifiOff size={16} aria-hidden="true" />
      <p>
        {connection.status === 'offline' ? 'Not connected to the Gridiron server.' : 'Connection lost. Reconnecting; everything shown is from before the interruption.'}
        {connection.error ? ` ${connection.error}` : ''}
      </p>
    </section>
  );
}
