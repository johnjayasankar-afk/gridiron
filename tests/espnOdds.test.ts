import { describe, expect, it } from 'vitest';
import { newDiagnostics, normalizeScoreboardEvent, normalizeSummary } from '../server/providers/espn/normalize';
import { lastPlayWinProbability, normalizeCoreOdds, normalizeLines, normalizePredictor, normalizeWinProbability } from '../server/providers/espn/odds';
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

/**
 * The core API's odds document is the only place the line a book is offering
 * during a game appears. The scoreboard and the summary carry an opening line
 * and a closing one, and while a game runs there is no closing line yet.
 */
describe("the sportsbook's live line, from ESPN's core API", () => {
  const pregame = () => fixture<Raw>('odds/nfl-401872948-core-odds-pregame.json');
  const final = () => fixture<Raw>('odds/nfl-401872926-core-odds-final.json');

  it('reads the line the book is offering now, alongside the one it opened at', () => {
    const lines = normalizeCoreOdds(pregame(), '9', '1')!;
    expect(lines.provider).toBe('DraftKings');
    expect(lines.details).toBe('GB -4.5');
    expect(lines.favorite).toBe('home');
    // A spread is a line and the price on it is a price; both arrive as "american" strings.
    expect(lines.spread!.home).toEqual({ open: { line: -7.5, odds: -110 }, latest: { line: -4.5, odds: -115 } });
    expect(lines.spread!.away).toEqual({ open: { line: 7.5, odds: -110 }, latest: { line: 4.5, odds: -105 } });
    expect(lines.moneyline!.home).toEqual({ open: -360, latest: -245 });
    expect(lines.total!.over).toEqual({ open: { line: 46.5, odds: -110 }, latest: { line: 42.5, odds: -118 } });
    expect(lines.total!.under.latest).toEqual({ line: 42.5, odds: -102 });
  });

  it('falls back to the close once a game is over, which is where the live line stopped', () => {
    const lines = normalizeCoreOdds(final(), '24', '22')!;
    expect(lines.spread!.home).toEqual({ open: { line: -11.5, odds: -110 }, latest: { line: -8.5, odds: -120 } });
    expect(lines.moneyline!.away).toEqual({ open: 470, latest: 370 });
    expect(lines.total!.over.latest).toEqual({ line: 47.5, odds: -102 });
  });

  it('reads a document whose teams are the other way round, and refuses one for another game', () => {
    const swapped = normalizeCoreOdds(pregame(), '1', '9')!;
    expect(swapped.spread!.home.latest).toEqual({ line: 4.5, odds: -105 });
    expect(swapped.spread!.away.latest).toEqual({ line: -4.5, odds: -115 });
    expect(swapped.favorite).toBe('away');
    expect(normalizeCoreOdds(pregame(), '77', '78')).toBeNull();
  });

  it('has nothing to say about an empty or malformed document rather than inventing a line', () => {
    expect(normalizeCoreOdds({ items: [] }, '9', '1')).toBeNull();
    expect(normalizeCoreOdds({ items: [{ provider: { name: 'Book', priority: 1 } }] }, '9', '1')).toBeNull();
    expect(normalizeCoreOdds(null, '9', '1')).toBeNull();
  });
});
