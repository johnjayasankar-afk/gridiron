/**
 * A day of the tape, written as a file.
 *
 * The recording lives in session storage and dies with the tab, so the tape can
 * never show last Sunday, compare two Sundays, or be shared. A file is the
 * cheapest escalation: it needs no server, works on every deployment, and turns
 * a recording into something that can be kept, sent and read back.
 *
 * The envelope is most of the point. A tape is only meaningful with the
 * provenance attached, and an imported tape is a different object from the one
 * this browser is recording: it was made by another device, on another clock,
 * possibly behind a different spoiler delay. So the file says who recorded it,
 * from which source, when, and by which build, and nothing reads a tape without
 * reading that first.
 *
 * What it never does is merge. An imported day is shown as itself or not at all.
 */
import type { GameId } from './model.js';
import { unpack, type Packed, type TapeTrack } from './tape.js';

/** Raised when the shape changes in a way an older reader would misread. */
export const TAPE_FILE_VERSION = 1;

/** Who made the recording. A device saw what it was shown; a server watched continuously. */
export type TapeOrigin = 'device' | 'server';

export interface TapeFile {
  format: 'gridiron.tape';
  version: number;
  /** The source the recording was made from, so a live tape is never read as a replay. */
  sourceKey: string;
  origin: TapeOrigin;
  /** The day the tape covers, as the slate names it (YYYYMMDD), where one is known. */
  day: string | null;
  /** A label for a person: what this is a tape of. */
  label: string;
  /** When the file was written, and by which build. */
  writtenAt: number;
  build: string;
  order: GameId[];
  tracks: Record<GameId, Packed[]>;
}

export interface TapeFileMeta {
  sourceKey: string;
  origin: TapeOrigin;
  day: string | null;
  label: string;
  build: string;
}

/** Builds the file. The caller owns the packing, because the store already holds packed samples. */
export function writeTapeFile(meta: TapeFileMeta, order: GameId[], tracks: Record<GameId, Packed[]>, now: number): TapeFile {
  const kept = order.filter((id) => tracks[id]?.length);
  return {
    format: 'gridiron.tape',
    version: TAPE_FILE_VERSION,
    sourceKey: meta.sourceKey,
    origin: meta.origin,
    day: meta.day,
    label: meta.label,
    writtenAt: now,
    build: meta.build,
    order: kept,
    tracks: Object.fromEntries(kept.map((id) => [id, tracks[id]])),
  };
}

/** A name a person can find again: the day, and what it was a tape of. */
export function tapeFileName(file: Pick<TapeFile, 'day' | 'origin' | 'writtenAt'>): string {
  const day = file.day && /^\d{8}$/.test(file.day) ? `${file.day.slice(0, 4)}-${file.day.slice(4, 6)}-${file.day.slice(6, 8)}` : new Date(file.writtenAt).toISOString().slice(0, 10);
  return `gridiron-tape-${day}${file.origin === 'server' ? '' : '-device'}.json`;
}

export type TapeFileRead = { ok: true; file: TapeFile; tracks: TapeTrack[] } | { ok: false; error: string };

const isPacked = (v: unknown): v is Packed => Array.isArray(v) && v.length >= 10 && typeof v[0] === 'number';

/**
 * Reads a file back, and refuses anything it cannot vouch for.
 *
 * A tape drawn from a half-understood file would be a drawing of something that
 * was never recorded, which is the one thing this product does not do. So every
 * refusal below is deliberate, and each says what was wrong rather than failing
 * silently into an empty tape.
 */
export function readTapeFile(text: string): TapeFileRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not a Gridiron tape: it is not JSON.' };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'That file is not a Gridiron tape.' };
  const f = raw as Partial<TapeFile>;
  if (f.format !== 'gridiron.tape') return { ok: false, error: 'That file is not a Gridiron tape.' };
  if (typeof f.version !== 'number') return { ok: false, error: 'That tape file has no version.' };
  if (f.version > TAPE_FILE_VERSION) return { ok: false, error: `That tape was written by a newer version of Gridiron (file ${f.version}, this build reads ${TAPE_FILE_VERSION}).` };
  if (typeof f.sourceKey !== 'string' || !f.sourceKey) return { ok: false, error: 'That tape does not say what it was recorded from.' };
  if (f.origin !== 'device' && f.origin !== 'server') return { ok: false, error: 'That tape does not say who recorded it.' };
  if (!Array.isArray(f.order) || !f.tracks || typeof f.tracks !== 'object') return { ok: false, error: 'That tape has no games in it.' };

  const tracks: TapeTrack[] = [];
  for (const id of f.order) {
    if (typeof id !== 'string') continue;
    const packed = (f.tracks as Record<string, unknown>)[id];
    if (!Array.isArray(packed) || !packed.every(isPacked)) return { ok: false, error: `That tape's recording of ${id} is not readable.` };
    if (packed.length) tracks.push({ gameId: id as GameId, samples: (packed as Packed[]).map(unpack) });
  }
  if (!tracks.length) return { ok: false, error: 'That tape has no games in it.' };

  return {
    ok: true,
    file: {
      format: 'gridiron.tape',
      version: f.version,
      sourceKey: f.sourceKey,
      origin: f.origin,
      day: typeof f.day === 'string' ? f.day : null,
      label: typeof f.label === 'string' && f.label ? f.label : 'An imported tape',
      writtenAt: typeof f.writtenAt === 'number' ? f.writtenAt : 0,
      build: typeof f.build === 'string' ? f.build : 'unknown',
      order: tracks.map((t) => t.gameId),
      tracks: f.tracks as Record<GameId, Packed[]>,
    },
    tracks,
  };
}
