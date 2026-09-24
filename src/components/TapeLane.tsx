/**
 * One game's lane on the tape: the reported win probability drawn across the
 * day, as the distance from an even chance, with the pressure that produced it
 * along the bottom.
 *
 * The ribbon itself is drawn by ./ribbon, which the pulse on a game card uses
 * too, so the two can never disagree about what the day did. Thirteen lanes
 * stacked is a Sunday you can read at a glance.
 *
 * Under the band runs a second track: where a team was inside the twenty, in
 * that team's colour. The recorder already keeps it, so it costs one more pass
 * over the same array inside the same drawing, and it turns the lane from "who
 * was winning" into "who was winning, and who was knocking". Clusters of red
 * zone before a score mark are a drive that finished; a long bar with no mark
 * after it is one that did not.
 *
 * Nothing here animates. It is one static drawing per lane, rebuilt only when
 * that lane's own samples change, so a tape of sixty games costs the frame
 * nothing at all once it is on screen.
 */
import { memo, useId, useMemo } from 'react';
import type { GameSummary, Side } from '../../shared/model';
import type { TapeSample, TapeTrack } from '../../shared/tape';
import { stateAt } from '../../shared/tape';
import { accentFor, withAlpha } from '../field/color';
import { ribbon } from './ribbon';

export const LANE_HEIGHT = 38;
/** The pressure track along the bottom: enough to read, not enough to argue with the band. */
const ZONE_H = 3;

export interface TapeLaneProps {
  game: GameSummary;
  track: TapeTrack;
  /** The window the whole tape is drawn across, so every lane shares one clock. */
  from: number;
  to: number;
  width: number;
  dark: boolean;
}

/** A stretch of the lane where one thing stayed true, as a time range. */
interface Span {
  from: number;
  to: number;
  side: Side | null;
}

/**
 * Everything else the samples already carry, in one pass: where the score
 * changed, where a period turned over, and the stretches a team spent inside
 * the twenty. One walk rather than four.
 */
function marksOf(samples: TapeSample[]): { scores: TapeSample[]; periods: TapeSample[]; zones: Span[] } {
  const scores: TapeSample[] = [];
  const periods: TapeSample[] = [];
  const zones: Span[] = [];
  let open: Span | null = null;

  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;

    if (prev && prev.home !== null && prev.away !== null && cur.home !== null && cur.away !== null) {
      if (cur.home !== prev.home || cur.away !== prev.away) scores.push(cur);
    }
    if (prev && prev.period !== null && cur.period !== null && cur.period !== prev.period) periods.push(cur);

    // A stretch ends when the red zone ends or the ball changes hands inside it.
    const inZone = cur.redZone;
    if (open && (!inZone || open.side !== cur.possession)) {
      open.to = cur.at;
      if (open.to > open.from) zones.push(open);
      open = null;
    }
    if (inZone && !open) open = { from: cur.at, to: cur.at, side: cur.possession };
  }
  // A stretch still open at the end of the recording runs to the last sample.
  const last = samples[samples.length - 1];
  if (open && last && last.at > open.from) zones.push({ ...open, to: last.at });
  return { scores, periods, zones };
}

export const TapeLane = memo(function TapeLane({ game, track, from, to, width, dark }: TapeLaneProps) {
  const h = LANE_HEIGHT;
  const mid = h / 2;
  const span = Math.max(1, to - from);
  const w = Math.max(1, width);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const x = useMemo(() => (t: number) => ((t - from) / span) * width, [from, span, width]);

  const home = accentFor(game.home.color, dark);
  const away = accentFor(game.away.color, dark);

  const runs = useMemo(() => (width > 0 ? ribbon(track.samples, x, h) : []), [track.samples, x, h, width]);
  const { scores, periods, zones } = useMemo(() => marksOf(track.samples), [track.samples]);

  return (
    <svg className="tape-lane__chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="presentation" focusable="false">
      <defs>
        {/* The same area, clipped twice: above the middle it is the home team's, below it the away team's. */}
        <clipPath id={`${uid}-up`}>
          <rect x={0} y={0} width={w} height={mid} />
        </clipPath>
        <clipPath id={`${uid}-down`}>
          <rect x={0} y={mid} width={w} height={h - mid} />
        </clipPath>
        {/* Depth without a shadow: the fill is strongest at the centre line, where
            the reading is, and falls away towards the edge. Rasterised once. */}
        <linearGradient id={`${uid}-home`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={withAlpha(home, dark ? 0.7 : 0.58)} />
          <stop offset="100%" stopColor={withAlpha(home, dark ? 0.34 : 0.28)} />
        </linearGradient>
        <linearGradient id={`${uid}-away`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={withAlpha(away, dark ? 0.7 : 0.58)} />
          <stop offset="100%" stopColor={withAlpha(away, dark ? 0.34 : 0.28)} />
        </linearGradient>
      </defs>

      {/* Quarters, behind everything: the rhythm a game is played in. */}
      {periods.map((p, i) => (
        <line key={`p${p.at}-${i}`} x1={x(p.at)} y1={0} x2={x(p.at)} y2={h} stroke="var(--tape-period)" strokeWidth={1} />
      ))}

      {runs.map((run, i) => (
        <g key={i}>
          <path d={run.area} fill={`url(#${uid}-home)`} clipPath={`url(#${uid}-up)`} />
          <path d={run.area} fill={`url(#${uid}-away)`} clipPath={`url(#${uid}-down)`} />
          <path d={run.line} fill="none" stroke="var(--tape-line)" strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </g>
      ))}

      {/* An even chance, so a crossing reads as a crossing. */}
      <line x1={0} y1={mid} x2={w} y2={mid} stroke="var(--tape-mid)" strokeWidth={1} />

      {/* Who was knocking, and for how long. */}
      {zones.map((z, i) => {
        const left = x(z.from);
        const right = Math.max(left + 1.5, x(z.to));
        return (
          <rect
            key={`z${z.from}-${i}`}
            x={left}
            y={h - ZONE_H}
            width={right - left}
            height={ZONE_H}
            rx={1}
            fill={z.side === 'home' ? home : z.side === 'away' ? away : 'var(--tape-mid)'}
            opacity={0.85}
          />
        );
      })}

      {scores.map((m, i) => (
        <line key={`s${m.at}-${i}`} x1={x(m.at)} y1={0} x2={x(m.at)} y2={h} stroke="var(--tape-score)" strokeWidth={1} />
      ))}
    </svg>
  );
});

/**
 * The two things that move: the live edge, and the dot under the pointer.
 *
 * They are deliberately NOT part of the drawing above. The clock ticks every
 * second and the pointer moves sixty times a second, and either one as a prop
 * on the lane would re-render its whole tree, which on a Saturday card is
 * thousands of nodes of ribbon, quarters, scores and red zone rebuilt for a dot
 * that moved four pixels. Here they are two absolutely placed elements moved
 * with a transform, which the compositor does without the main thread.
 */
export const TapeLaneMarks = memo(function TapeLaneMarks({
  track,
  live,
  from,
  to,
  width,
  scrubAt,
  now,
}: {
  track: TapeTrack;
  live: boolean;
  from: number;
  to: number;
  width: number;
  scrubAt: number | null;
  now: number;
}) {
  const h = LANE_HEIGHT;
  const span = Math.max(1, to - from);
  const x = (t: number) => ((t - from) / span) * width;
  const at = scrubAt === null ? null : stateAt(track, scrubAt);
  if (width <= 0) return null;
  return (
    <>
      {live && <i className="tape-lane__now" style={{ transform: `translateX(${x(now).toFixed(1)}px)` }} aria-hidden="true" />}
      {at && (
        <i
          className="tape-lane__dot"
          style={{ transform: `translate(${x(at.at).toFixed(1)}px, ${(at.wp === null ? h / 2 : h - at.wp * h).toFixed(1)}px)` }}
          aria-hidden="true"
        />
      )}
    </>
  );
});
