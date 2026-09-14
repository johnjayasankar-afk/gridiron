/**
 * Field geometry and ball-spot math.
 *
 * Three coordinate systems, kept strictly apart:
 *
 * 1. Progress: yards from the OFFENSE's own goal line. 0 is the offense's own
 *    goal line, 50 is midfield, 100 is the opponent's goal line. This is what a
 *    reported spot means to the team with the ball, so every football rule
 *    (red zone, goal to go, first-down target) is written against it.
 *
 * 2. Schematic yards: 0 to 100 along the drawn field, independent of who has the
 *    ball. By convention the AWAY team defends the left goal line (0) and the
 *    HOME team defends the right goal line (100). The real stadium direction is
 *    not reported, so this is a schematic orientation and is labelled as one.
 *
 * 3. World units: schematic yards centred on the origin, used by the renderer.
 *    One world unit is one yard; x runs along the field, z across it.
 */

export type Side = 'home' | 'away';

/** Field dimensions in yards. */
export const FIELD = {
  playing: 100,
  endZone: 10,
  total: 120,
  width: 160 / 3, // 53 1/3 yards
} as const;

/** Where a ball spot came from, so the UI can say how much to trust it. */
export type SpotProvenance =
  | 'yards-to-endzone' // provider's explicit distance to the opponent end zone
  | 'label' // parsed from a team-relative label such as "BUF 35"
  | 'home-yardline' // provider's absolute yard line measured from the home goal line
  | 'unknown';

export interface TeamSides {
  home: { abbreviation: string };
  away: { abbreviation: string };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isYard = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/** Progress from the provider's distance to the opponent's end zone. */
export function progressFromYardsToEndzone(yardsToEndzone: unknown): number | null {
  return isYard(yardsToEndzone) ? 100 - yardsToEndzone : null;
}

/**
 * Progress from an absolute yard line measured from the home team's goal line
 * (0 at the home goal line, 100 at the away goal line), which is how the ESPN
 * feed reports `yardLine`. A home offense moving away from its own goal line
 * therefore has progress equal to the yard line; an away offense mirrors it.
 */
export function progressFromHomeYardLine(yardLine: unknown, offense: Side): number | null {
  if (!isYard(yardLine)) return null;
  return offense === 'home' ? yardLine : 100 - yardLine;
}

/**
 * Progress from a team-relative label: "BUF 35", "NE 25", "50", "MID 50".
 * The label names the team whose half the ball is in. It is the offense's own
 * half when that team is the offense, and the opponent's half otherwise.
 */
export function progressFromLabel(label: unknown, offense: Side, teams: TeamSides): number | null {
  if (typeof label !== 'string') return null;
  const text = label.trim().toUpperCase();
  if (!text) return null;
  const midfield = /^(?:MID(?:FIELD)?\s*)?50$/.exec(text);
  if (midfield) return 50;
  const m = /^([A-Z0-9&.'-]{1,8})\s+(\d{1,2})$/.exec(text);
  if (!m) return null;
  const abbr = m[1];
  const yard = Number(m[2]);
  if (!(yard >= 0 && yard <= 50)) return null;
  if (yard === 50) return 50;
  const offenseAbbr = teams[offense].abbreviation.toUpperCase();
  const defenseAbbr = teams[offense === 'home' ? 'away' : 'home'].abbreviation.toUpperCase();
  if (abbr === offenseAbbr) return yard;
  if (abbr === defenseAbbr) return 100 - yard;
  return null; // a label naming neither team cannot be placed
}

/** "BUF 35", "NE 25" or "50" for a progress value. */
export function labelFromProgress(progress: number, offense: Side, teams: TeamSides): string {
  const p = Math.round(clamp(progress, 0, 100));
  if (p === 50) return '50';
  const offenseAbbr = teams[offense].abbreviation;
  const defenseAbbr = teams[offense === 'home' ? 'away' : 'home'].abbreviation;
  if (p === 0) return `${offenseAbbr} goal line`;
  if (p === 100) return `${defenseAbbr} goal line`;
  return p < 50 ? `${offenseAbbr} ${p}` : `${defenseAbbr} ${100 - p}`;
}

/** Plain-language position for text summaries: "own 35", "opponent 25", "midfield". */
export function describeProgress(progress: number): string {
  const p = Math.round(clamp(progress, 0, 100));
  if (p === 50) return 'midfield';
  if (p === 0) return 'own goal line';
  if (p === 100) return 'opponent goal line';
  return p < 50 ? `own ${p}` : `opponent ${100 - p}`;
}

/** +1 when the offense attacks toward increasing schematic yards (away offense), -1 otherwise. */
export function attackDirection(offense: Side): 1 | -1 {
  return offense === 'away' ? 1 : -1;
}

/** Schematic yard (0 at the away goal line, 100 at the home goal line) for an offense's progress. */
export function schematicYardFromProgress(progress: number, offense: Side): number {
  return offense === 'away' ? progress : 100 - progress;
}

/** Inverse of schematicYardFromProgress. */
export function progressFromSchematicYard(yard: number, offense: Side): number {
  return offense === 'away' ? yard : 100 - yard;
}

/** Renderer x for a schematic yard: the field's centre is 0, goal lines are at -50 and +50. */
export function worldX(schematicYard: number): number {
  return schematicYard - 50;
}

/** Renderer x for an offense's progress. */
export function worldXFromProgress(progress: number, offense: Side): number {
  return worldX(schematicYardFromProgress(progress, offense));
}

/**
 * The line the offense must reach for a first down.
 * Goal to go (or a line to gain at or beyond the goal line) targets the goal
 * line itself, and no separate first-down marker is drawn.
 */
export function firstDownTarget(
  progress: number | null,
  distance: number | null,
  goalToGo: boolean,
): { progress: number; kind: 'line' | 'goal' } | null {
  if (progress === null) return null;
  if (goalToGo) return { progress: 100, kind: 'goal' };
  if (distance === null || !Number.isFinite(distance) || distance <= 0) return null;
  const target = progress + distance;
  if (target >= 100) return { progress: 100, kind: 'goal' };
  return { progress: target, kind: 'line' };
}

/** The red zone is inside the opponent's 20-yard line. */
export const RED_ZONE_START = 80;
export function isInRedZone(progress: number | null): boolean | null {
  return progress === null ? null : progress >= RED_ZONE_START;
}

/**
 * Yardage between two reported spots, from the perspective of the offense that
 * held the ball at the start. A turnover is expressed in the original offense's
 * frame, so a change of possession does not flip the sign of the movement.
 */
export function yardsGained(
  start: { progress: number; offense: Side },
  end: { progress: number; offense: Side },
): number {
  const endInStartFrame = start.offense === end.offense ? end.progress : 100 - end.progress;
  return Math.round((endInStartFrame - start.progress) * 10) / 10;
}

/**
 * Lateral position across the field, 0 to 1: 0 is the far sideline (the top of
 * the schematic, negative z in the renderer) and 1 the near sideline. No live
 * provider reports it today.
 */
export function isValidLateral(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Renderer z for a lateral position; the centre line when the position is not known. */
export function lateralZ(lateral: number | null | undefined): number {
  return isValidLateral(lateral) ? (lateral - 0.5) * FIELD.width : 0;
}

/** The hash marks as lateral positions: NFL hashes sit 70 ft 9 in from each sideline, college hashes 60 ft, on a field 160 ft wide. */
export const HASH_LATERAL = {
  nfl: [70.75 / 160, 1 - 70.75 / 160],
  cfb: [60 / 160, 1 - 60 / 160],
} as const satisfies Record<'nfl' | 'cfb', readonly [number, number]>;
