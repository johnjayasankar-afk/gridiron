/**
 * Historical inspection. A game's reported plays become frames that the field,
 * the play-by-play and the drive replay can show. Frames use reported spots
 * only; a play without one shows "Ball spot unavailable" rather than a guess.
 */
import { teamFor } from './format.js';
import type { Drive, GameDetail, PlayEvent, PlayKind, Score, Situation } from './model.js';
import { ADMIN_KINDS, TOUCHDOWN_KINDS } from './model.js';
import { situationFromPlays } from './situation.js';
import { periodShort } from './util.js';

export type PlayFilter = 'all' | 'scoring' | 'turnovers' | 'big' | 'fourth' | 'penalties' | 'reviews';

export const PLAY_FILTERS: ReadonlyArray<{ id: PlayFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'turnovers', label: 'Turnovers' },
  { id: 'big', label: 'Big plays' },
  { id: 'fourth', label: '4th down' },
  { id: 'penalties', label: 'Penalties' },
  { id: 'reviews', label: 'Reviews' },
];

const GAIN_KINDS: ReadonlySet<PlayKind> = new Set(['rush', 'pass_complete', 'touchdown_rush', 'touchdown_pass', 'punt_return', 'kickoff_return']);
const CONVERSION_KINDS: ReadonlySet<PlayKind> = new Set(['extra_point', 'two_point']);

export const isInspectable = (p: PlayEvent) => !ADMIN_KINDS.has(p.kind);

/** Filter tags come from explicit play types and flags only. */
export function playTags(p: PlayEvent, bigPlayYards: number): Set<PlayFilter> {
  const tags = new Set<PlayFilter>();
  if (p.scoring === true || (TOUCHDOWN_KINDS.has(p.kind) && p.scoring !== false) || p.kind === 'field_goal_good' || p.kind === 'safety') tags.add('scoring');
  if (p.turnover === true || p.kind === 'interception' || p.kind === 'fumble_lost') tags.add('turnovers');
  if (p.yards !== null && p.yards >= bigPlayYards && GAIN_KINDS.has(p.kind) && p.penalty !== true) tags.add('big');
  if (p.start?.down === 4 && isInspectable(p)) tags.add('fourth');
  if (p.penalty === true || p.kind === 'penalty') tags.add('penalties');
  if (p.review !== null) tags.add('reviews');
  return tags;
}

export function filterPlays(plays: PlayEvent[], filter: PlayFilter, query: string, bigPlayYards = 20): PlayEvent[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return plays.filter((p) => {
    if (filter !== 'all' && !playTags(p, bigPlayYards).has(filter)) return false;
    if (!tokens.length) return true;
    const hay = `${p.description} ${p.providerType.text ?? ''}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

export function inspectablePlays(detail: GameDetail, driveId: string | null = null): PlayEvent[] {
  return detail.plays.filter((p) => isInspectable(p) && (driveId === null || p.driveId === driveId));
}

export interface PlayFrame {
  play: PlayEvent;
  /** Position among inspectable plays, 0-based. */
  index: number;
  total: number;
  drive: Drive | null;
  /** The state after this play, or null when the play has no reported end state. */
  situation: Situation | null;
  fromYard: number | null;
  toYard: number | null;
  score: Score;
}

export function frameAt(detail: GameDetail, order: number): PlayFrame | null {
  const plays = inspectablePlays(detail);
  const index = plays.findIndex((p) => p.order === order);
  if (index < 0) return null;
  const play = plays[index];
  const after = situationFromPlays(detail.plays, order);
  return {
    play,
    index,
    total: plays.length,
    drive: (play.driveId && detail.drives.find((d) => d.id === play.driveId)) || null,
    situation: after && after.lastPlay?.id === play.id ? after : null,
    fromYard: play.start?.spot.schematicYard ?? null,
    toYard: play.end?.spot.schematicYard ?? null,
    score: play.scoreAfter,
  };
}

/**
 * The play order `delta` steps from `order` among inspectable plays, optionally
 * within one drive. From live (null), stepping back lands on the latest play.
 * The ends are sticky: stepping past them stays on the first or last play.
 */
export function stepOrder(detail: GameDetail, order: number | null, delta: number, driveId: string | null = null): number | null {
  const plays = inspectablePlays(detail, driveId);
  if (!plays.length) return null;
  if (order === null) return delta < 0 ? plays[plays.length - 1].order : null;
  let index = plays.findIndex((p) => p.order === order);
  if (index < 0) {
    index = -1;
    for (let i = 0; i < plays.length; i++) if (plays[i].order < order) index = i;
    if (index < 0) return plays[0].order;
    if (delta > 0) delta -= 1; // the nearest earlier play already counts as a step back
  }
  return plays[Math.min(plays.length - 1, Math.max(0, index + delta))].order;
}

/** Touchdowns, field goals and safeties to jump between. Conversions are left out. */
export function scoringOrders(detail: GameDetail): number[] {
  return inspectablePlays(detail)
    .filter((p) => !CONVERSION_KINDS.has(p.kind) && playTags(p, Number.POSITIVE_INFINITY).has('scoring'))
    .map((p) => p.order);
}

export function currentDriveId(detail: GameDetail): string | null {
  return detail.currentDriveId ?? detail.drives[detail.drives.length - 1]?.id ?? null;
}

export function firstOrderOfDrive(detail: GameDetail, driveId: string | null): number | null {
  if (!driveId) return null;
  return inspectablePlays(detail, driveId)[0]?.order ?? null;
}

const RESULT_LABELS: Record<string, string> = {
  TD: 'Touchdown',
  TOUCHDOWN: 'Touchdown',
  FG: 'Field goal',
  'FIELD GOAL': 'Field goal',
  'MISSED FG': 'Missed field goal',
  'BLOCKED FG': 'Blocked field goal',
  PUNT: 'Punt',
  'BLOCKED PUNT': 'Blocked punt',
  INT: 'Interception',
  'INT TD': 'Interception return touchdown',
  FUMBLE: 'Fumble',
  'FUMBLE TD': 'Fumble return touchdown',
  DOWNS: 'Turnover on downs',
  SAFETY: 'Safety',
  'END OF HALF': 'End of half',
  'END OF GAME': 'End of game',
  'END OF 4TH QUARTER': 'End of regulation',
};

export function driveResultLabel(result: string | null): string | null {
  if (!result) return null;
  const key = result.trim().toUpperCase();
  if (RESULT_LABELS[key]) return RESULT_LABELS[key];
  const lower = result.trim().toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export interface CatchUpItem {
  order: number;
  when: string;
  text: string;
  tone: 'score' | 'turnover' | 'big';
}

export interface CatchUpSummary {
  newPlays: number;
  items: CatchUpItem[];
  headline: string;
  scoreBefore: Score | null;
}

/**
 * What happened after `sinceOrder` (or in the whole game when null): scores,
 * turnovers and big plays, straight from reported play types.
 */
export function catchUp(detail: GameDetail, sinceOrder: number | null, bigPlayYards = 20): CatchUpSummary {
  const game = detail.summary;
  const all = inspectablePlays(detail);
  const plays = all.filter((p) => sinceOrder === null || p.order > sinceOrder);
  const before = sinceOrder === null ? null : [...all].reverse().find((p) => p.order <= sinceOrder) ?? null;
  const items: CatchUpItem[] = [];
  let scores = 0;
  let turnovers = 0;
  let big = 0;
  for (const p of plays) {
    const tags = playTags(p, bigPlayYards);
    const when = [periodShort(p.period, game.status.regulationPeriods), p.clock].filter(Boolean).join(' ');
    if (tags.has('scoring') && !CONVERSION_KINDS.has(p.kind)) {
      scores++;
      const team = teamFor(game, p.scoringTeam ?? p.offense)?.abbreviation;
      const what = TOUCHDOWN_KINDS.has(p.kind) ? 'touchdown' : p.kind === 'field_goal_good' ? 'field goal' : p.kind === 'safety' ? 'safety' : 'score';
      items.push({ order: p.order, when, text: `${team ? `${team} ` : ''}${what}: ${p.description}`, tone: 'score' });
    } else if (tags.has('turnovers')) {
      turnovers++;
      const team = teamFor(game, p.offense)?.abbreviation;
      items.push({ order: p.order, when, text: `${team ? `${team} ` : ''}turnover: ${p.description}`, tone: 'turnover' });
    } else if (tags.has('big')) {
      big++;
      items.push({ order: p.order, when, text: p.description, tone: 'big' });
    }
  }
  const parts: string[] = [];
  if (scores) parts.push(`${scores} ${scores === 1 ? 'score' : 'scores'}`);
  if (turnovers) parts.push(`${turnovers} ${turnovers === 1 ? 'turnover' : 'turnovers'}`);
  if (big) parts.push(`${big} big ${big === 1 ? 'play' : 'plays'}`);
  const scope = sinceOrder === null ? 'this game' : `${plays.length} new ${plays.length === 1 ? 'play' : 'plays'}`;
  const headline = plays.length === 0 ? 'No new plays reported' : parts.length ? `${parts.join(', ')} in ${scope}` : `Nothing major in ${scope}`;
  return { newPlays: plays.length, items, headline, scoreBefore: before?.scoreAfter ?? null };
}
