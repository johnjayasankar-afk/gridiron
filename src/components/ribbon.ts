/**
 * How a win probability ribbon is drawn, in one place.
 *
 * It is drawn from the middle out, not from the bottom up. Filling from the
 * bottom made every decided game a solid block, and a nine in ten chance and a
 * certainty looked the same; from the middle, the thickness IS the margin. A
 * close game is a thin line down the centre, a decided one is a thick band, and
 * a game that turned crosses the middle at the moment it turned.
 *
 * Above the centre is the home team's, below it the away team's, which the
 * caller does by drawing the same area twice under two clips.
 *
 * Only reported values are drawn. Where the provider reported no win
 * probability the ribbon stops rather than joining across the gap, because a
 * line between two known points is a claim about the time between them. The
 * tape lane and the pulse on a card are the same drawing at two sizes, so they
 * can never disagree about what the day did.
 */
import type { TapeSample } from '../../shared/tape';

export interface Run {
  /** The step line, closed back along the centre: the area between the two. */
  area: string;
  line: string;
}

/**
 * One path per unbroken run of reported values. A run of a single value has no
 * width to draw and is left out rather than shown as a sliver.
 */
export function ribbon(samples: TapeSample[], x: (t: number) => number, h: number): Run[] {
  const mid = h / 2;
  const y = (wp: number) => h - wp * h;
  const runs: Run[] = [];
  let current: TapeSample[] = [];

  const flush = () => {
    if (current.length >= 2) {
      // The provider reported a state, not a trend, so the value holds until the
      // next one arrives and the line steps rather than sloping between them.
      const steps: string[] = [];
      for (let i = 0; i < current.length; i++) {
        const px = x(current[i].at).toFixed(1);
        const py = y(current[i].wp!).toFixed(1);
        if (i > 0) steps.push(`L${px},${y(current[i - 1].wp!).toFixed(1)}`);
        steps.push(`${i === 0 ? 'M' : 'L'}${px},${py}`);
      }
      const line = steps.join('');
      const first = x(current[0].at).toFixed(1);
      const last = x(current[current.length - 1].at).toFixed(1);
      runs.push({ line, area: `${line}L${last},${mid}L${first},${mid}Z` });
    }
    current = [];
  };

  for (const s of samples) {
    if (s.wp === null) flush();
    else current.push(s);
  }
  flush();
  return runs;
}
