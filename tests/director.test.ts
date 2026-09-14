import { describe, expect, it } from 'vitest';
import { DIRECTOR_DEFAULTS, DIRECTOR_IDLE, directorNext, setDirectorLock, type DirectorInput, type DirectorState } from '../shared/director';
import type { Alert, AlertKind } from '../shared/model';
import type { WatchItem } from '../shared/watch';

const watchItem = (gameId: string, tier: number, label = `Tier ${tier}`, stale = false): WatchItem => ({ gameId, tier, label, reasons: [`reason ${gameId}`], stale });

let seq = 0;
const moment = (gameId: string, kind: AlertKind, receivedAt: number, extra: Partial<Alert> = {}): Alert => ({
  id: `${gameId}:${kind}:${++seq}`,
  revision: 1,
  kind,
  gameId,
  title: `${kind} in ${gameId}`,
  detail: '',
  team: null,
  period: 2,
  clock: '5:00',
  receivedAt,
  sourceTime: null,
  late: false,
  status: 'active',
  playId: null,
  priority: 1,
  ...extra,
});

const input = (overrides: Partial<DirectorInput>): DirectorInput => ({
  now: 0,
  watch: [],
  moments: [],
  live: new Set(['nfl-1', 'nfl-2', 'nfl-3']),
  muted: new Set(),
  skipped: new Map(),
  ...overrides,
});

describe('director mode', () => {
  it('is idle when nothing is live', () => {
    expect(directorNext(DIRECTOR_IDLE, input({ live: new Set() }))).toEqual(DIRECTOR_IDLE);
  });

  it('starts on the best Watch next game, with its reason', () => {
    const s = directorNext(DIRECTOR_IDLE, input({ now: 1000, watch: [watchItem('nfl-2', 1, 'One-score game late'), watchItem('nfl-1', 3)] }));
    expect(s).toMatchObject({ gameId: 'nfl-2', since: 1000, locked: false, reason: 'One-score game late · reason nfl-2' });
  });

  it('falls back to any live game when nothing ranks', () => {
    expect(directorNext(DIRECTOR_IDLE, input({ now: 5, live: new Set(['nfl-9']) }))).toMatchObject({ gameId: 'nfl-9', reason: 'Live' });
  });

  it('waits out the minimum dwell before moving to a better situation', () => {
    const start: DirectorState = { gameId: 'nfl-1', reason: 'x', since: 0, momentId: null, locked: false };
    const watch = [watchItem('nfl-2', 0, 'Overtime'), watchItem('nfl-1', 3)];
    expect(directorNext(start, input({ now: DIRECTOR_DEFAULTS.minDwellMs - 1, watch })).gameId).toBe('nfl-1');
    expect(directorNext(start, input({ now: DIRECTOR_DEFAULTS.minDwellMs, watch }))).toMatchObject({ gameId: 'nfl-2', since: DIRECTOR_DEFAULTS.minDwellMs });
  });

  it('never moves to an equal or worse situation', () => {
    const start: DirectorState = { gameId: 'nfl-1', reason: 'x', since: 0, momentId: null, locked: false };
    const watch = [watchItem('nfl-2', 2), watchItem('nfl-1', 2)];
    expect(directorNext(start, input({ now: 10 * 60_000, watch })).gameId).toBe('nfl-1');
  });

  it('cuts to a breaking moment elsewhere after a short look, only once per moment', () => {
    const start: DirectorState = { gameId: 'nfl-1', reason: 'x', since: 0, momentId: null, locked: false };
    const td = moment('nfl-3', 'touchdown', 20_000);
    const watch = [watchItem('nfl-1', 1), watchItem('nfl-3', 4)];
    const early = directorNext(start, input({ now: 5_000, watch, moments: [moment('nfl-3', 'touchdown', 4_000)] }));
    expect(early.gameId).toBe('nfl-1');
    const cut = directorNext(start, input({ now: 21_000, watch, moments: [td] }));
    expect(cut).toMatchObject({ gameId: 'nfl-3', momentId: td.id, reason: `Just happened · ${td.title}` });
    // Back on nfl-1 by the viewer's choice, the same touchdown does not pull the director away again.
    const back: DirectorState = { gameId: 'nfl-1', reason: 'x', since: 21_000, momentId: td.id, locked: false };
    expect(directorNext(back, input({ now: 40_000, watch, moments: [td] })).gameId).toBe('nfl-1');
  });

  it('does not cut away when the current game has its own breaking moment, or for late updates', () => {
    const start: DirectorState = { gameId: 'nfl-1', reason: 'x', since: 0, momentId: null, locked: false };
    const watch = [watchItem('nfl-1', 2)];
    const both = [moment('nfl-3', 'touchdown', 30_000), moment('nfl-1', 'turnover', 29_000)];
    expect(directorNext(start, input({ now: 31_000, watch, moments: both })).gameId).toBe('nfl-1');
    const late = [moment('nfl-3', 'touchdown', 30_000, { late: true })];
    expect(directorNext(start, input({ now: 31_000, watch, moments: late })).gameId).toBe('nfl-1');
    const withdrawn = [moment('nfl-3', 'touchdown', 30_000, { status: 'withdrawn' })];
    expect(directorNext(start, input({ now: 31_000, watch, moments: withdrawn })).gameId).toBe('nfl-1');
  });

  it('moves on when the current game ends, and stays while locked', () => {
    const start: DirectorState = { gameId: 'nfl-1', reason: 'x', since: 0, momentId: null, locked: false };
    const watch = [watchItem('nfl-2', 0)];
    expect(directorNext(start, input({ now: 1_000, watch, live: new Set(['nfl-2']) })).gameId).toBe('nfl-2');
    const locked = setDirectorLock(start, true);
    expect(directorNext(locked, input({ now: 10 * 60_000, watch, moments: [moment('nfl-2', 'touchdown', 10 * 60_000 - 1)] })).gameId).toBe('nfl-1');
    const unlocked = setDirectorLock(locked, false);
    expect(directorNext(unlocked, input({ now: 10 * 60_000, watch })).gameId).toBe('nfl-2');
    expect(setDirectorLock(DIRECTOR_IDLE, true)).toEqual(DIRECTOR_IDLE);
  });

  it('never follows muted, skipped or stale games', () => {
    const watch = [watchItem('nfl-1', 0, 'Overtime', true), watchItem('nfl-2', 1), watchItem('nfl-3', 2)];
    const muted = directorNext(DIRECTOR_IDLE, input({ now: 1, watch, muted: new Set(['nfl-2']) }));
    expect(muted.gameId).toBe('nfl-3');
    const skipping = { gameId: 'nfl-3', reason: 'x', since: 0, momentId: null, locked: false };
    const skipped = directorNext(skipping, input({ now: 100, watch, skipped: new Map([['nfl-3', 60_000]]) }));
    expect(skipped.gameId).toBe('nfl-2');
    expect(directorNext(skipped, input({ now: 120_000, watch, skipped: new Map([['nfl-3', 60_000]]) })).gameId).toBe('nfl-2');
  });
});
