/**
 * Field markings, verified against the 2026 NFL Official Playing Rules (Rule 1)
 * and the 2026 NCAA Football Rules (Rule 1-2). All distances are in yards.
 * Both the 3D field and the 2D fallback draw from these values.
 *
 * NFL 1-2-2: hash marks 70 ft 9 in from each sideline (rows 18 ft 6 in apart), 24 in long.
 * NCAA 1-2-1-j: hash marks 60 ft from each sideline (rows 40 ft apart), 24 in long.
 * NFL 1-2-4: numbers 6 ft tall, bottoms 12 yd from the sideline. NCAA 1-2-1-h: tops 9 yd from the sideline.
 * NFL goal line 8 in; NCAA 4 or 8 in (drawn at 4 in). Other lines 4 in.
 * NFL 1-2-4 item 2: a 1-yard try mark 2 yd from each goal line. NCAA specifies none.
 * Pylons: NFL 8 (goal-line and end-line corners); NCAA 12 (adds 4 where hash lines meet the end lines, 3 ft beyond).
 * Goal posts: crossbar top 10 ft, 18 ft 6 in wide. NFL uprights rise 35 ft above the crossbar;
 * NCAA uprights reach at least 30 ft above the ground.
 */
import { FIELD } from './field.js';
import type { LeagueId } from './model.js';

const FT = 1 / 3;
const IN = 1 / 36;

export interface FieldMarkings {
  league: LeagueId;
  label: string;
  length: number;
  width: number;
  halfWidth: number;
  lineWidth: number;
  goalLineWidth: number;
  /** Distance from the field's centre line to the inner edge of each hash row. */
  hashInner: number;
  hashLength: number;
  sidelineMarkInset: number;
  sidelineMarkLength: number;
  /** Distance of each number's baseline edge (nearest the sideline) from the sideline. */
  numberNear: number;
  numberHeight: number;
  numberDigitWidth: number;
  /** A try mark: its distance from the goal line and its length across the field, or null. */
  tryMark: { fromGoal: number; length: number } | null;
  /** White border outside the sidelines: its width, and whether it runs the full length or only between the 20s. */
  border: { width: number; extent: 'full' | 'between-20s' };
  goalpost: { crossbarHeight: number; width: number; uprightTop: number; setback: number; color: string };
  pylons: Array<{ x: number; z: number }>;
  /**
   * The ball itself. NCAA rules require two one inch white stripes on the panels
   * either side of the laces; the NFL ball carries none, and has not since the
   * white ball was dropped. It is the one marking that is not on the field.
   */
  ball: { stripes: boolean };
}

function pylons(extraAtHashes: boolean, hashInner: number): Array<{ x: number; z: number }> {
  const half = FIELD.width / 2;
  const out: Array<{ x: number; z: number }> = [];
  for (const x of [-50, 50, -60, 60]) for (const z of [-half, half]) out.push({ x, z });
  if (extraAtHashes) for (const x of [-60 - 3 * FT, 60 + 3 * FT]) for (const z of [-hashInner, hashInner]) out.push({ x, z });
  return out;
}

const NFL_HASH_INNER = (160 / 2 - 70.75) * FT; // 9 ft 3 in from centre
const NCAA_HASH_INNER = (160 / 2 - 60) * FT; // 20 ft from centre

export const NFL_MARKINGS: FieldMarkings = {
  league: 'nfl',
  label: 'NFL field markings',
  length: FIELD.total,
  width: FIELD.width,
  halfWidth: FIELD.width / 2,
  lineWidth: 4 * IN,
  goalLineWidth: 8 * IN,
  hashInner: NFL_HASH_INNER,
  hashLength: 24 * IN,
  sidelineMarkInset: 8 * IN,
  sidelineMarkLength: 24 * IN,
  numberNear: 12,
  numberHeight: 6 * FT,
  numberDigitWidth: 4 * FT,
  tryMark: { fromGoal: 2, length: 1 },
  border: { width: 6 * FT, extent: 'full' },
  goalpost: { crossbarHeight: 10 * FT, width: 18.5 * FT, uprightTop: 45 * FT, setback: 2, color: '#d8b24a' },
  pylons: pylons(false, NFL_HASH_INNER),
  ball: { stripes: false },
};

export const NCAA_MARKINGS: FieldMarkings = {
  league: 'cfb',
  label: 'NCAA field markings',
  length: FIELD.total,
  width: FIELD.width,
  halfWidth: FIELD.width / 2,
  lineWidth: 4 * IN,
  goalLineWidth: 4 * IN,
  hashInner: NCAA_HASH_INNER,
  hashLength: 24 * IN,
  sidelineMarkInset: 4 * IN,
  sidelineMarkLength: 24 * IN,
  numberNear: 7, // tops 9 yd from the sideline, 6 ft tall
  numberHeight: 6 * FT,
  numberDigitWidth: 4 * FT,
  tryMark: null,
  border: { width: 6 * FT, extent: 'between-20s' },
  goalpost: { crossbarHeight: 10 * FT, width: 18.5 * FT, uprightTop: 30 * FT, setback: 2, color: '#eee6c6' },
  pylons: pylons(true, NCAA_HASH_INNER),
  ball: { stripes: true },
};

export const markingsFor = (league: LeagueId): FieldMarkings => (league === 'nfl' ? NFL_MARKINGS : NCAA_MARKINGS);

/** Yard lines that carry numbers, with the number shown: 10, 20, 30, 40, 50, 40, 30, 20, 10. */
export const NUMBERED_LINES: Array<{ yard: number; label: string }> = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((yard) => ({
  yard,
  label: String(yard <= 50 ? yard : 100 - yard),
}));
