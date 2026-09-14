import { describe, expect, it } from 'vitest';
import type { ScheduleGame, TeamPage } from '../shared/team';
import { teamPageAtReplay, withSummary } from '../shared/team';
import { game } from './helpers/builders';

const HOUR = 3_600_000;

function scheduled(gameId: string, date: string, homeAway: 'home' | 'away', over: Partial<ScheduleGame> = {}): ScheduleGame {
  return {
    gameId,
    providerId: gameId.split('-')[1],
    date,
    timeValid: true,
    week: { number: 1, text: 'Week 1' },
    seasonType: 2,
    homeAway,
    neutralSite: false,
    opponent: { key: 'nfl-99', providerId: '99', abbreviation: 'OPP', displayName: 'Opponent Team', shortName: 'Opponent', logo: null, rank: null },
    venue: null,
    status: { state: 'post', completed: true, detail: 'Final', shortDetail: 'Final' },
    score: { team: 30, opponent: 20 },
    result: 'W',
    broadcasts: [],
    notes: [],
    ...over,
  };
}

function page(schedule: ScheduleGame[]): TeamPage {
  return {
    team: {
      key: 'nfl-2', league: 'nfl', providerId: '2', abbreviation: 'BUF', displayName: 'Buffalo Bills', shortName: 'Bills', location: 'Buffalo', name: 'Bills', color: '#00338d', alternateColor: null, logo: null, logoDark: null, rank: null, standingSummary: null,
      record: { total: '1-0', home: null, road: null },
      stats: { wins: 1, losses: 0, ties: 0, pointsFor: 30, pointsAgainst: 20, pointDifferential: 10, streak: 1 },
    },
    season: { year: 2026, type: 2, label: 'Regular Season' },
    schedule,
    byeWeeks: [],
    fetchedAt: '2026-09-14T12:00:00Z',
  };
}

describe('withSummary', () => {
  it('reads status and score from this team side of a summary', () => {
    const atHome = scheduled('nfl-1', '2026-09-13T17:00:00Z', 'home', { status: { state: 'pre', completed: false, detail: null, shortDetail: null }, score: null, result: null });
    expect(withSummary(atHome, game({ id: 'nfl-1', kind: 'final', home: 17, away: 24 }))).toMatchObject({ status: { state: 'post', completed: true }, score: { team: 17, opponent: 24 }, result: 'L' });
    const away = { ...atHome, homeAway: 'away' as const };
    expect(withSummary(away, game({ id: 'nfl-1', kind: 'in_progress', home: 17, away: 24 }))).toMatchObject({ status: { state: 'in', completed: false }, score: { team: 24, opponent: 17 }, result: null });
    expect(withSummary(away, game({ id: 'nfl-1', kind: 'scheduled' }))).toMatchObject({ status: { state: 'pre' }, score: null, result: null });
  });
});

describe('teamPageAtReplay', () => {
  const at = Date.parse('2026-09-13T19:00:00Z');
  const schedule = [
    scheduled('nfl-10', '2026-09-06T17:00:00Z', 'home'),
    scheduled('nfl-11', '2026-09-13T17:00:00Z', 'away'),
    scheduled('nfl-12', '2026-09-13T18:30:00Z', 'home'),
    scheduled('nfl-13', '2026-09-20T17:00:00Z', 'home'),
  ];

  it('shows the replay own state for games it holds and hides results nobody knew yet', () => {
    const replaying = game({ id: 'nfl-11', kind: 'in_progress', home: 14, away: 7 });
    const result = teamPageAtReplay(page(schedule), at, (id) => (id === 'nfl-11' ? replaying : null));
    const [earlier, held, recent, later] = result.schedule;
    // A week old: its final result was known at the replay moment.
    expect(earlier).toMatchObject({ result: 'W', score: { team: 30, opponent: 20 } });
    expect(held).toMatchObject({ status: { state: 'in' }, score: { team: 7, opponent: 14 }, result: null });
    expect(recent).toMatchObject({ status: { state: 'unknown', completed: false }, score: null, result: null });
    expect(later).toMatchObject({ status: { state: 'pre' }, score: null, result: null });
    expect(result.schedule).toHaveLength(4);
  });

  it('keeps a result once the replay has moved well past kickoff', () => {
    const result = teamPageAtReplay(page(schedule), Date.parse('2026-09-13T18:30:00Z') + 7 * HOUR, () => null);
    expect(result.schedule[2]).toMatchObject({ result: 'W' });
  });
});
