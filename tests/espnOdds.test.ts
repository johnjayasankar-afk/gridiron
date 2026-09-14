import { describe, expect, it } from 'vitest';
import { newDiagnostics, normalizeScoreboardEvent, normalizeSummary } from '../server/providers/espn/normalize';
import { lastPlayWinProbability, normalizeLines, normalizePredictor, normalizeWinProbability } from '../server/providers/espn/odds';
import { fixture } from './helpers/fixtures';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('ESPN lines, win probability and matchup predictor', () => {
  it("reads a scheduled game's sportsbook lines and matchup predictor, as captured before kickoff", () => {
    const game = normalizeScoreboardEvent(fixture<Raw>('odds/nfl-401872931-pregame-event.json'), 'nfl', ['NFL'])!;
    expect(game.status.kind).toBe('scheduled');
    expect(game.lines).toMatchObject({ provider: 'DraftKings', details: 'KC -2.5', favorite: 'home' });
    expect(game.lines?.spread?.home.latest).toEqual({ line: -2.5, odds: -108 });
    expect(game.lines?.spread?.away.latest).toEqual({ line: 2.5, odds: -112 });
    expect(game.lines?.moneyline?.home).toEqual({ open: -155, latest: -130 });
    expect(game.lines?.moneyline?.away).toEqual({ open: 130, latest: 110 });
    expect(game.lines?.total?.over).toEqual({ open: { line: 42.5, odds: -110 }, latest: { line: 43.5, odds: -108 } });
    expect(game.winProbability).toBeUndefined();

    const detail = normalizeSummary(fixture<Raw>('odds/nfl-401872931-pregame-summary.json'), 'nfl', ['NFL'], newDiagnostics())!;
    expect(detail.summary.predictor?.source).toBe('ESPN');
    expect(detail.summary.predictor?.home).toBeCloseTo(0.596, 9);
    expect(detail.summary.predictor?.away).toBeCloseTo(0.401, 9);
    expect(detail.summary.winProbability).toBeUndefined();
    expect(detail.winProbability).toBeUndefined();
    // Before kickoff ESPN's summary reports play-by-play as "none"; that is not score-only coverage.
    expect(detail.summary.status.kind).toBe('scheduled');
    expect(detail.summary.coverage.level).not.toBe('score-only');
  });

  it('reads the closing lines and the win probability after every play of a finished game', () => {
    const detail = normalizeSummary(fixture<Raw>('summary/nfl-401872926.json'), 'nfl', ['NFL'], newDiagnostics())!;
    expect(detail.summary.lines).toMatchObject({ provider: 'DraftKings', details: 'LAC -8.5', favorite: 'home' });
    expect(detail.summary.lines?.moneyline?.home).toEqual({ open: -625, latest: -485 });
    const series = detail.winProbability ?? [];
    expect(series.length).toBe(185);
    const playIds = new Set(detail.plays.map((p) => p.id));
    expect(series.filter((p) => playIds.has(p.playId)).length).toBeGreaterThan(180);
    for (const p of series) {
      expect(p.home).toBeGreaterThanOrEqual(0);
      expect(p.home).toBeLessThanOrEqual(1);
    }
    const last = series[series.length - 1];
    expect(detail.summary.winProbability).toEqual({ home: last.home, tie: last.tie, playId: last.playId, source: 'ESPN' });
  });

  it('treats a sportsbook with no moneyline as off, and keeps its spread and total', () => {
    const detail = normalizeSummary(fixture<Raw>('summary/cfb-401856673.json'), 'cfb', ['FBS'], newDiagnostics())!;
    expect(detail.summary.lines?.moneyline).toBeNull();
    expect(detail.summary.lines?.spread?.home.latest?.line).toBe(-40.5);
    expect(detail.summary.lines?.total?.over.latest?.line).toBe(55.5);
  });

  it('leaves games without reported lines or win probability exactly as they were', () => {
    const detail = normalizeSummary(fixture<Raw>('summary/cfb-401906153.json'), 'cfb', ['D2'], newDiagnostics())!;
    expect('lines' in detail.summary).toBe(false);
    expect('winProbability' in detail.summary).toBe(false);
    expect('winProbability' in detail).toBe(false);
  });

  it('refuses lines for other teams, and win probability outside 0 to 1, rather than guessing', () => {
    const entry = { provider: { name: 'Book', priority: 1 }, homeTeamOdds: { teamId: '99' }, awayTeamOdds: { teamId: '98' }, moneyline: { home: { close: { odds: '-120' } }, away: { close: { odds: '+100' } } } };
    expect(normalizeLines([entry], '12', '7')).toBeNull();
    const swapped = { ...entry, homeTeamOdds: { teamId: '7' }, awayTeamOdds: { teamId: '12' } };
    expect(normalizeLines([swapped], '12', '7')?.moneyline).toEqual({ home: { open: null, latest: 100 }, away: { open: null, latest: -120 } });
    expect(normalizeLines([{ provider: { name: 'Book' } }], '12', '7')).toBeNull();

    expect(normalizeWinProbability([{ homeWinPercentage: 1.4, playId: '1' }, { homeWinPercentage: 0.6, playId: '2' }, { homeWinPercentage: 0.5 }], 'nfl-1')).toEqual([{ playId: 'nfl-1:2', home: 0.6, tie: 0 }]);
    expect(lastPlayWinProbability({ id: '77', probability: { homeWinPercentage: 0.31, tiePercentage: 0.01 } }, 'nfl-1')).toEqual({ home: 0.31, tie: 0.01, playId: 'nfl-1:77', source: 'ESPN' });
    expect(lastPlayWinProbability({ id: '77' }, 'nfl-1')).toBeNull();
    expect(normalizePredictor({ homeTeam: { id: '12', gameProjection: '59.6' }, awayTeam: { id: '99', gameProjection: '40.1' } }, '12', '7')).toBeNull();
  });
});
