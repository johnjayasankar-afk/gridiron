/**
 * How the field shows a newly reported play.
 *
 * Movement always runs from the reported start spot to the reported end spot.
 * Sweeps, arcs and kicks are schematic shapes chosen from the reported play
 * type; they are not tracked ball flight, routes or landing points. Corrections
 * and catch-up bursts settle quietly and never celebrate a second time.
 */
import type { BallSpot, Conversion, PlayBrief, PlayEvent, PlayKind, Side } from './model.js';
import { ADMIN_KINDS, TOUCHDOWN_KINDS } from './model.js';
import { fingerprint } from './util.js';

/**
 * The shape a play is drawn with, taken from the kind of play the provider
 * reported and from nothing else. 'pick' is a ball thrown one way and taken back
 * the other; 'blocked' is a kick that never got away.
 */
export type AnimationPath = 'sweep' | 'arc' | 'kick' | 'pick' | 'blocked' | 'incomplete' | 'sack' | 'settle';
export type AnimationEffect = 'touchdown' | 'field_goal' | 'safety' | 'turnover' | 'penalty' | 'review' | 'first_down' | null;

/** Motion bands in milliseconds: micro (settles, fades), standard (short movement), major (flights and scores). */
export const TIMINGS = {
  micro: [150, 250],
  standard: [300, 500],
  major: [500, 1000],
} as const satisfies Record<string, readonly [number, number]>;

export interface PlayInput {
  id: string;
  revision: string;
  kind: PlayKind;
  fromYard: number | null;
  toYard: number | null;
  /** Lateral positions before and after the play (see shared/field.ts), when the data has them. */
  fromLateral?: number | null;
  toLateral?: number | null;
  offenseBefore: Side | null;
  offenseAfter: Side | null;
  scoring: boolean | null;
  turnover: boolean | null;
  penalty: boolean | null;
  review: boolean;
  conversion: Conversion | null;
  /** The provider's yardage for the play, when reported. */
  yards: number | null;
  startDown: number | null;
  startDistance: number | null;
  endDown: number | null;
  /** 'brief' when only a scoreboard summary of the play is known, so the shape is kept to a plain sweep. */
  source: 'play' | 'brief';
}

/**
 * Kicks that are struck off the ground or a tee. A placed ball is hit below its
 * middle and turns end over end; a punt is dropped onto the foot and spirals.
 * The ball is drawn turning the way the reported kind of kick actually turns.
 */
export const PLACE_KICKS = new Set<PlayKind>(['kickoff', 'kickoff_return', 'field_goal_good', 'field_goal_missed', 'field_goal_blocked', 'extra_point']);

export interface PlayAnimation {
  key: string;
  playId: string;
  kind: PlayKind;
  path: AnimationPath;
  effect: AnimationEffect;
  fromYard: number | null;
  toYard: number | null;
  /** Lateral positions before and after the play, when the data has them. */
  fromLateral?: number | null;
  toLateral?: number | null;
  offenseBefore: Side | null;
  offenseAfter: Side | null;
  /** Ball movement time. */
  durationMs: number;
  /** Emphasis after the ball settles; 0 when there is none. */
  effectMs: number;
  label: string | null;
  corrected: boolean;
  /** The reported downs show the offense earned a new set of downs. */
  firstDown: boolean;
}

export interface SeenPlay {
  id: string;
  revision: string;
}

export interface PlanOptions {
  reducedMotion: boolean;
  /** More than one new play arrived at once (catch-up after a gap, or a delayed batch). */
  burst: boolean;
}

export function playInputFromEvent(p: PlayEvent): PlayInput {
  return {
    id: p.id,
    revision: p.revision,
    kind: p.kind,
    fromYard: p.start?.spot.schematicYard ?? null,
    toYard: p.end?.spot.schematicYard ?? null,
    fromLateral: p.start?.spot.lateral ?? undefined,
    toLateral: p.end?.spot.lateral ?? undefined,
    offenseBefore: p.start?.spot.offense ?? p.offense,
    offenseAfter: p.end?.spot.offense ?? p.offense,
    scoring: p.scoring,
    turnover: p.turnover,
    penalty: p.penalty,
    review: p.review !== null,
    conversion: p.conversion,
    yards: p.yards,
    startDown: p.start?.down ?? null,
    startDistance: p.start?.distance ?? null,
    endDown: p.end?.down ?? null,
    source: 'play',
  };
}

/** A scoreboard-only update: the brief names the play and the two reported spots bound the movement. */
export function playInputFromBrief(brief: PlayBrief, before: BallSpot | null, after: BallSpot | null): PlayInput {
  const revision = fingerprint(`${brief.kind}|${brief.description}|${brief.yards ?? ''}`);
  return {
    id: brief.id ?? `brief:${revision}`,
    revision,
    kind: brief.kind,
    fromYard: before?.schematicYard ?? null,
    toYard: after?.schematicYard ?? null,
    offenseBefore: before?.offense ?? brief.team,
    offenseAfter: after?.offense ?? brief.team,
    scoring: null,
    turnover: null,
    penalty: brief.kind === 'penalty' ? true : null,
    review: false,
    conversion: null,
    yards: brief.yards,
    startDown: null,
    startDistance: null,
    endDown: null,
    source: 'brief',
  };
}

const within = (value: number, band: readonly [number, number]) => Math.round(Math.min(band[1], Math.max(band[0], value)));

export function labelForPlay(input: Pick<PlayInput, 'kind' | 'scoring' | 'turnover' | 'penalty' | 'review' | 'conversion'>): string | null {
  const result = input.conversion?.result;
  switch (input.kind) {
    case 'touchdown_rush':
    case 'touchdown_pass':
    case 'touchdown_return':
      return input.scoring === false ? null : 'Touchdown';
    case 'field_goal_good':
      return 'Field goal is good';
    case 'field_goal_missed':
      return 'Field goal missed';
    case 'field_goal_blocked':
      return 'Field goal blocked';
    case 'safety':
      return 'Safety';
    case 'interception':
      return 'Interception';
    case 'fumble_lost':
      return 'Fumble lost';
    case 'fumble':
    case 'fumble_recovered_own':
      return 'Fumble';
    case 'pass_incomplete':
      return 'Incomplete';
    case 'sack':
      return 'Sack';
    case 'punt':
    case 'punt_return':
      return 'Punt';
    case 'punt_blocked':
      return 'Punt blocked';
    case 'kickoff':
    case 'kickoff_return':
      return 'Kickoff';
    case 'penalty':
      return 'Penalty';
    case 'extra_point':
      return result === 'good' ? 'Extra point good' : result === 'failed' ? 'Extra point no good' : result === 'blocked' ? 'Extra point blocked' : 'Extra point';
    case 'two_point':
      return result === 'good' ? 'Two-point try good' : result === 'failed' ? 'Two-point try failed' : 'Two-point try';
    default:
      return input.turnover ? 'Turnover' : input.penalty ? 'Penalty' : input.review ? 'Under review' : null;
  }
}

const NO_FIRST_DOWN: ReadonlySet<PlayKind> = new Set<PlayKind>([
  'punt', 'punt_return', 'punt_blocked', 'kickoff', 'kickoff_return', 'field_goal_good', 'field_goal_missed', 'field_goal_blocked',
  'extra_point', 'two_point', 'safety', 'interception', 'fumble_lost',
]);

/**
 * A new set of downs, read only from reported downs: the offense kept the ball
 * and the next snap is first down, after either a later down or a gain of at
 * least the distance on first down. A first-and-10 penalty that leaves first
 * and 5 is not a new set of downs.
 */
export function gainedFirstDown(input: Pick<PlayInput, 'kind' | 'scoring' | 'turnover' | 'offenseBefore' | 'offenseAfter' | 'startDown' | 'startDistance' | 'endDown' | 'yards'>): boolean {
  if (NO_FIRST_DOWN.has(input.kind) || TOUCHDOWN_KINDS.has(input.kind) || ADMIN_KINDS.has(input.kind) || input.scoring === true || input.turnover === true) return false;
  if (!input.offenseBefore || input.offenseBefore !== input.offenseAfter) return false;
  if (input.endDown !== 1 || input.startDown === null) return false;
  if (input.startDown > 1) return true;
  return input.startDistance !== null && input.yards !== null && input.yards >= input.startDistance;
}

const READOUT_NOUN: Partial<Record<PlayKind, string>> = {
  rush: 'Rush',
  pass_complete: 'Pass',
  sack: 'Sack',
  penalty: 'Penalty',
  fumble_recovered_own: 'Fumble',
  punt_return: 'Punt return',
  kickoff_return: 'Kickoff return',
};

const signedYards = (yards: number) => (yards > 0 ? `+${yards}` : yards < 0 ? `−${Math.abs(yards)}` : '0');

/** The short text shown on the field for a play: its type, the reported yardage, and a new set of downs. */
export function playReadout(input: PlayInput): string | null {
  const noun = READOUT_NOUN[input.kind];
  let text = labelForPlay(input);
  if (noun && input.yards !== null && Number.isFinite(input.yards) && !(input.kind === 'penalty' && input.yards === 0)) text = `${noun} ${signedYards(Math.round(input.yards))}`;
  else if (!text && noun) text = noun;
  if (gainedFirstDown(input)) text = text ? `${text} · First down` : 'First down';
  return text;
}

export function planPlayAnimation(previous: SeenPlay | null, input: PlayInput | null, options: PlanOptions): PlayAnimation | null {
  if (!input || ADMIN_KINDS.has(input.kind)) return null;
  if (previous && previous.id === input.id && previous.revision === input.revision) return null;
  const corrected = previous !== null && previous.id === input.id;
  const firstDown = gainedFirstDown(input);
  const base = {
    key: `${input.id}@${input.revision}`,
    playId: input.id,
    kind: input.kind,
    fromYard: input.fromYard,
    toYard: input.toYard,
    fromLateral: input.fromLateral ?? undefined,
    toLateral: input.toLateral ?? undefined,
    offenseBefore: input.offenseBefore,
    offenseAfter: input.offenseAfter,
    corrected,
    firstDown,
  };
  if (corrected) return { ...base, path: 'settle', effect: null, durationMs: TIMINGS.micro[1], effectMs: 0, label: 'Play corrected' };

  const label = playReadout(input);
  if (options.reducedMotion) return { ...base, path: 'settle', effect: null, durationMs: TIMINGS.micro[0], effectMs: 0, label };
  if (options.burst || input.fromYard === null || input.toYard === null) {
    return { ...base, path: 'settle', effect: null, durationMs: TIMINGS.micro[1], effectMs: 0, label };
  }

  const distance = Math.abs(input.toYard - input.fromYard);
  // An extra point is a place kick, and the provider says so on the conversion
  // rather than in the kind. It used to slide along the ground like a run.
  const kickedConversion = input.kind === 'extra_point' && input.conversion?.kind === 'kick';
  const blocked = input.kind === 'field_goal_blocked' || input.kind === 'punt_blocked' || (kickedConversion && input.conversion?.result === 'blocked');
  let path: AnimationPath;
  let durationMs: number;
  switch (true) {
    case blocked:
      // Up off the foot and knocked straight back down: short, low and quick.
      path = 'blocked';
      durationMs = within(420, TIMINGS.standard);
      break;
    case input.kind === 'interception':
      // Thrown one way and taken back the other. A single smooth arc from the
      // throw to where the RETURN ended drew the ball flying to a spot behind
      // the line, which is not what happened.
      path = 'pick';
      durationMs = within(700 + distance * 5, TIMINGS.major);
      break;
    case input.kind === 'pass_complete':
    case input.kind === 'touchdown_pass':
      path = 'arc';
      durationMs = within(520 + distance * 6, TIMINGS.major);
      break;
    case input.kind === 'pass_incomplete':
      path = 'incomplete';
      durationMs = within(440, TIMINGS.standard);
      break;
    case input.kind === 'sack':
      path = 'sack';
      durationMs = within(380, TIMINGS.standard);
      break;
    case input.kind === 'punt':
    case input.kind === 'punt_return':
    case input.kind === 'kickoff':
    case input.kind === 'kickoff_return':
    case input.kind === 'field_goal_good':
    case input.kind === 'field_goal_missed':
    case kickedConversion:
      path = 'kick';
      durationMs = within(700 + distance * 4, TIMINGS.major);
      break;
    default:
      path = distance < 0.5 ? 'settle' : 'sweep';
      durationMs = path === 'settle' ? TIMINGS.micro[1] : within(300 + distance * 8, TIMINGS.standard);
  }
  if (input.source === 'brief' && path !== 'settle') {
    path = 'sweep';
    durationMs = within(300 + distance * 8, TIMINGS.standard);
  }

  const turnover = input.turnover === true || input.kind === 'interception' || input.kind === 'fumble_lost';
  let effect: AnimationEffect = null;
  let effectMs = 0;
  if (TOUCHDOWN_KINDS.has(input.kind) && input.scoring !== false) [effect, effectMs] = ['touchdown', 900];
  // A kicked conversion the provider called good goes through the uprights too.
  else if (input.kind === 'field_goal_good' || (kickedConversion && input.conversion?.result === 'good')) [effect, effectMs] = ['field_goal', 700];
  else if (input.kind === 'safety') [effect, effectMs] = ['safety', 700];
  else if (turnover) [effect, effectMs] = ['turnover', 450];
  else if (input.penalty === true || input.kind === 'penalty') [effect, effectMs] = ['penalty', 350];
  else if (input.review) [effect, effectMs] = ['review', 500];
  else if (firstDown) [effect, effectMs] = ['first_down', 400];
  return { ...base, path, effect, durationMs, effectMs, label };
}
