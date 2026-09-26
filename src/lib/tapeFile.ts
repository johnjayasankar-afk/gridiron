/**
 * Writing the day's tape to a file, and reading one back.
 *
 * The recording is kept in session storage and dies with the tab. A file is the
 * cheapest way out of that: no server, no storage quota, and it works on every
 * deployment. The format and every refusal live in `shared/tapeFile.ts`, because
 * a file written by one build and read by another has to agree about them.
 */
import { pack, type TapeTrack } from '../../shared/tape';
import { readTapeFile, tapeFileName, writeTapeFile, type TapeFileMeta } from '../../shared/tapeFile';
import type { ImportedTape } from '../state/tape';
import { VERSION } from '../../shared/version';
import type { GameId } from '../../shared/model';

/** Hands the browser a file to save. A download is not a navigation, so the page's policy does not stand in the way. */
function offer(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn of the loop: revoking immediately cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportTape(meta: Omit<TapeFileMeta, 'build'>, order: GameId[], tracks: Record<GameId, TapeTrack>, now = Date.now()): string {
  const packed = Object.fromEntries(order.filter((id) => tracks[id]).map((id) => [id, tracks[id].samples.map(pack)]));
  const file = writeTapeFile({ ...meta, build: VERSION }, order, packed, now);
  const name = tapeFileName(file);
  offer(name, JSON.stringify(file));
  return name;
}

/** Reads a file a person chose, and hands back either a tape or the reason it was refused. */
export async function importTape(file: File): Promise<{ ok: true; tape: ImportedTape } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: 'That file could not be read.' };
  }
  const read = readTapeFile(text);
  if (!read.ok) return { ok: false, error: read.error };
  const tracks: Record<GameId, TapeTrack> = {};
  for (const track of read.tracks) tracks[track.gameId] = track;
  return { ok: true, tape: { file: read.file, tracks, order: read.tracks.map((t) => t.gameId) } };
}
