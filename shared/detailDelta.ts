/**
 * Game detail travels as a delta once a client holds a version: changed or new
 * plays, removed play ids, and the full (small) drive, scoring and stats lists.
 * The win probability series and market price history travel only when they changed.
 * A client that does not hold `baseVersion` must fetch the full detail instead.
 */
import { sameHistory } from './marketHistory.js';
import type { GameDetail, MarketHistory, PlayEvent, WinProbabilityPoint } from './model.js';

export interface DetailDelta {
  gameId: string;
  baseVersion: number;
  version: number;
  summary: GameDetail['summary'];
  drives: GameDetail['drives'];
  scoring: GameDetail['scoring'];
  stats: GameDetail['stats'];
  leaders: GameDetail['leaders'];
  attendance: GameDetail['attendance'];
  gaps: GameDetail['gaps'];
  currentDriveId: string | null;
  upserts: PlayEvent[];
  removed: string[];
  /** Every play id in order, so reordering is carried without resending plays. */
  order: string[];
  /** The whole win probability series, present only when it changed. */
  winProbability?: WinProbabilityPoint[];
  /** The whole market price history, present only when it changed; null when it was removed. */
  marketHistory?: MarketHistory | null;
}

function sameSeries(a: WinProbabilityPoint[] = [], b: WinProbabilityPoint[] = []): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].playId !== b[i].playId || a[i].home !== b[i].home || a[i].tie !== b[i].tie) return false;
  return true;
}

export function computeDetailDelta(prev: GameDetail | null, next: GameDetail, baseVersion: number, version: number): DetailDelta {
  const before = new Map((prev?.plays ?? []).map((p) => [p.id, p]));
  const upserts: PlayEvent[] = [];
  for (const p of next.plays) {
    const old = before.get(p.id);
    if (!old || old.revision !== p.revision || old.order !== p.order || old.driveId !== p.driveId || old.scoringTeam !== p.scoringTeam) upserts.push(p);
  }
  const nextIds = new Set(next.plays.map((p) => p.id));
  const removed = [...before.keys()].filter((id) => !nextIds.has(id));
  return {
    gameId: next.gameId,
    baseVersion,
    version,
    summary: next.summary,
    drives: next.drives,
    scoring: next.scoring,
    stats: next.stats,
    leaders: next.leaders,
    attendance: next.attendance,
    gaps: next.gaps,
    currentDriveId: next.currentDriveId,
    upserts,
    removed,
    order: next.plays.map((p) => p.id),
    ...(sameSeries(prev?.winProbability, next.winProbability) ? {} : { winProbability: next.winProbability ?? [] }),
    ...(sameHistory(prev?.marketHistory, next.marketHistory) ? {} : { marketHistory: next.marketHistory ?? null }),
  };
}

/** Apply a delta. Throws when the delta references a play the client does not hold. */
export function applyDetailDelta(prev: GameDetail, delta: DetailDelta): GameDetail {
  const byId = new Map(prev.plays.map((p) => [p.id, p]));
  for (const id of delta.removed) byId.delete(id);
  for (const p of delta.upserts) byId.set(p.id, p);
  const plays = delta.order.map((id, i) => {
    const p = byId.get(id);
    if (!p) throw new Error(`Detail delta for ${delta.gameId} references unknown play ${id}`);
    return p.order === i ? p : { ...p, order: i };
  });
  const winProbability = delta.winProbability ?? prev.winProbability;
  const marketHistory = delta.marketHistory !== undefined ? delta.marketHistory : prev.marketHistory;
  return {
    gameId: prev.gameId,
    summary: delta.summary,
    drives: delta.drives,
    scoring: delta.scoring,
    stats: delta.stats,
    leaders: delta.leaders ?? [],
    attendance: delta.attendance ?? null,
    gaps: delta.gaps,
    currentDriveId: delta.currentDriveId,
    plays,
    ...(winProbability ? { winProbability } : {}),
    ...(marketHistory ? { marketHistory } : {}),
  };
}
