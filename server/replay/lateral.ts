/**
 * The lateral position test scenario. No feed Gridiron can read reports where
 * the ball sits across the field, so this scenario estimates it from each
 * play's description: a pass "short right" or a run "left end" moves the ball
 * toward that side of the offense, and the next snap is spotted between the
 * hash marks. The estimates exist only inside this labelled synthetic scenario.
 * They show the renderers placing a lateral position, not where a real ball was.
 */
import { HASH_LATERAL } from '../../shared/field.js';
import type { GameDetail, GameSummary, LeagueId, PlayEvent } from '../../shared/model.js';
import type { GameTimeline } from './timeline.js';

type Raw = Record<string, any>;

export interface LateralPair {
  /** Where the snap was spotted. */
  start: number;
  /** Where the play ended, when its description names a direction. */
  end: number | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The side a described play went, from the offense's view, and how far toward that sideline as a share of the field width. */
function reachOf(text: string): { side: 'left' | 'right' | 'middle'; reach: number } | null {
  const pass = /\b(short|deep) (left|right|middle)\b/i.exec(text);
  if (pass) {
    const side = pass[2].toLowerCase() as 'left' | 'right' | 'middle';
    return { side, reach: side === 'middle' ? 0 : pass[1].toLowerCase() === 'deep' ? 0.3 : 0.2 };
  }
  const run = /\b(left|right) (end|tackle|guard)\b/i.exec(text);
  if (run) {
    const gap = run[2].toLowerCase();
    return { side: run[1].toLowerCase() as 'left' | 'right', reach: gap === 'end' ? 0.35 : gap === 'tackle' ? 0.15 : 0.08 };
  }
  return /\bup the middle\b/i.test(text) ? { side: 'middle', reach: 0 } : null;
}

/**
 * Estimates for every play of a timeline, by provider play id. An offense
 * attacking the home end zone (the away offense) has its left hand on the far
 * sideline, lateral below 0.5; the home offense is mirrored.
 */
export function syntheticLaterals(tl: GameTimeline): Map<string, LateralPair> {
  const [lowHash, highHash] = HASH_LATERAL[tl.league];
  const competitors: Raw[] = tl.summary?.header?.competitions?.[0]?.competitors ?? [];
  const homeId = String(competitors.find((c) => c.homeAway === 'home')?.team?.id ?? '');
  const out = new Map<string, LateralPair>();
  let lastEnd = 0.5;
  for (const p of tl.plays) {
    const raw = p.raw;
    const restart = /kickoff|extra point|two-point|conversion/i.test(String(raw.type?.text ?? ''));
    // A snap is spotted where the last play ended, or at the nearest hash when that was outside the hashes.
    const start = restart ? 0.5 : clamp(lastEnd, lowHash, highHash);
    const reach = restart ? null : reachOf(String(raw.text ?? ''));
    let end: number | null = null;
    if (reach) {
      const offenseIsHome = homeId !== '' && String(raw.start?.team?.id ?? '') === homeId;
      const towardFar = (reach.side === 'left') !== offenseIsHome;
      end = reach.side === 'middle' ? 0.5 : clamp(0.5 + (towardFar ? -reach.reach : reach.reach), 0.04, 0.96);
    }
    out.set(String(raw.id), { start, end });
    lastEnd = restart ? 0.5 : (end ?? start);
  }
  return out;
}

const cache = new WeakMap<GameTimeline, Map<string, LateralPair>>();

/** The estimates for a timeline, or null for a timeline without the synthetic lateral edit. */
export function lateralsFor(tl: GameTimeline): Map<string, LateralPair> | null {
  if (!tl.edits.some((e) => e.kind === 'synthetic-lateral')) return null;
  let laterals = cache.get(tl);
  if (!laterals) {
    laterals = syntheticLaterals(tl);
    cache.set(tl, laterals);
  }
  return laterals;
}

/** The next snap's lateral position after a play: between the hashes. */
export function snapLateral(league: LeagueId, after: LateralPair | undefined): number | null {
  if (!after) return null;
  const [low, high] = HASH_LATERAL[league];
  return clamp(after.end ?? after.start, low, high);
}

function withLateral(p: PlayEvent, pair: LateralPair | undefined): PlayEvent {
  if (!pair) return p;
  return {
    ...p,
    start: p.start && p.start.spot.schematicYard !== null ? { ...p.start, spot: { ...p.start.spot, lateral: pair.start } } : p.start,
    end: p.end && p.end.spot.schematicYard !== null && pair.end !== null ? { ...p.end, spot: { ...p.end.spot, lateral: pair.end } } : p.end,
  };
}

/** A summary whose live situation is placed at the next snap after the latest play with an estimate. */
export function summaryWithLateral(summary: GameSummary, laterals: Map<string, LateralPair>, latestPlayId: string | null): GameSummary {
  const situation = summary.situation;
  if (!situation || situation.spot.schematicYard === null || latestPlayId === null) return summary;
  const lateral = snapLateral(summary.league, laterals.get(latestPlayId));
  return lateral === null ? summary : { ...summary, situation: { ...situation, spot: { ...situation.spot, lateral } } };
}

/** Detail with estimates on every play and on its summary's live situation. */
export function detailWithLateral(detail: GameDetail, laterals: Map<string, LateralPair>): GameDetail {
  const plays = detail.plays.map((p) => withLateral(p, laterals.get(p.providerId)));
  const latest = [...detail.plays].reverse().find((p) => laterals.has(p.providerId));
  return { ...detail, plays, summary: summaryWithLateral(detail.summary, laterals, latest?.providerId ?? null) };
}
