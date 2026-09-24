/**
 * The game's shape so far, on the game's own card.
 *
 * The meter above it says who is ahead right now. It cannot say whether that
 * was always true. A card reading "Ravens 17, Colts 14, Q3" is the same card
 * whether it has been a three point game all afternoon or a rout that has just
 * come back, and those are not the same game to decide to watch. This is the
 * tape's lane at card size: the reported win probability drawn from the centre
 * out, so thickness is margin and a crossing is the moment it turned.
 *
 * It is the same drawing as the tape, from ./ribbon, so the slate and the tape
 * can never disagree. It carries no marks, no live edge and no scrub dot: at
 * this size they would be noise, and they are the parts that move.
 *
 * Nothing is drawn when the provider reported nothing. No empty box, no flat
 * line at an even chance, no placeholder: a game with no reported win
 * probability simply has no pulse, and the card is exactly as it was before.
 *
 * Colour comes from the two CSS variables the card already sets for its own
 * team light, so there is no colour work here, no second subscription to the
 * theme on every card, and the pulse follows a theme change with the card
 * rather than a render behind it.
 */
import { memo, useId, useMemo } from 'react';
import type { GameId } from '../../shared/model';
import { tapeStats, type TapeTrack } from '../../shared/tape';
import { useTape } from '../state/tape';
import { ribbon } from './ribbon';

/** Drawn in its own units and stretched by CSS, so resizing a card never redraws one. */
const W = 100;
const H = 24;

export const TapePulse = memo(function TapePulse({ gameId }: { gameId: GameId }) {
  // record() returns the same track object when a reading changed nothing a
  // viewer could see, so a quiet game does not re-render its pulse every poll.
  const track = useTape((s) => s.tracks[gameId] as TapeTrack | undefined);
  const samples = track?.samples;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const shape = useMemo(() => {
    if (!samples || samples.length < 2) return null;
    const from = samples[0].at;
    const to = samples[samples.length - 1].at;
    if (to <= from) return null;
    // Each card is drawn across its OWN recording rather than the day's, because
    // what a card is being asked is the shape of this game, not when it sat in
    // the afternoon. That is the tape's question, and the tape draws it.
    const runs = ribbon(samples, (t) => ((t - from) / (to - from)) * W, H);
    if (!runs.length) return null;
    const { movement, leadChanges, samples: count } = tapeStats({ gameId, samples });
    return { runs, movement, leadChanges, count };
  }, [samples, gameId]);

  if (!shape) return null;
  const { movement, leadChanges, count } = shape;
  const label = [
    `Reported win probability so far: ${movement === null ? 'no movement reported' : `${Math.round(movement * 100)} points of movement`} across ${count} readings`,
    leadChanges ? `${leadChanges} lead ${leadChanges === 1 ? 'change' : 'changes'}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <svg className="tape-pulse" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" focusable="false">
      <title>{label}</title>
      <defs>
        {/* The same area clipped twice: above the middle it is the home team's, below it the away team's. */}
        <clipPath id={`${uid}-up`}>
          <rect x={0} y={0} width={W} height={H / 2} />
        </clipPath>
        <clipPath id={`${uid}-down`}>
          <rect x={0} y={H / 2} width={W} height={H / 2} />
        </clipPath>
      </defs>
      {shape.runs.map((run, i) => (
        <g key={i}>
          <path d={run.area} className="tape-pulse__home" clipPath={`url(#${uid}-up)`} />
          <path d={run.area} className="tape-pulse__away" clipPath={`url(#${uid}-down)`} />
          <path d={run.line} className="tape-pulse__line" vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      {/* An even chance, so a crossing reads as a crossing. */}
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} className="tape-pulse__mid" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});
