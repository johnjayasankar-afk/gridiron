/**
 * The game page: a large 3D field with camera presets and a restrained orbit,
 * the scoreboard and situation, drive replay over reported plays, catch-up,
 * play-by-play, drives, scoring, team stats and broadcast information.
 * Historical views are shareable through ?play=<provider play id>.
 */
import { ArrowLeft, Bell, BellOff, ChevronLeft, ChevronRight, Copy, Crosshair, Minus, Pause, PictureInPicture2, Pin, PinOff, Play, Plus, RotateCcw, Share2, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import { openPopout, popoutSupported } from '../components/Popout';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { scoreText, statusShort, teamFor } from '../../shared/format';
import type { GameDetail, GameSummary } from '../../shared/model';
import { ADMIN_KINDS, isLiveOrPaused, parseGameId } from '../../shared/model';
import { planPlayAnimation, playInputFromEvent } from '../../shared/playAnimation';
import { catchUp, currentDriveId, firstOrderOfDrive, frameAt, inspectablePlays, scoringOrders, stepOrder } from '../../shared/replayFrames';
import { periodShort } from '../../shared/util';
import { navigate, setParams, useLocation } from '../app/router';
import { IconButton, Segmented } from '../components/controls';
import { fieldMessage } from '../components/GameCard';
import type { CameraPreset } from '../field/cameras';
import { FieldView } from '../field/FieldView';
import { usePlayAnimation } from '../field/usePlayAnimation';
import { useReducedMotion } from '../lib/motion';
import { copyText, gameSummaryText, shareLink } from '../lib/share';
import { useFieldMode } from '../state/graphics';
import { navigationOrder, useSlateModel } from '../state/hooks';
import { adjacentGameId } from '../state/navigation';
import { useLive, usePresentedWorld, type DetailState } from '../state/live';
import { usePrefs } from '../state/prefs';
import { bestSummary, displaySituation, staleGames } from '../state/selectors';
import { useUi, type Inspection } from '../state/ui';
import { DriveChart } from './detail/DriveChart';
import { GameFlowChart } from './detail/GameFlowChart';
import { OddsPanel } from './detail/OddsPanel';
import { CatchUpPanel, DriveExplorer, GameInfo, LeadersPanel, Scoreboard, ScoringTimeline, SituationPanel, StatsTable } from './detail/parts';
import { PlayByPlay } from './detail/PlayByPlay';
import { BufferingState } from './SlateView';

type Tab = 'plays' | 'drives' | 'scoring' | 'stats' | 'info';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'plays', label: 'Play-by-play' },
  { id: 'drives', label: 'Drives' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'stats', label: 'Team stats' },
  { id: 'info', label: 'Game info' },
];

function Tabs({ tab, onChange, children }: { tab: Tab; onChange: (tab: Tab) => void; children: ReactNode }) {
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const onKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let n = i;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    else return;
    e.preventDefault();
    onChange(TABS[n].id);
    refs.current[TABS[n].id]?.focus();
  };
  return (
    <section className="tabs">
      <div role="tablist" aria-label="Game details" className="tablist" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="tab"
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabpanel" tabIndex={0}>
        {children}
      </div>
    </section>
  );
}

const SEEN_PREFIX = 'gridiron.seen.';
const SEEN_TTL = 18 * 3_600_000;
let prunedSeen = false;

/** The last play order seen on an earlier visit (within 18 hours), for the catch-up summary. */
function useSeenOrder(id: string, detail: GameDetail | null, historical: boolean): number | null {
  const key = `${SEEN_PREFIX}${id}`;
  const [since] = useState<number | null>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as { order?: unknown; at?: unknown } | null;
      return raw && typeof raw.order === 'number' && typeof raw.at === 'number' && Date.now() - raw.at < SEEN_TTL ? raw.order : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!detail || historical) return;
    const plays = inspectablePlays(detail);
    const last = plays[plays.length - 1];
    if (!last) return;
    try {
      localStorage.setItem(key, JSON.stringify({ order: last.order, at: Date.now() }));
      if (!prunedSeen) {
        prunedSeen = true;
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (!k?.startsWith(SEEN_PREFIX)) continue;
          const v = JSON.parse(localStorage.getItem(k) ?? 'null') as { at?: number } | null;
          if (!v?.at || Date.now() - v.at > SEEN_TTL) localStorage.removeItem(k);
        }
      }
    } catch {
      /* storage is optional */
    }
  }, [detail, historical, key]);
  return since;
}

function CameraBar({ preset, onPreset, onReset, onZoom }: { preset: CameraPreset; onPreset: (p: CameraPreset) => void; onReset: () => void; onZoom: (factor: number) => void }) {
  return (
    <div className="camera-bar" role="group" aria-label="Camera">
      <Segmented<CameraPreset>
        label="Camera view"
        value={preset}
        options={[
          { value: 'isometric', label: 'Isometric' },
          { value: 'broadcast', label: 'Broadcast' },
          { value: 'top', label: 'Top-down' },
        ]}
        onChange={onPreset}
      />
      <IconButton label="Zoom in" icon={Plus} onClick={() => onZoom(0.8)} />
      <IconButton label="Zoom out" icon={Minus} onClick={() => onZoom(1.25)} />
      <IconButton label="Reset camera" icon={RotateCcw} onClick={onReset} />
    </div>
  );
}

type Inspect = (order: number | null, options?: { playing?: boolean; driveId?: string | null }) => void;

function ReplayControls({ detail, game, inspection, onInspect, newPlays }: { detail: GameDetail; game: GameSummary; inspection: Inspection; onInspect: Inspect; newPlays: number }) {
  const driveId = inspection.driveId;
  const plays = inspectablePlays(detail, driveId);
  const order = inspection.order;
  const historical = order !== null;
  const index = order === null ? plays.length - 1 : plays.findIndex((p) => p.order === order);
  const selected = order === null ? null : (detail.plays.find((p) => p.order === order) ?? null);
  const scoring = scoringOrders(detail);
  const current = currentDriveId(detail);
  const live = isLiveOrPaused(game.status.kind);
  const patch = useUi.getState().patchInspection;

  const togglePlay = () => {
    if (inspection.playing) return patch({ playing: false });
    const start = order === null || index >= plays.length - 1 ? (plays[0]?.order ?? null) : order;
    if (start !== null) onInspect(start, { playing: true });
  };

  return (
    <section className="replay-panel" aria-label="Drive replay">
      <div className="rp-row">
        <div className="rp-buttons">
          <IconButton label={driveId ? 'First play of the drive' : 'First play of the game'} icon={SkipBack} disabled={!plays.length} onClick={() => onInspect(plays[0]?.order ?? null)} />
          <IconButton label="Previous play" icon={StepBack} disabled={!plays.length || (historical && index <= 0)} onClick={() => onInspect(stepOrder(detail, order, -1, driveId))} />
          <button type="button" className="btn btn-primary btn-sm rp-play" onClick={togglePlay} disabled={!plays.length}>
            {inspection.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            <span>{inspection.playing ? 'Pause' : driveId ? 'Play drive' : 'Play'}</span>
          </button>
          <IconButton label="Next play" icon={StepForward} disabled={!historical || index >= plays.length - 1} onClick={() => onInspect(stepOrder(detail, order, 1, driveId))} />
          <IconButton label="Latest play" icon={SkipForward} disabled={!plays.length} onClick={() => onInspect(plays[plays.length - 1]?.order ?? null)} />
          <label className="select select-sm">
            <span className="sr-only">Replay speed</span>
            <select value={inspection.speed} onChange={(e) => patch({ speed: Number(e.target.value) as Inspection['speed'] })}>
              {[0.5, 1, 2, 4].map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="rp-status">
          {newPlays > 0 && (
            <span className="tag tag-attention" role="status">
              {newPlays} new {newPlays === 1 ? 'play' : 'plays'} available
            </span>
          )}
          {historical ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onInspect(null)}>
              {live ? 'Back to live' : 'Back to latest'}
            </button>
          ) : (
            <span className={`tag${live ? ' tag-live' : ''}`}>{live ? 'Showing live' : 'Showing the latest play'}</span>
          )}
        </div>
      </div>
      <label className="rp-scrub">
        <span className="sr-only">Scrub through plays</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, plays.length - 1)}
          step={1}
          value={Math.max(0, index)}
          disabled={plays.length < 2}
          aria-valuetext={selected ? `Play ${index + 1} of ${plays.length}: ${selected.description}` : `Latest of ${plays.length} plays`}
          onChange={(e) => onInspect(plays[Number(e.target.value)]?.order ?? null)}
        />
      </label>
      <div className="rp-row rp-jumps">
        <p className="rp-readout mono">
          {selected ? `Play ${index + 1} of ${plays.length} · ${[periodShort(selected.period, game.status.regulationPeriods), selected.clock].filter(Boolean).join(' ')}` : `${plays.length} plays${driveId ? ' in this drive' : ''}`}
        </p>
        <label className="select select-sm">
          <span className="sr-only">Jump to a scoring play</span>
          <select
            value=""
            disabled={!scoring.length}
            onChange={(e) => {
              if (e.target.value) onInspect(Number(e.target.value), { driveId: null });
            }}
          >
            <option value="">Scoring plays ({scoring.length})</option>
            {scoring.map((o) => {
              const p = detail.plays.find((x) => x.order === o);
              if (!p) return null;
              const team = teamFor(game, p.scoringTeam ?? p.offense);
              const what = p.kind.startsWith('touchdown') ? 'touchdown' : p.kind === 'field_goal_good' ? 'field goal' : p.kind === 'safety' ? 'safety' : 'score';
              return (
                <option key={o} value={o}>
                  {[periodShort(p.period, game.status.regulationPeriods), p.clock, team?.abbreviation, what].filter(Boolean).join(' ')}
                </option>
              );
            })}
          </select>
        </label>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!current} onClick={() => onInspect(firstOrderOfDrive(detail, current), { driveId: current })}>
          Current drive
        </button>
        <Segmented<'game' | 'drive'>
          label="Replay scope"
          value={driveId ? 'drive' : 'game'}
          options={[
            { value: 'game', label: 'Whole game' },
            { value: 'drive', label: 'This drive' },
          ]}
          onChange={(v) => {
            if (v === 'game') patch({ driveId: null });
            else {
              const d = selected?.driveId ?? current;
              if (d) patch({ driveId: d });
            }
          }}
        />
      </div>
    </section>
  );
}

/** Previous and next game, in the order the slate shows them. */
function GameNav({ id }: { id: string }) {
  const model = useSlateModel();
  const order = useMemo(() => navigationOrder(model), [model]);
  const index = order.indexOf(id);
  if (index === -1 || order.length < 2) return null;
  const prev = index > 0 ? bestSummary(model.world, order[index - 1]) : null;
  const next = index < order.length - 1 ? bestSummary(model.world, order[index + 1]) : null;
  const name = (g: GameSummary) => `${g.away.abbreviation} at ${g.home.abbreviation}`;
  return (
    <nav className="game-nav" aria-label="Other games on the slate">
      <IconButton label={prev ? `Previous game: ${name(prev)}` : 'No previous game'} icon={ChevronLeft} disabled={!prev} onClick={() => prev && navigate({ name: 'game', id: prev.id })} />
      <span className="game-nav-pos mono" aria-hidden="true">
        {index + 1}/{order.length}
      </span>
      <IconButton label={next ? `Next game: ${name(next)}` : 'No next game'} icon={ChevronRight} disabled={!next} onClick={() => next && navigate({ name: 'game', id: next.id })} />
    </nav>
  );
}

function DetailPending({ entry, game }: { entry: DetailState | undefined; game: GameSummary }) {
  if (game.coverage.level === 'score-only') return <p className="empty-note">Score-only coverage: the provider does not report play-by-play, drives or team stats for this game.</p>;
  if (entry && !entry.detail && entry.freshness.health === 'unavailable') return <p className="empty-note">Play-by-play could not be loaded ({entry.freshness.error ?? 'provider unavailable'}). Retrying automatically.</p>;
  if (game.status.kind === 'scheduled') return <p className="empty-note">Play-by-play starts at kickoff.</p>;
  return <p className="empty-note">Loading play-by-play…</p>;
}

export function DetailView({ id }: { id: string }) {
  const valid = parseGameId(id) !== null;
  const world = usePresentedWorld();
  const presented = useLive((s) => s.presented);
  const connectionDown = useLive((s) => s.connection.status === 'reconnecting' || s.connection.status === 'offline');
  const game = valid ? bestSummary(world, id) : null;
  const entry = world.details[id];
  const detail = entry?.detail ?? null;
  const { params } = useLocation();
  const inspection = useUi((s) => (s.inspection?.gameId === id ? s.inspection : null));
  const reducedMotion = useReducedMotion();
  const fieldMode = useFieldMode();
  const bigPlayYards = usePrefs((s) => s.alertRules.bigPlayYards);
  const pinned = usePrefs((s) => s.pinned.includes(id));
  const muted = usePrefs((s) => s.mutedGames.includes(id));
  const inFocus = usePrefs((s) => s.focusGames.includes(id));
  const [preset, setPreset] = useState<CameraPreset>('isometric');
  const [resetToken, setResetToken] = useState(0);
  const [zoomEnabled, setZoomEnabled] = useState(false);
  const [zoom, setZoom] = useState({ token: 0, factor: 1 });
  const [tab, setTab] = useState<Tab>('plays');
  const swipe = useRef<{ x: number; y: number; pointer: number } | null>(null);

  useEffect(() => {
    useUi.getState().setInspection({ gameId: id, order: null, playing: false, speed: 1, driveId: null, knownPlays: 0 });
    return () => useUi.getState().setInspection(null);
  }, [id]);

  const plays = useMemo(() => (detail ? inspectablePlays(detail) : []), [detail]);
  const historical = inspection?.order != null;

  const inspect = useCallback<Inspect>(
    (order, options = {}) => {
      const ui = useUi.getState();
      const cur = ui.inspection;
      if (!cur || cur.gameId !== id) return;
      if (order === null) {
        ui.patchInspection({ order: null, playing: false, driveId: null });
        setParams({ play: null });
        return;
      }
      const play = detail?.plays.find((p) => p.order === order);
      ui.patchInspection({
        order,
        playing: options.playing ?? false,
        driveId: options.driveId !== undefined ? options.driveId : cur.driveId,
        knownPlays: cur.order === null ? plays.length : cur.knownPlays,
      });
      if (play) setParams({ play: play.providerId });
    },
    [id, detail, plays.length],
  );

  // A shared link can open a specific play.
  const playParam = params.get('play');
  const appliedParam = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !inspection || !playParam || appliedParam.current === playParam) return;
    appliedParam.current = playParam;
    const p = detail.plays.find((x) => x.providerId === playParam);
    if (p && !ADMIN_KINDS.has(p.kind) && inspection.order !== p.order) inspect(p.order, { driveId: null });
  }, [detail, playParam, inspection, inspect]);

  // Replay playback steps through reported plays.
  useEffect(() => {
    if (!inspection?.playing || !detail || inspection.order === null) return;
    const t = setTimeout(() => {
      const next = stepOrder(detail, inspection.order, 1, inspection.driveId);
      if (next === null || next === inspection.order) useUi.getState().patchInspection({ playing: false });
      else inspect(next, { playing: true });
    }, Math.max(600, 2200 / inspection.speed));
    return () => clearTimeout(t);
  }, [inspection?.playing, inspection?.order, inspection?.speed, inspection?.driveId, detail, inspect]); // eslint-disable-line react-hooks/exhaustive-deps

  const frame = historical && detail && inspection?.order != null ? frameAt(detail, inspection.order) : null;
  const liveSituation = game ? displaySituation(game, detail) : { situation: null, lastKnown: false };
  const liveMoment = usePlayAnimation(detail, liveSituation.situation, { reducedMotion, afterGap: world.afterGap, paused: historical });

  const previousFrame = useRef<number | null>(null);
  const frameAnimation = useMemo(() => {
    if (!frame || !detail) return null;
    const prev = previousFrame.current;
    const steppedForward = prev !== null && stepOrder(detail, prev, 1) === frame.play.order;
    return planPlayAnimation(null, playInputFromEvent(frame.play), { reducedMotion, burst: !steppedForward });
  }, [frame?.play.id, frame?.play.revision, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    previousFrame.current = frame?.play.order ?? null;
  }, [frame?.play.order]);

  const since = useSeenOrder(id, detail, historical);
  const summary = useMemo(() => (detail ? catchUp(detail, since, bigPlayYards) : null), [detail, since, bigPlayYards]);

  useEffect(() => {
    if (game) document.title = `${scoreText(game)} · ${statusShort(game.status)} · Gridiron`;
  }, [game]);

  if (!valid) {
    return (
      <div className="state-block">
        <p className="eyebrow">Game</p>
        <h1 className="state-title">That game link is not valid.</h1>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'slate' })}>
          Go to the slate
        </button>
      </div>
    );
  }
  if (presented.status === 'buffering') return <BufferingState readyInMs={presented.readyInMs} />;
  if (!game) {
    const failed = !!entry && !entry.detail && entry.freshness.health === 'unavailable';
    return (
      <div className="state-block" aria-busy={!failed}>
        <button type="button" className="btn btn-ghost btn-sm state-back" onClick={() => navigate({ name: 'slate' })}>
          <ArrowLeft size={14} aria-hidden="true" /> Slate
        </button>
        <p className="eyebrow">Game</p>
        <h1 className="state-title">{failed ? 'This game could not be loaded.' : 'Loading the game'}</h1>
        <p className="muted">{failed ? (entry?.freshness.error ?? 'The provider did not return this game.') : 'Requesting the game summary from the provider.'}</p>
      </div>
    );
  }

  const live = isLiveOrPaused(game.status.kind);
  const stale = staleGames(world, connectionDown).has(id);
  const fieldSituation = frame ? frame.situation : liveSituation.situation;
  const hasSpot = !!fieldSituation && fieldSituation.spot.schematicYard !== null && (frame !== null || live);
  const message = frame ? (hasSpot ? null : 'Ball spot unavailable for this play') : fieldMessage(game, hasSpot);
  const label = frame ? (frameAnimation?.label ?? null) : liveMoment.label;
  const labelKey = frame ? `frame:${frame.play.id}` : (liveMoment.labelKey ?? 'live');
  const newPlays = historical && inspection ? Math.max(0, plays.length - inspection.knownPlays) : 0;

  const share = async () => {
    const result = await shareLink(window.location.href, document.title);
    useUi.getState().showNotice(result === 'failed' ? 'Could not copy the link' : result === 'copied' ? 'Link copied' : 'Link shared');
  };
  const copySummary = async () => {
    const ok = await copyText(gameSummaryText(game, liveSituation.situation));
    useUi.getState().showNotice(ok ? 'Summary copied' : 'Could not copy the summary');
  };
  const selectPlay = (order: number | null) => inspect(order, { driveId: null });
  const selectFromFlow = (order: number) => {
    selectPlay(order);
    document.querySelector('.detail-field-wrap')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  return (
    <article className="detail" aria-labelledby="detail-title">
      <div className="detail-top">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'slate' })}>
          <ArrowLeft size={14} aria-hidden="true" /> Slate
        </button>
        <h1 id="detail-title" className="detail-title">
          {game.away.displayName} <span className="muted">at</span> {game.home.displayName}
        </h1>
        <GameNav id={id} />
        <div className="detail-actions">
          <IconButton label={pinned ? 'Unpin game' : 'Pin game'} icon={pinned ? PinOff : Pin} pressed={pinned} onClick={() => usePrefs.getState().togglePin(id)} />
          <IconButton label={inFocus ? 'Remove from focus' : 'Add to focus'} icon={Crosshair} pressed={inFocus} onClick={() => (inFocus ? usePrefs.getState().removeFromFocus(id) : usePrefs.getState().addToFocus(id))} />
          <IconButton label={muted ? 'Unmute alerts for this game' : 'Mute alerts for this game'} icon={muted ? BellOff : Bell} pressed={muted} onClick={() => usePrefs.getState().toggleMute(id)} />
          <IconButton label="Share a link to this view" icon={Share2} onClick={() => void share()} />
          <IconButton label="Copy a text summary" icon={Copy} onClick={() => void copySummary()} />
          {popoutSupported() && <IconButton label="Pop out a live tracker window" icon={PictureInPicture2} onClick={() => void openPopout(id)} />}
        </div>
      </div>

      <div
        className="sb-swipe"
        onPointerDown={(e) => {
          if (e.pointerType === 'touch') swipe.current = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
        }}
        onPointerUp={(e) => {
          const start = swipe.current;
          swipe.current = null;
          if (!start || start.pointer !== e.pointerId) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (Math.abs(dx) < 70 || Math.abs(dy) > 45) return;
          const target = adjacentGameId(id, dx < 0 ? 1 : -1);
          if (target) navigate({ name: 'game', id: target });
        }}
        onPointerCancel={() => {
          swipe.current = null;
        }}
      >
        <Scoreboard game={game} situation={liveSituation.situation} />
      </div>
      {stale && (
        <section className="banner banner-attention" role="status">
          <p>Updates for this game are delayed. Everything shown is the last reported information.</p>
        </section>
      )}

      <div className="detail-stage">
        <div className="detail-field-wrap" onPointerDown={() => setZoomEnabled(true)} onPointerLeave={() => setZoomEnabled(false)}>
          <FieldView
            game={game}
            situation={hasSpot ? fieldSituation : null}
            animation={frame ? frameAnimation : liveMoment.animation}
            variant="detail"
            hidden={!hasSpot}
            historical={!!frame}
            preset={preset}
            resetToken={resetToken}
            zoomEnabled={zoomEnabled}
            zoomRequest={zoom}
          >
            {stale && <span className="field-dim" aria-hidden="true" />}
            {fieldMode === '3d' && (
              <CameraBar
                preset={preset}
                onPreset={setPreset}
                onReset={() => {
                  setPreset('isometric');
                  setResetToken((t) => t + 1);
                }}
                onZoom={(factor) => setZoom((z) => ({ token: z.token + 1, factor }))}
              />
            )}
            {message && <span className="field-message">{message}</span>}
            <span className="field-tags" aria-hidden="true">
              {frame && <span className="field-tag tag-history">Historical view</span>}
              {!frame && liveSituation.lastKnown && hasSpot && <span className="field-tag">Last known spot</span>}
            </span>
            {label && (
              <span key={labelKey} className={`field-label${!frame && liveMoment.corrected ? ' is-correction' : ''}`} aria-hidden="true">
                {label}
              </span>
            )}
            <span className="field-orientation mono" aria-hidden="true">
              Schematic · {game.away.abbreviation} defends left
            </span>
            {fieldMode === '3d' && (
              <span className="field-hint" aria-hidden="true">
                {zoomEnabled ? 'Drag to orbit · scroll to zoom' : 'Drag to orbit · click, then scroll to zoom'}
              </span>
            )}
          </FieldView>
        </div>
        {detail && inspection && plays.length > 0 && <ReplayControls detail={detail} game={game} inspection={inspection} onInspect={inspect} newPlays={newPlays} />}
        <aside className="detail-side">
          <SituationPanel game={game} situation={fieldSituation} lastKnown={!frame && liveSituation.lastKnown} frame={frame} />
          <OddsPanel game={game} detail={detail} frame={frame} replay={world.mode === 'replay'} />
          {detail && game.status.kind !== 'scheduled' && <DriveChart detail={detail} game={game} situation={liveSituation.situation} frame={frame} onSelectPlay={(order, driveId) => inspect(order, { driveId })} />}
          {summary && plays.length > 0 && <CatchUpPanel summary={summary} sinceLabel={since === null ? 'Key moments' : 'Since your last visit'} onSelect={(o) => selectPlay(o)} />}
          {detail && <LeadersPanel detail={detail} game={game} />}
        </aside>

        {detail && <GameFlowChart game={game} detail={detail} selectedOrder={inspection?.order ?? null} onSelectPlay={selectFromFlow} />}

        <Tabs tab={tab} onChange={setTab}>
          {tab === 'plays' && (detail ? <PlayByPlay detail={detail} game={game} selectedOrder={inspection?.order ?? null} onSelect={selectPlay} bigPlayYards={bigPlayYards} /> : <DetailPending entry={entry} game={game} />)}
          {tab === 'drives' &&
            (detail ? (
              <DriveExplorer
                detail={detail}
                game={game}
                activeDriveId={inspection?.driveId ?? null}
                onReplayDrive={(driveId) => {
                  const first = firstOrderOfDrive(detail, driveId);
                  if (first !== null) inspect(first, { driveId, playing: true });
                }}
                onSelectPlay={(order, driveId) => inspect(order, { driveId })}
              />
            ) : (
              <DetailPending entry={entry} game={game} />
            ))}
          {tab === 'scoring' && (detail ? <ScoringTimeline detail={detail} game={game} onSelectPlay={(o) => selectPlay(o)} /> : <DetailPending entry={entry} game={game} />)}
          {tab === 'stats' && (detail ? <StatsTable detail={detail} game={game} /> : <DetailPending entry={entry} game={game} />)}
          {tab === 'info' && <GameInfo game={game} detail={detail} />}
        </Tabs>
      </div>
    </article>
  );
}
