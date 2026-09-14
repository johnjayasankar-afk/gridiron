/**
 * The drive tracker: where a drive started, each reported play in it and where
 * the ball is now, on the schematic field (0 at the away goal line, 100 at the
 * home goal line). Only reported spots are used. A play without a reported spot
 * keeps its row with no position, and nothing is drawn between spots that were
 * never reported.
 *
 * During a replay (`upToOrder`), the drive is cut at the inspected play and its
 * reported totals and result stay hidden, so later plays are not given away.
 */
import { attackDirection, firstDownTarget, schematicYardFromProgress, yardsGained, type Side } from './field.js';
import { downDistance, teamFor } from './format.js';
import type { GameDetail, GameSummary, PlayEvent, PlayKind, Situation } from './model.js';
import { TOUCHDOWN_KINDS } from './model.js';
import { currentDriveId, driveResultLabel, inspectablePlays } from './replayFrames.js';

export type DrivePlayTone = 'gain' | 'loss' | 'even' | 'score' | 'conceded' | 'turnover' | 'penalty' | 'kick' | 'unknown';

export interface DriveTrackPlay {
  id: string;
  order: number;
  kind: PlayKind;
  period: number | null;
  clock: string | null;
  description: string;
  /** Down and distance before the snap, when reported. */
  downDistance: string | null;
  /** Schematic yard before and after the play; null when that spot was not reported. */
  from: number | null;
  to: number | null;
  /** Yards for the offense: the provider's figure, or the distance between two reported spots. */
  gain: number | null;
  tone: DrivePlayTone;
  penalty: boolean;
}

export interface DriveTrack {
  driveId: string;
  offense: Side | null;
  /** +1 when the offense attacks toward the home end zone, -1 toward the away end zone. */
  direction: 1 | -1 | null;
  inProgress: boolean;
  /** Where the drive started, when reported. */
  start: number | null;
  startLabel: string | null;
  /** The latest reported spot: the live pre-snap spot while it belongs to this drive, otherwise where the last spotted play ended. */
  ball: number | null;
  ballSource: 'live' | 'play' | null;
  /** The line to gain from reported down and distance. Null when the goal line is the target or it is unknown. */
  lineToGain: number | null;
  goalToGo: boolean;
  plays: DriveTrackPlay[];
  playCount: number;
  yards: number | null;
  yardsSource: 'reported' | 'spots' | null;
  timeElapsed: string | null;
  result: string | null;
  isScore: boolean;
  /** Plays with neither a start nor an end spot. */
  unspotted: number;
}

export interface DriveTrackOptions {
  /** Defaults to the provider's current drive, or the latest drive. */
  driveId?: string | null;
  /** Replay: ignore plays after this order. */
  upToOrder?: number | null;
  /** The live situation. Used only while the drive is in progress and possession matches. */
  situation?: Situation | null;
}

const KICKOFF_KINDS: ReadonlySet<PlayKind> = new Set(['kickoff', 'kickoff_return']);
const KICK_KINDS: ReadonlySet<PlayKind> = new Set(['kickoff', 'kickoff_return', 'punt', 'punt_return', 'punt_blocked', 'field_goal_missed', 'field_goal_blocked', 'extra_point', 'two_point']);
/** Not counted as the offense's plays when the provider gives no count. */
const UNCOUNTED_KINDS: ReadonlySet<PlayKind> = new Set(['kickoff', 'kickoff_return', 'extra_point', 'two_point', 'penalty']);

const other = (side: Side): Side => (side === 'home' ? 'away' : 'home');

function reportedGain(p: PlayEvent): number | null {
  if (p.yards !== null && Number.isFinite(p.yards)) return p.yards;
  const a = p.start?.spot;
  const b = p.end?.spot;
  if (!a || !b || a.progress === null || b.progress === null || a.offense === null || b.offense === null) return null;
  return yardsGained({ progress: a.progress, offense: a.offense }, { progress: b.progress, offense: b.offense });
}

/** Tone and gain from explicit play types and flags only. */
function classify(p: PlayEvent, offense: Side | null): { tone: DrivePlayTone; gain: number | null } {
  const scored = p.scoring === true || (p.scoring !== false && (TOUCHDOWN_KINDS.has(p.kind) || p.kind === 'field_goal_good' || p.kind === 'safety'));
  if (scored) {
    // A safety always counts for the defense.
    const by = p.scoringTeam ?? (p.kind === 'safety' ? (offense ? other(offense) : null) : p.offense);
    if (offense && by && by !== offense) return { tone: 'conceded', gain: null };
    return { tone: 'score', gain: KICK_KINDS.has(p.kind) || p.kind === 'field_goal_good' ? null : reportedGain(p) };
  }
  if (p.turnover === true || p.kind === 'interception' || p.kind === 'fumble_lost') return { tone: 'turnover', gain: null };
  if (KICK_KINDS.has(p.kind)) return { tone: 'kick', gain: null };
  const gain = reportedGain(p);
  if (p.kind === 'penalty') return { tone: 'penalty', gain };
  return { tone: gain === null ? 'unknown' : gain > 0 ? 'gain' : gain < 0 ? 'loss' : 'even', gain };
}

export function driveTrack(detail: GameDetail, options: DriveTrackOptions = {}): DriveTrack | null {
  const driveId = options.driveId ?? currentDriveId(detail);
  if (!driveId) return null;
  const drive = detail.drives.find((d) => d.id === driveId) ?? null;
  const all = inspectablePlays(detail, driveId);
  if (!drive && !all.length) return null;
  const upTo = options.upToOrder ?? null;
  const plays = upTo === null ? all : all.filter((p) => p.order <= upTo);
  const truncated = plays.length < all.length;
  const offense = drive?.offense ?? plays.find((p) => p.offense !== null && !KICKOFF_KINDS.has(p.kind))?.offense ?? null;
  const direction = offense ? attackDirection(offense) : null;

  const rows: DriveTrackPlay[] = plays.map((p) => {
    const { tone, gain } = classify(p, offense);
    return {
      id: p.id,
      order: p.order,
      kind: p.kind,
      period: p.period,
      clock: p.clock,
      description: p.description,
      downDistance: downDistance(p.start) ?? p.start?.downDistanceText ?? null,
      from: p.start?.spot.schematicYard ?? null,
      to: p.end?.spot.schematicYard ?? null,
      gain,
      tone,
      penalty: p.penalty === true || p.kind === 'penalty',
    };
  });

  const decisive = rows.some((r) => r.tone === 'score' || r.tone === 'conceded' || r.tone === 'turnover');
  const result = truncated ? null : driveResultLabel(drive?.result ?? null);
  const inProgress = !decisive && result === null && (truncated || drive?.isCurrent === true || detail.currentDriveId === driveId);

  const firstSnap = plays.find((p) => !KICKOFF_KINDS.has(p.kind) && p.start?.spot.schematicYard != null);
  const afterKick = plays.find((p) => KICKOFF_KINDS.has(p.kind) && p.end?.spot.schematicYard != null);
  const start = drive?.start?.spot.schematicYard ?? firstSnap?.start?.spot.schematicYard ?? afterKick?.end?.spot.schematicYard ?? null;
  const startLabel = drive?.start?.label ?? drive?.start?.spot.label ?? firstSnap?.start?.spot.label ?? null;

  const live = options.situation ?? null;
  const liveSpot = !truncated && inProgress && live && live.spot.schematicYard !== null && (offense === null || live.possession === offense) ? live : null;
  let lastSpotted: PlayEvent | null = null;
  for (let i = plays.length - 1; i >= 0 && !lastSpotted; i--) if (plays[i].end?.spot.schematicYard != null) lastSpotted = plays[i];
  const ball = liveSpot ? liveSpot.spot.schematicYard : (lastSpotted?.end?.spot.schematicYard ?? null);
  const ballSource: DriveTrack['ballSource'] = liveSpot ? 'live' : ball !== null ? 'play' : null;

  let lineToGain: number | null = null;
  let goalToGo = false;
  if (inProgress) {
    const last = plays[plays.length - 1];
    const state = liveSpot
      ? { progress: liveSpot.spot.progress, offense: liveSpot.spot.offense ?? liveSpot.possession, distance: liveSpot.distance, goalToGo: liveSpot.goalToGo }
      : last && last === lastSpotted && last.end && last.end.down !== null
        ? { progress: last.end.spot.progress, offense: last.end.spot.offense, distance: last.end.distance, goalToGo: last.end.goalToGo }
        : null;
    if (state && state.progress !== null && state.offense) {
      const target = firstDownTarget(state.progress, state.distance, state.goalToGo === true);
      if (target?.kind === 'line') lineToGain = schematicYardFromProgress(target.progress, state.offense);
      goalToGo = target?.kind === 'goal';
    }
  }

  let yards: number | null = null;
  let yardsSource: DriveTrack['yardsSource'] = null;
  const lostBall = rows.some((r) => r.tone === 'turnover' || r.tone === 'conceded');
  if (!truncated && drive?.yards != null) {
    yards = drive.yards;
    yardsSource = 'reported';
  } else if (start !== null && ball !== null && direction !== null && !lostBall) {
    yards = Math.round((ball - start) * direction);
    yardsSource = 'spots';
  }

  return {
    driveId,
    offense,
    direction,
    inProgress,
    start,
    startLabel,
    ball,
    ballSource,
    lineToGain,
    goalToGo,
    plays: rows,
    playCount: !truncated && drive?.offensivePlays != null ? drive.offensivePlays : rows.filter((r) => !UNCOUNTED_KINDS.has(r.kind)).length,
    yards,
    yardsSource,
    timeElapsed: truncated ? null : (drive?.timeElapsed ?? null),
    result,
    isScore: (!truncated && drive?.isScore === true) || rows.some((r) => r.tone === 'score'),
    unspotted: rows.filter((r) => r.from === null && r.to === null).length,
  };
}

/** Whether the track has anything to draw. */
export function hasDrivePosition(track: DriveTrack | null): track is DriveTrack {
  return !!track && (track.start !== null || track.ball !== null || track.plays.some((p) => p.from !== null || p.to !== null));
}

/** "7 plays", "48 yds", "3:12": the parts that were reported or measured. */
export function driveStats(track: DriveTrack): string[] {
  return [
    `${track.playCount} ${track.playCount === 1 ? 'play' : 'plays'}`,
    track.yards === null ? null : `${track.yards} ${Math.abs(track.yards) === 1 ? 'yd' : 'yds'}`,
    track.timeElapsed,
  ].filter((s): s is string => !!s);
}

/** The reported result, or what the drive's reported plays show while no result is reported. Null while in progress. */
export function driveOutcome(track: DriveTrack): string | null {
  if (track.result) return track.result;
  if (track.inProgress) return null;
  if (track.plays.some((p) => p.tone === 'score')) return 'Scored';
  if (track.plays.some((p) => p.tone === 'turnover')) return 'Turnover';
  if (track.plays.some((p) => p.tone === 'conceded')) return 'Defense scored';
  return null;
}

/** A sentence for screen readers, e.g. "BUF drive in progress: 7 plays, 48 yards, from BUF 25." */
export function describeDrive(track: DriveTrack, game: GameSummary): string {
  const team = teamFor(game, track.offense)?.abbreviation ?? null;
  const parts = [`${track.playCount} ${track.playCount === 1 ? 'play' : 'plays'}`];
  if (track.yards !== null) parts.push(`${track.yards} ${Math.abs(track.yards) === 1 ? 'yard' : 'yards'}`);
  if (track.startLabel) parts.push(`from ${track.startLabel}`);
  const state = track.inProgress ? ' in progress' : track.result ? ` ended, ${track.result.toLowerCase()}` : '';
  return `${team ? `${team} drive` : 'Drive'}${state}: ${parts.join(', ')}.`;
}
