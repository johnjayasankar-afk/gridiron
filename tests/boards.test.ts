import { describe, expect, it } from 'vitest';
import { decodeBoard, encodeBoard, resolveBoardGames, sanitizeBoardName, type BoardShare } from '../shared/boards';
import { game } from './helpers/builders';

const board: BoardShare = {
  name: 'Sunday · Bills & friends 🦬',
  teams: ['nfl-2', 'cfb-333'],
  games: ['nfl-401772834'],
  focus: ['nfl-401772834'],
  league: 'all',
  divisions: ['FBS', 'FCS'],
  layout: 'focus',
  density: 'compact',
};

const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('shared boards', () => {
  it('round-trips through a URL-safe parameter', () => {
    const encoded = encodeBoard(board);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBoard(encoded)).toEqual(board);
  });

  it('rejects malformed, oversized and unversioned input', () => {
    expect(decodeBoard(null)).toBeNull();
    expect(decodeBoard('')).toBeNull();
    expect(decodeBoard('not base64!')).toBeNull();
    expect(decodeBoard(Buffer.from('{not json').toString('base64url'))).toBeNull();
    expect(decodeBoard(raw({ v: 2, n: 'future' }))).toBeNull();
    expect(decodeBoard(raw([1, 2, 3]))).toBeNull();
    expect(decodeBoard('A'.repeat(5000))).toBeNull();
  });

  it('keeps only valid, unique ids and caps every list', () => {
    const decoded = decodeBoard(
      raw({
        v: 1,
        n: 'x',
        t: ['nfl-2', 'nfl-2', 'xfl-9', '<script>', 42, 'cfb-12'],
        g: ['nfl-1', 'nfl-1', 'bad', 'cfb-2', '../etc'],
        f: ['nfl-1', 'nfl-2', 'nfl-3', 'nfl-4', 'nfl-5'],
        l: 'hockey',
        d: ['FBS', 'D9'],
        y: 'grid',
        e: 'dense',
        extra: { evil: true },
      }),
    )!;
    expect(decoded.teams).toEqual(['nfl-2', 'cfb-12']);
    expect(decoded.games).toEqual(['nfl-1', 'cfb-2']);
    expect(decoded.focus).toHaveLength(4);
    expect(decoded).toMatchObject({ league: 'all', divisions: ['FBS'], layout: 'slate', density: 'comfortable' });
    expect(decoded).not.toHaveProperty('extra');
  });

  it('cleans names of control and direction-override characters', () => {
    expect(sanitizeBoardName('  Game‮ day ')).toBe('Game day');
    expect(sanitizeBoardName('​')).toBe('Shared board');
    expect(sanitizeBoardName(42)).toBe('Shared board');
    expect(Array.from(sanitizeBoardName('🏈'.repeat(80)))).toHaveLength(60);
  });

  it('resolves team boards against whichever day is selected', () => {
    const saturday = [
      game({ id: 'cfb-10', league: 'cfb', homeTeam: '333', awayTeam: '99', startTime: '2026-09-12T19:30:00Z' }),
      game({ id: 'cfb-11', league: 'cfb', homeTeam: '1', awayTeam: '2', startTime: '2026-09-12T16:00:00Z' }),
    ];
    const sunday = [
      game({ id: 'nfl-20', homeTeam: '5', awayTeam: '2', startTime: '2026-09-13T20:25:00Z' }),
      game({ id: 'nfl-401772834', homeTeam: '6', awayTeam: '7', startTime: '2026-09-13T17:00:00Z' }),
      game({ id: 'nfl-21', homeTeam: '2', awayTeam: '8', startTime: '2026-09-13T17:00:00Z' }),
    ];
    expect(resolveBoardGames(board, saturday).map((g) => g.id)).toEqual(['cfb-10']);
    expect(resolveBoardGames(board, sunday).map((g) => g.id)).toEqual(['nfl-401772834', 'nfl-21', 'nfl-20']);
  });
});
