/**
 * The tape: the whole day on one clock.
 *
 * The slate answers "what is happening now" and the game page answers "what is
 * happening in this game". Neither can answer the question a football Sunday is
 * actually about, which is how a dozen games sit against each other in time:
 * which one has been worth watching, where the day's swings landed, and which
 * games are arriving at their endgames together. A grid cannot show that,
 * because a grid has no time in it.
 *
 * Everything here is measured from what the provider reported, recorded on this
 * device as it arrived. Nothing is predicted and nothing is scored for
 * excitement: "movement" is the sum of the changes the provider's own win
 * probability made, and the page says so.
 */
import { Radio } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { scoreText, statusShort } from '../../shared/format';
import { periodShort } from '../../shared/util';
import type { GameSummary } from '../../shared/model';
import { isLiveOrPaused } from '../../shared/model';
import { convergence, dayHighlights, rankByMovement, stateAt, tapeSpan, type TapeTrack } from '../../shared/tape';
import { navigate } from '../app/router';
import { LANE_HEIGHT, TapeLane, TapeLaneMarks } from '../components/TapeLane';
import { useIsDark } from '../lib/theme';
import { useNow } from '../lib/motion';
import { useSlateModel } from '../state/hooks';
import { useLive } from '../state/live';
import { useTape } from '../state/tape';
import { tapeNow } from '../app/useTape';

/**
 * The right edge of the tape, rounded up so the lanes are not rebuilt on every
 * tick. The live marker is drawn at the true moment, so nothing visible lags.
 */
const EDGE_STEP_MS = 15_000;
/** Below this the day is too short to read as a day, and the lanes say so instead of drawing a sliver. */
const MIN_SPAN_MS = 60_000;

/**
 * Where a moment on a lane leads.
 *
 * The tape records which play each reading followed, and the game page already
 * opens at a play, so a point on a lane is a point on the field. Without a
 * reported play there is nothing to open at, and the game opens as it is rather
 * than at a guess.
 */
function openMoment(gameId: string, sample: { play: string | null } | null) {
  navigate({ name: 'game', id: gameId }, sample?.play ? { params: { play: sample.play } } : undefined);
}

function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Ticks on the hour and half hour, thinned to whatever fits. */
function axisTicks(from: number, to: number, width: number): number[] {
  const span = to - from;
  if (span <= 0 || width <= 0) return [];
  const every = [15, 30, 60, 120, 180].map((m) => m * 60_000).find((ms) => (span / ms) * 1 <= Math.max(2, width / 90)) ?? 4 * 3_600_000;
  const first = Math.ceil(from / every) * every;
  const ticks: number[] = [];
  for (let t = first; t <= to; t += every) ticks.push(t);
  return ticks;
}

/**
 * The band column's width and where it starts inside the grid. Both are needed:
 * every lane draws into the width, and the scrub line has to stand in the same
 * column while spanning every row, which it can only do from the grid.
 */
function useBand(): { ref: (el: HTMLDivElement | null) => void; node: HTMLDivElement | null; width: number; left: number } {
  // A callback ref rather than useRef: the empty tape renders a different tree,
  // so the element appears later than the first layout effect. A ref object
  // would still be null then and the effect would never run again.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, left: 0 });
  useLayoutEffect(() => {
    if (!node) return;
    const read = () => setBox({ width: Math.round(node.getBoundingClientRect().width), left: node.offsetLeft });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(node);
    if (node.offsetParent instanceof Element) ro.observe(node.offsetParent);
    return () => ro.disconnect();
  }, [node]);
  return { ref: setNode, node, width: box.width, left: box.left };
}

export function TapeView() {
  const dark = useIsDark();
  const model = useSlateModel();
  const order = useTape((s) => s.order);
  const tracks = useTape((s) => s.tracks);
  const replayClock = useLive((s) => s.replayClock);
  const wall = useNow(1000);
  const { ref: axisRef, node: axisNode, width, left } = useBand();
  const [scrubAt, setScrubAt] = useState<number | null>(null);

  const all = useMemo(() => order.map((id) => tracks[id]).filter(Boolean) as TapeTrack[], [order, tracks]);
  const byId = useMemo(() => new Map(model.all.map((g) => [g.id, g])), [model.all]);
  /** Only games still on the presented day: yesterday's tape is not this day's. */
  const present = useMemo(() => all.filter((t) => byId.has(t.gameId)), [all, byId]);

  const now = tapeNow(replayClock, wall);
  const span = useMemo(() => tapeSpan(present), [present]);
  const ranked = useMemo(() => rankByMovement(present), [present]);
  /** A Saturday can put sixty games on the card; finding each one by scan would be sixty scans. */
  const trackById = useMemo(() => new Map(present.map((t) => [t.gameId, t])), [present]);
  const anyLive = ranked.some((r) => r.stats.live);
  const from = span ? span.from : now;
  // The right edge follows the clock only while something is still going. Once
  // the card is done the tape is a finished thing and must not keep stretching
  // into an empty evening.
  const edge = span ? (anyLive ? Math.max(span.to, now) : span.to) : now;
  const to = Math.max(Math.ceil(edge / EDGE_STEP_MS) * EDGE_STEP_MS, from + MIN_SPAN_MS);
  const highlights = useMemo(() => dayHighlights(present), [present]);
  const together = useMemo(() => convergence(model.inScope), [model.inScope]);
  const ticks = useMemo(() => axisTicks(from, to, width), [from, to, width]);

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!axisNode || width <= 0) return;
      const rect = axisNode.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setScrubAt(from + ratio * (to - from));
    },
    [from, to, width, axisNode],
  );

  /**
   * The same reading by keyboard. Pointing at the tape is the whole of how it
   * is read, and without this a keyboard cannot read it at all: the lanes were
   * reachable, but the moment under the pointer was not.
   *
   * A step is a fortieth of the day, so one arrow is a few minutes of an
   * afternoon whatever the tape spans, and shift is a coarse step for crossing
   * it quickly.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const span = to - from;
      const step = (e.shiftKey ? span / 8 : span / 40) || 0;
      const at = scrubAt ?? to;
      let next: number | null = null;
      if (e.key === 'ArrowRight') next = Math.min(to, at + step);
      else if (e.key === 'ArrowLeft') next = Math.max(from, at - step);
      else if (e.key === 'Home') next = from;
      else if (e.key === 'End') next = to;
      else if (e.key === 'Escape' && scrubAt !== null) next = null;
      else return;
      // Arrows only. Enter belongs to whichever band has focus, which is what
      // decides the game; the keyboard decides the moment.

      e.preventDefault();
      setScrubAt(next);
    },
    [from, to, scrubAt],
  );

  if (!ranked.length) {
    return (
      <section className="tape" aria-labelledby="tape-title">
        <TapeHead id="tape-title" from={null} to={null} live={0} />
        <p className="tape__empty">
          Nothing has been recorded yet. The tape is written while Gridiron is open: once a game is under way its reported score and win probability are kept here, on this device, with the
          moment each was true. It is not fetched, so it begins when you arrive.
        </p>
      </section>
    );
  }

  const liveCount = ranked.filter((r) => r.stats.live).length;
  const scrubX = scrubAt === null || width <= 0 ? null : ((scrubAt - from) / Math.max(1, to - from)) * width;

  return (
    <section className="tape" aria-labelledby="tape-title">
      <TapeHead id="tape-title" from={from} to={to} live={liveCount} />

      {together && (
        <p className="tape__together">
          <Radio size={15} strokeWidth={2} aria-hidden="true" />
          <span>
            <strong>{together.games.length} games are finishing together.</strong> Each is within one score in the last five minutes of regulation or beyond.
          </span>
          <span className="tape__together-names">{together.games.map((id) => byId.get(id)?.shortName ?? id).join(' · ')}</span>
        </p>
      )}

      <TapeSummary highlights={highlights} byId={byId} />

      <div
        className="tape__grid"
        onPointerMove={onMove}
        onPointerLeave={() => setScrubAt(null)}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setScrubAt(null);
        }}
        tabIndex={0}
        role="group"
        aria-label="The day's lanes. Use the arrow keys to read every game at one moment."
        style={{ '--lane-h': `${LANE_HEIGHT}px` } as React.CSSProperties}
      >
        <div className="tape__axis" ref={axisRef} aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="tape__tick mono" style={{ left: `${((t - from) / Math.max(1, to - from)) * 100}%` }}>
              {clockLabel(t)}
            </span>
          ))}
        </div>
        <div className="tape__colhead" aria-hidden="true">
          <span>Movement</span>
        </div>
        {scrubX !== null && (
          <div className="tape__scrub" style={{ left: `${left + scrubX}px` }} aria-hidden="true">
            <span className="tape__scrub-time mono">{clockLabel(scrubAt!)}</span>
          </div>
        )}
        <ol className="tape__list">
          {ranked.map((row, i) => {
            const game = byId.get(row.gameId);
            const track = trackById.get(row.gameId);
            if (!game || !track) return null;
            return (
              <TapeRow
                key={row.gameId}
                index={i}
                game={game}
                track={track}
                from={from}
                to={to}
                width={width}
                dark={dark}
                scrubAt={scrubAt}
                now={now}
                reasons={row.reasons}
                movement={row.stats.movement}
              />
            );
          })}
        </ol>
      </div>

      <p className="sr-only" aria-live="polite">
        {scrubAt === null ? '' : `Reading ${clockLabel(scrubAt)}`}
      </p>

      <p className="tape__note">
        Each band is the home team's chance to win as the provider reported it, drawn from the centre line out, so the thickness is the margin: a close game is a thin line down the middle
        and a game that turned crosses it. Upright marks are score changes. Movement is the sum of every change the provider's model made, added up over the day in probability points,
        which is a measurement of what was reported and not a rating of the game. A game whose provider reported no win probability shows none rather than a zero.
      </p>
    </section>
  );
}

/**
 * What the recording can say about the day without being asked about a game.
 * Each item names the measurement rather than a verdict: the game whose
 * reported chance has moved most is not "the best game", and calling it that
 * would be putting a rating on somebody else's model.
 */
function TapeSummary({ highlights, byId }: { highlights: ReturnType<typeof dayHighlights>; byId: Map<string, GameSummary> }) {
  const name = (id: string) => byId.get(id)?.shortName ?? id;
  const items: Array<{ key: string; label: string; value: string; detail: string; gameId: string; play?: string | null }> = [];

  if (highlights.mostMovement) {
    items.push({
      key: 'movement',
      label: 'Most movement',
      value: name(highlights.mostMovement.gameId),
      detail: `${Math.round(highlights.mostMovement.movement * 100)} points of reported win probability, added up`,
      gameId: highlights.mostMovement.gameId,
    });
  }
  if (highlights.biggestSwing) {
    const s = highlights.biggestSwing;
    items.push({
      key: 'swing',
      label: 'Biggest swing',
      value: `${Math.round(Math.abs(s.swing) * 100)} points`,
      detail: `${name(s.gameId)} at ${clockLabel(s.sample.at)}`,
      gameId: s.gameId,
      // The day's biggest swing was one play. This opens that play, not the game
      // it happened in.
      play: s.sample.play,
    });
  }
  if (highlights.mostLeadChanges) {
    const l = highlights.mostLeadChanges;
    items.push({
      key: 'lead',
      label: 'Most lead changes',
      value: name(l.gameId),
      detail: `${l.leadChanges} time${l.leadChanges === 1 ? '' : 's'} the lead changed hands`,
      gameId: l.gameId,
    });
  }
  if (!items.length) return null;

  return (
    <ul className="tape__summary">
      {items.map((item, i) => (
        <li key={item.key} style={{ '--card-i': i } as React.CSSProperties}>
          <button type="button" className="tape-summary-pane" onClick={() => openMoment(item.gameId, item.play ? { play: item.play } : null)}>
            <span className="tape__summary-label">{item.label}</span>
            <span className="tape__summary-value">{item.value}</span>
            <span className="tape__summary-detail">
              {item.detail}
              {item.play ? <span className="tape__summary-go">Open the play</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TapeHead({ id, from, to, live }: { id: string; from: number | null; to: number | null; live: number }) {
  return (
    <header className="tape__head">
      <div>
        <h2 id={id}>The tape</h2>
        <p className="tape__sub">
          {from !== null && to !== null ? (
            <>
              <span className="mono">{clockLabel(from)}</span> to <span className="mono">{clockLabel(to)}</span>
              {live > 0 ? ` · ${live} still live` : ''}
            </>
          ) : (
            'The day, on one clock'
          )}
        </p>
      </div>
    </header>
  );
}

interface TapeRowProps {
  game: GameSummary;
  track: TapeTrack;
  from: number;
  to: number;
  width: number;
  dark: boolean;
  scrubAt: number | null;
  now: number;
  reasons: string[];
  movement: number | null;
  /** Its place in the order, which the entrance steps through. */
  index: number;
}

function TapeRow({ game, track, from, to, width, dark, scrubAt, now, reasons, movement, index }: TapeRowProps) {
  const at = scrubAt === null ? null : stateAt(track, scrubAt);
  const live = isLiveOrPaused(game.status.kind);
  /**
   * While scrubbing, the row reads as the game was then; otherwise as it is.
   * The provider does not always report a clock, so the period stands alone
   * rather than leaving the column empty, and periodShort is what knows that
   * the fifth period is called OT.
   */
  const when = at
    ? [periodShort(at.period, game.status.regulationPeriods), at.clock].filter(Boolean).join(' ') || statusShort({ ...game.status, kind: at.kind, period: at.period, clock: at.clock })
    : statusShort(game.status);
  const shown = at ? { home: at.home, away: at.away, when } : { home: game.score.home, away: game.score.away, when };

  return (
    <li className={`tape-lane${live ? ' is-live' : ''}`} data-game={game.id} style={{ '--lane-i': index } as React.CSSProperties}>
      <button
        type="button"
        className="tape-lane__open"
        onClick={() => navigate({ name: 'game', id: game.id })}
        aria-label={`${game.name}, ${scoreText(game)}. ${reasons.join('. ')}`}
      >
        <span className="tape-lane__teams">
          <span className="tape-lane__team">{game.away.abbreviation}</span>
          <span className="tape-lane__at">at</span>
          <span className="tape-lane__team">{game.home.abbreviation}</span>
        </span>
        <span className="tape-lane__score mono">
          {shown.away ?? '-'}
          <span className="tape-lane__dash">-</span>
          {shown.home ?? '-'}
        </span>
      </button>
      <button
        type="button"
        className="tape-lane__band"
        onClick={() => openMoment(game.id, at ?? track.samples[track.samples.length - 1] ?? null)}
        aria-label={
          at
            ? `Open ${game.name} at ${when}${at.play ? ', on the field' : ''}`
            : `Open ${game.name}`
        }
      >
        <TapeLane game={game} track={track} from={from} to={to} width={width} dark={dark} />
        <TapeLaneMarks track={track} live={live} from={from} to={to} width={width} scrubAt={scrubAt} now={now} />
      </button>
      <div className="tape-lane__meta">
        <span className="tape-lane__when mono">{shown.when ?? ''}</span>
        <span className={`tape-lane__movement mono${movement === null ? ' is-none' : ''}`} title={reasons.length ? reasons.join('. ') : 'No win probability was reported for this game'}>
          {movement === null ? 'none' : Math.round(movement * 100)}
        </span>
      </div>
    </li>
  );
}
