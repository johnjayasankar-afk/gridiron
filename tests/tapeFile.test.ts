/**
 * A tape written to a file and read back. The recording otherwise dies with the
 * tab, so this is the cheapest thing that lets a Sunday be kept or sent.
 *
 * Most of these are refusals. A tape drawn from a half-understood file would be
 * a drawing of something nobody recorded, so the reader would rather say no.
 */
import { describe, expect, it } from 'vitest';
import type { GameId } from '../shared/model';
import { pack, type TapeSample } from '../shared/tape';
import { readTapeFile, tapeFileName, writeTapeFile, TAPE_FILE_VERSION } from '../shared/tapeFile';

const sample = (at: number, home: number, away: number, wp: number | null): TapeSample => ({
  at,
  home,
  away,
  wp,
  period: 2,
  clock: '5:00',
  clockSeconds: 300,
  kind: 'in_progress',
  possession: 'home',
  redZone: false,
  play: null,
});

const META = { sourceKey: 'live|1|0', origin: 'device' as const, day: '20260913', label: 'Sunday 13 September', build: '0.6.0' };
const ORDER = ['nfl-1', 'nfl-2'] as GameId[];
const TRACKS = {
  'nfl-1': [sample(1000, 0, 0, 0.5), sample(2000, 7, 0, 0.62)].map(pack),
  'nfl-2': [sample(1000, 3, 3, 0.5)].map(pack),
} as Record<GameId, ReturnType<typeof pack>[]>;

const written = () => writeTapeFile(META, ORDER, TRACKS, 1_700_000_000_000);

describe('writing a tape', () => {
  it('carries who recorded it, from what, when and with which build', () => {
    const f = written();
    expect(f).toMatchObject({ format: 'gridiron.tape', version: TAPE_FILE_VERSION, sourceKey: 'live|1|0', origin: 'device', day: '20260913', build: '0.6.0' });
    expect(f.writtenAt).toBe(1_700_000_000_000);
  });

  it('leaves out a game it recorded nothing for', () => {
    const f = writeTapeFile(META, [...ORDER, 'nfl-3' as GameId], TRACKS, 1);
    expect(f.order).toEqual(ORDER);
    expect(Object.keys(f.tracks)).toEqual(ORDER);
  });

  it('is named after the day it covers', () => {
    expect(tapeFileName(written())).toBe('gridiron-tape-2026-09-13-device.json');
    expect(tapeFileName({ day: null, origin: 'server', writtenAt: Date.parse('2026-09-20T12:00:00Z') })).toBe('gridiron-tape-2026-09-20.json');
  });
});

describe('reading one back', () => {
  it('returns every sample it was given', () => {
    const read = readTapeFile(JSON.stringify(written()));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.tracks.map((t) => t.gameId)).toEqual(ORDER);
    expect(read.tracks[0].samples).toHaveLength(2);
    expect(read.tracks[0].samples[1]).toMatchObject({ at: 2000, home: 7, away: 0, wp: 0.62, clock: '5:00', kind: 'in_progress' });
    expect(read.file.label).toBe('Sunday 13 September');
  });

  it('keeps the provenance, which is what makes it a different object', () => {
    const read = readTapeFile(JSON.stringify(written()));
    expect(read.ok && read.file.origin).toBe('device');
    expect(read.ok && read.file.sourceKey).toBe('live|1|0');
  });

  for (const [name, text] of [
    ['something that is not JSON', 'not json at all'],
    ['a JSON document that is not a tape', '{"hello":"world"}'],
    ['a tape with no games', JSON.stringify({ ...written(), order: [], tracks: {} })],
    ['a tape that does not say what it recorded', JSON.stringify({ ...written(), sourceKey: '' })],
    ['a tape that does not say who recorded it', JSON.stringify({ ...written(), origin: 'somebody' })],
    ['a recording that is not samples', JSON.stringify({ ...written(), tracks: { 'nfl-1': [{ at: 1 }], 'nfl-2': [] } })],
  ] as const) {
    it(`refuses ${name}, and says why`, () => {
      const read = readTapeFile(text);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.length).toBeGreaterThan(10);
      expect(read.error).toMatch(/tape|JSON/i);
    });
  }

  it('refuses a tape from a newer build rather than half understanding it', () => {
    const read = readTapeFile(JSON.stringify({ ...written(), version: TAPE_FILE_VERSION + 1 }));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain('newer version');
  });

  it('reads a tape from an older build, which is what the version is for', () => {
    const read = readTapeFile(JSON.stringify({ ...written(), version: TAPE_FILE_VERSION - 1 }));
    expect(read.ok).toBe(true);
  });

  it('survives a round trip unchanged', () => {
    const once = readTapeFile(JSON.stringify(written()));
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const again = readTapeFile(JSON.stringify(writeTapeFile({ ...META, label: once.file.label }, once.file.order, once.file.tracks, once.file.writtenAt)));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.tracks).toEqual(once.tracks);
  });
});
