/**
 * Team pages from captured ESPN team and schedule documents (fixtures/espn/team,
 * written by scripts/capture-team-fixtures.ts). Hand-made changes to a real
 * event are used only where the captured data has no example (a tie, a game in
 * progress, a postponement, a postseason game at the same moment, malformed
 * shapes), and each test says what it changes.
 */
import { describe, expect, it } from 'vitest';
import { parseGameId } from '../shared/model';
import { byeWeeksFrom, teamPageAsOf, type ScheduleGame, type TeamPage } from '../shared/team';
import { fetchTeamPage, normalizeTeamPage, normalizeTeamProfile, teamScheduleUrl, teamUrl } from '../server/providers/espn/team';
import { fixture } from './helpers/fixtures';

type Raw = Record<string, any>;

const FETCHED_AT = '2026-09-14T14:40:00.000Z';
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football';

const bills = fixture<Raw>('team/nfl-team-2.json');
const bills2026 = fixture<Raw>('team/nfl-team-2-schedule-2026.json');
const bills2025 = fixture<Raw>('team/nfl-team-2-schedule-2025.json');
const billsPreseason2026 = fixture<Raw>('team/nfl-team-2-schedule-2026-st1.json');
const billsPostseason2026 = fixture<Raw>('team/nfl-team-2-schedule-2026-st3.json');
const alabama = fixture<Raw>('team/cfb-team-333.json');
const alabama2026 = fixture<Raw>('team/cfb-team-333-schedule-2026.json');
const alabama2025 = fixture<Raw>('team/cfb-team-333-schedule-2025.json');
const alabamaPostseason2025 = fixture<Raw>('team/cfb-team-333-schedule-2025-st3.json');

const billsPage = () => normalizeTeamPage('nfl', bills, [bills2026], FETCHED_AT);
const alabamaPage = () => normalizeTeamPage('cfb', alabama, [alabama2026], FETCHED_AT);
const alabama2025Page = () => normalizeTeamPage('cfb', alabama, [alabama2025, alabamaPostseason2025], FETCHED_AT);

function game(page: TeamPage, providerId: string): ScheduleGame {
  const found = page.schedule.find((g) => g.providerId === providerId);
  if (!found) throw new Error(`event ${providerId} is not on the schedule`);
  return found;
}

const rawCompetitor = (schedule: Raw, eventId: string, teamId: string): Raw =>
  schedule.events.find((e: Raw) => e.id === eventId).competitions[0].competitors.find((c: Raw) => c.team.id === teamId);

/** A copy of a captured schedule with one event changed by hand. */
function withEvent(schedule: Raw, eventId: string, change: (event: Raw) => void): Raw {
  const copy = structuredClone(schedule);
  change(copy.events.find((e: Raw) => e.id === eventId));
  return copy;
}

describe('team profile', () => {
  it('normalizes Buffalo from its team document', () => {
    expect(bills.team.rank).toBeUndefined();
    expect(billsPage().team).toEqual({
      key: 'nfl-2',
      league: 'nfl',
      providerId: '2',
      abbreviation: 'BUF',
      displayName: 'Buffalo Bills',
      shortName: 'Bills',
      location: 'Buffalo',
      name: 'Bills',
      color: '#00338d',
      alternateColor: '#d50a0a',
      logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/buf.png',
      logoDark: 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/buf.png',
      rank: null,
      standingSummary: '1st in AFC East',
      record: { total: '1-0', home: '0-0', road: '1-0' },
      stats: { wins: 1, losses: 0, ties: 0, pointsFor: 36, pointsAgainst: 31, pointDifferential: 5, streak: 1 },
    });
  });

  it("reads Alabama's poll rank and a college record that has only a total", () => {
    const { team } = alabamaPage();
    expect(team).toMatchObject({ key: 'cfb-333', abbreviation: 'ALA', shortName: 'Alabama', name: 'Crimson Tide', rank: 10, standingSummary: '1st in SEC', color: '#9e1b32', alternateColor: '#ffffff' });
    expect(team.record).toEqual({ total: '2-0', home: null, road: null });
    expect(team.stats).toEqual({ wins: 2, losses: 0, ties: 0, pointsFor: 93, pointsAgainst: 27, pointDifferential: 66, streak: 2 });
  });

  it('leaves unreported or unusable values null', () => {
    const bare = normalizeTeamProfile('cfb', { team: { id: '333', rank: 99, color: 'crimson' } });
    expect(bare).toMatchObject({ location: null, name: null, color: null, alternateColor: null, logo: null, logoDark: null, rank: null, standingSummary: null });
    expect(bare.record).toEqual({ total: null, home: null, road: null });
    expect(Object.values(bare.stats).every((v) => v === null)).toBe(true);
  });

  it('keys teams by league, because ESPN team ids collide across leagues', () => {
    const auburn = alabamaPage().schedule.find((g) => g.opponent.abbreviation === 'AUB')!.opponent;
    expect(auburn.providerId).toBe('2');
    expect(auburn.key).toBe('cfb-2');
    expect(billsPage().team.key).toBe('nfl-2');
    expect(() => normalizeTeamPage('cfb', bills, [bills2026], FETCHED_AT)).toThrow('Team document s:20~l:28~t:2 is not a College Football team');
  });
});

describe('Buffalo 2026 schedule', () => {
  it('lists every regular season game in date order', () => {
    const page = billsPage();
    expect(page.season).toEqual({ year: 2026, type: 2, label: 'Regular Season' });
    expect(bills2026.events).toHaveLength(17);
    expect(page.schedule).toHaveLength(17);
    const times = page.schedule.map((g) => Date.parse(g.date));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(page.schedule.every((g) => g.seasonType === 2)).toBe(true);
    expect(page.fetchedAt).toBe(FETCHED_AT);
  });

  it("reads a completed game's score object and result", () => {
    // The provider sends the score as an object, not the string the scoreboard uses.
    expect(rawCompetitor(bills2026, '401872660', '2').score).toEqual({ value: 36, displayValue: '36' });
    expect(game(billsPage(), '401872660')).toEqual({
      gameId: 'nfl-401872660',
      providerId: '401872660',
      date: '2026-09-13T17:00:00.000Z',
      timeValid: true,
      week: { number: 1, text: 'Week 1' },
      seasonType: 2,
      homeAway: 'away',
      neutralSite: false,
      opponent: {
        key: 'nfl-34',
        providerId: '34',
        abbreviation: 'HOU',
        displayName: 'Houston Texans',
        shortName: 'Texans',
        logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/hou.png',
        rank: null,
      },
      venue: 'Reliant Stadium',
      status: { state: 'post', completed: true, detail: 'Final', shortDetail: 'Final' },
      score: { team: 36, opponent: 31 },
      result: 'W',
      broadcasts: ['CBS'],
      notes: [],
    });
  });

  it('gives a scheduled game no score and no result', () => {
    for (const teamId of ['2', '8']) {
      const competitor = rawCompetitor(bills2026, '401872932', teamId);
      expect(competitor).not.toHaveProperty('score');
      expect(competitor).not.toHaveProperty('winner');
    }
    expect(game(billsPage(), '401872932')).toMatchObject({
      homeAway: 'home',
      timeValid: true,
      opponent: { key: 'nfl-8', abbreviation: 'DET' },
      status: { state: 'pre', completed: false, shortDetail: '9/17 - 8:15 PM EDT' },
      score: null,
      result: null,
      broadcasts: ['Prime Video'],
    });
  });

  it('marks a game whose kickoff time is not set', () => {
    expect(game(billsPage(), '401873181')).toMatchObject({
      timeValid: false,
      date: '2027-01-10T05:00:00.000Z',
      week: { number: 18, text: 'Week 18' },
      status: { state: 'pre', completed: false, shortDetail: 'TBD' },
      notes: ['Flex Game: 1/9 or 1/10'],
      broadcasts: [],
    });
  });

  it('derives the bye week from gaps in the week numbers, not from the byeWeek field', () => {
    const page = billsPage();
    expect(bills2026.byeWeek).toBe(5);
    expect(page.schedule.map((g) => g.week.number)).toContain(5);
    expect(page.schedule.map((g) => g.week.number)).not.toContain(7);
    expect(page.byeWeeks).toEqual([7]);

    const season2025 = normalizeTeamPage('nfl', bills, [bills2025], FETCHED_AT);
    expect(bills2025.byeWeek).toBe(5);
    expect(season2025.season).toEqual({ year: 2025, type: 2, label: 'Regular Season' });
    expect(season2025.byeWeeks).toEqual([7]);
    // Buffalo finished the 2025 regular season 12-5.
    expect(season2025.schedule.filter((g) => g.result === 'W')).toHaveLength(12);
    expect(season2025.schedule.filter((g) => g.result === 'L')).toHaveLength(5);
  });
});

describe('Alabama', () => {
  it('shows ranked opponents and turns an unranked 99 into null', () => {
    const page = alabamaPage();
    expect(page.schedule).toHaveLength(12);
    expect(page.byeWeeks).toEqual([9]);
    const rankOf = (abbreviation: string) => page.schedule.find((g) => g.opponent.abbreviation === abbreviation)!.opponent.rank;
    expect(rankOf('UGA')).toBe(2);
    expect(rankOf('TENN')).toBe(15);
    expect(rankOf('TA&M')).toBe(9);
    expect(rankOf('LSU')).toBe(7);
    expect(rawCompetitor(alabama2026, '401856685', '52').curatedRank).toEqual({ current: 99 });
    expect(rankOf('FSU')).toBeNull();
    expect(page.schedule.filter((g) => !g.timeValid).map((g) => g.week.number)).toEqual([4, 5, 6, 7, 8, 10, 11, 13]);
  });

  it('merges the postseason, with neutral site games, and never counts postseason weeks as byes', () => {
    const page = alabama2025Page();
    expect(page.season).toEqual({ year: 2025, type: 2, label: 'Regular Season' });
    expect(page.schedule).toHaveLength(alabama2025.events.length + alabamaPostseason2025.events.length);
    expect(page.schedule.map((g) => g.seasonType)).toEqual([...Array<number>(13).fill(2), 3, 3]);
    expect(page.byeWeeks).toEqual([4, 10]);

    expect(game(page, '401777351')).toMatchObject({
      neutralSite: true,
      homeAway: 'home',
      week: { number: 15 },
      venue: 'Mercedes-Benz Stadium',
      notes: ['SEC Championship'],
      opponent: { abbreviation: 'UGA', rank: 3 },
      score: { team: 7, opponent: 28 },
      result: 'L',
    });
    const roseBowl = game(page, '401769072');
    expect(roseBowl).toMatchObject({
      neutralSite: true,
      homeAway: 'away',
      seasonType: 3,
      week: { number: 1, text: 'Bowls' },
      venue: 'Rose Bowl',
      opponent: { key: 'cfb-84', abbreviation: 'IU', rank: 1 },
      score: { team: 3, opponent: 38 },
      result: 'L',
    });
    expect(page.schedule[page.schedule.length - 1]).toBe(roseBowl);
  });

  it('describes a postseason document on its own as the postseason', () => {
    const page = normalizeTeamPage('cfb', alabama, [alabamaPostseason2025], FETCHED_AT);
    expect(page.season).toEqual({ year: 2025, type: 3, label: 'Postseason' });
    expect(page.schedule).toHaveLength(2);
    expect(page.byeWeeks).toEqual([]);
  });
});

describe('game ids', () => {
  it('match the app game id format, so /game/<id> links work', () => {
    const pages = [billsPage(), alabamaPage(), alabama2025Page(), normalizeTeamPage('nfl', bills, [bills2026, billsPreseason2026], FETCHED_AT)];
    for (const page of pages) {
      for (const g of page.schedule) {
        expect(parseGameId(g.gameId)).toEqual({ league: page.team.league, providerEventId: g.providerId });
      }
    }
  });
});

describe('merging schedules', () => {
  it('orders by date whatever order the documents come in', () => {
    const page = normalizeTeamPage('nfl', bills, [billsPostseason2026, billsPreseason2026, bills2026], FETCHED_AT);
    expect(page.schedule).toHaveLength(20);
    expect(page.schedule.slice(0, 3).map((g) => g.seasonType)).toEqual([1, 1, 1]);
    // Preseason week numbers are not their labels.
    expect(page.schedule[0].week).toEqual({ number: 2, text: 'Preseason Week 1' });
    expect(page.season).toEqual({ year: 2026, type: 2, label: 'Regular Season' });
    expect(page.byeWeeks).toEqual([7]);
  });

  it('lists the regular season game first when two games share a date', () => {
    // Hand-made: a postseason document holding a copy of week 1 with a new id, at the same moment.
    const week1 = structuredClone(bills2026.events.find((e: Raw) => e.id === '401872660'));
    const postseason = {
      requestedSeason: { year: 2026, type: 3, name: 'Postseason' },
      team: { id: '2' },
      events: [{ ...week1, id: '999000001', seasonType: { type: 3, name: 'Postseason' } }],
    };
    const page = normalizeTeamPage('nfl', bills, [postseason, bills2026], FETCHED_AT);
    expect(page.schedule.slice(0, 2).map((g) => g.providerId)).toEqual(['401872660', '999000001']);
    expect(page.season).toEqual({ year: 2026, type: 2, label: 'Regular Season' });
  });

  it('shows an event once when two documents both list it', () => {
    expect(normalizeTeamPage('nfl', bills, [bills2026, structuredClone(bills2026)], FETCHED_AT).schedule).toHaveLength(17);
  });

  it('refuses documents from different seasons', () => {
    expect(() => normalizeTeamPage('nfl', bills, [bills2026, bills2025], FETCHED_AT)).toThrow('Schedule documents cover different seasons (2026, 2025)');
  });

  it("uses the provider's current season only when no document names the season it covers", () => {
    expect(billsPostseason2026).not.toHaveProperty('requestedSeason');
    const page = normalizeTeamPage('nfl', bills, [billsPostseason2026], FETCHED_AT);
    expect(page.season).toEqual({ year: 2026, type: 2, label: 'Regular Season' });
    expect(page.schedule).toEqual([]);
    expect(page.byeWeeks).toEqual([]);
  });

  it('counts only regular season gaps between the first and last listed weeks as byes', () => {
    const g = (number: number | null, seasonType: ScheduleGame['seasonType']) => ({ week: { number, text: null }, seasonType }) as ScheduleGame;
    expect(byeWeeksFrom([g(1, 2), g(3, 2), g(6, 2), g(2, 3), g(4, 1), g(5, null)])).toEqual([2, 4, 5]);
    expect(byeWeeksFrom([g(5, 2)])).toEqual([]);
    expect(byeWeeksFrom([g(1, 2), g(null, 2), g(1_000_000, 2), g(3, 2)])).toEqual([2]);
  });
});

describe('results', () => {
  const week1 = (change: (event: Raw) => void) => game(normalizeTeamPage('nfl', bills, [withEvent(bills2026, '401872660', change)], FETCHED_AT), '401872660');

  it('reports a tie when both teams are flagged as not winning with equal scores', () => {
    // Hand-made: week 1 changed to a 20-20 tie.
    const tie = week1((e) => {
      for (const c of e.competitions[0].competitors) Object.assign(c, { score: { value: 20, displayValue: '20' }, winner: false });
    });
    expect(tie).toMatchObject({ score: { team: 20, opponent: 20 }, result: 'T' });
  });

  it('shows the score of a game in progress without a result', () => {
    // Hand-made: week 1 changed back to in progress.
    const live = week1((e) => {
      e.competitions[0].status.type = { state: 'in', completed: false };
      for (const c of e.competitions[0].competitors) delete c.winner;
    });
    expect(live).toMatchObject({ status: { state: 'in', completed: false }, score: { team: 36, opponent: 31 }, result: null });
  });

  it('gives a postponed game no score or result even when scores are present', () => {
    // Hand-made: week 1 changed to over but not completed, the state of a postponed or canceled game.
    const postponed = week1((e) => {
      e.competitions[0].status.type = { state: 'post', completed: false, shortDetail: 'Postponed' };
    });
    expect(postponed).toMatchObject({ status: { state: 'post', completed: false }, score: null, result: null });
  });

  it('also reads a score sent as a string, as the scoreboard does', () => {
    // Hand-made: week 1 scores written as strings and without winner flags.
    const strings = week1((e) => {
      for (const c of e.competitions[0].competitors) {
        c.score = String(c.score.value);
        delete c.winner;
      }
    });
    expect(strings).toMatchObject({ score: { team: 36, opponent: 31 }, result: 'W' });
  });
});

describe('teamPageAsOf', () => {
  it('hides results after the cutoff and recomputes nothing else', () => {
    const page = billsPage();
    const untouched = JSON.stringify(page);
    const replay = teamPageAsOf(page, '2026-09-13T16:59:00Z');
    const week1 = game(replay, '401872660');
    expect(week1).toMatchObject({ status: { state: 'pre', completed: false, detail: null, shortDetail: null }, score: null, result: null });
    expect(week1.opponent).toEqual(game(page, '401872660').opponent);
    expect(week1.date).toBe('2026-09-13T17:00:00.000Z');
    expect(game(replay, '401872932').status).toEqual({ state: 'pre', completed: false, detail: null, shortDetail: null });
    // The profile, bye weeks and season stay exactly as fetched.
    expect(replay.team).toEqual(page.team);
    expect(replay.byeWeeks).toEqual([7]);
    expect(replay.season).toEqual(page.season);
    expect(replay.fetchedAt).toBe(page.fetchedAt);
    expect(JSON.stringify(page)).toBe(untouched);
  });

  it('keeps results of games that kicked off by the cutoff', () => {
    expect(game(teamPageAsOf(billsPage(), '2026-09-13T17:00:00.000Z'), '401872660')).toMatchObject({ result: 'W', score: { team: 36, opponent: 31 } });
    const beforeBowls = teamPageAsOf(alabama2025Page(), '2025-12-10T00:00:00.000Z');
    expect(game(beforeBowls, '401777351').result).toBe('L');
    expect(game(beforeBowls, '401779840')).toMatchObject({ status: { state: 'pre' }, score: null, result: null });
    expect(beforeBowls.schedule.filter((g) => g.result !== null)).toHaveLength(13);
  });

  it('refuses a cutoff that is not a time', () => {
    expect(() => teamPageAsOf(billsPage(), 'kickoff')).toThrow('teamPageAsOf needs an ISO time');
  });
});

describe('fetchTeamPage', () => {
  function served(routes: Record<string, unknown>, log: string[] = []) {
    return async (url: string): Promise<unknown> => {
      log.push(url);
      if (!(url in routes)) throw new Error('HTTP 404');
      return structuredClone(routes[url]);
    };
  }
  const billsRoutes: Record<string, unknown> = {
    [`${BASE}/nfl/teams/2`]: bills,
    [`${BASE}/nfl/teams/2/schedule?season=2026&seasontype=2`]: bills2026,
    [`${BASE}/nfl/teams/2/schedule?season=2026&seasontype=3`]: billsPostseason2026,
    [`${BASE}/nfl/teams/2/schedule?season=2026&seasontype=1`]: billsPreseason2026,
  };
  const now = () => Date.parse(FETCHED_AT);

  it('builds team and schedule URLs', () => {
    expect(teamUrl('cfb', '333')).toBe(`${BASE}/college-football/teams/333`);
    expect(teamScheduleUrl('cfb', '333', 3, 2025)).toBe(`${BASE}/college-football/teams/333/schedule?season=2025&seasontype=3`);
    expect(teamScheduleUrl('nfl', '2', 2)).toBe(`${BASE}/nfl/teams/2/schedule?seasontype=2`);
  });

  it('requests the team, regular season and postseason documents and normalizes them', async () => {
    const log: string[] = [];
    const page = await fetchTeamPage(served(billsRoutes, log), 'nfl', '2', 2026, { now });
    expect([...log].sort()).toEqual(
      [`${BASE}/nfl/teams/2`, `${BASE}/nfl/teams/2/schedule?season=2026&seasontype=2`, `${BASE}/nfl/teams/2/schedule?season=2026&seasontype=3`].sort(),
    );
    expect(page).toEqual(normalizeTeamPage('nfl', bills, [bills2026, billsPostseason2026], FETCHED_AT));
  });

  it('adds the preseason when asked', async () => {
    const log: string[] = [];
    const page = await fetchTeamPage(served(billsRoutes, log), 'nfl', '2', 2026, { preseason: true, now });
    expect(log).toHaveLength(4);
    expect(log).toContain(`${BASE}/nfl/teams/2/schedule?season=2026&seasontype=1`);
    expect(page.schedule).toHaveLength(20);
  });

  it("asks for the provider's current season when no season is given", async () => {
    const log: string[] = [];
    const routes = {
      [`${BASE}/nfl/teams/2`]: bills,
      [`${BASE}/nfl/teams/2/schedule?seasontype=2`]: bills2026,
      [`${BASE}/nfl/teams/2/schedule?seasontype=3`]: billsPostseason2026,
    };
    const page = await fetchTeamPage(served(routes, log), 'nfl', '2', undefined, { now });
    expect([...log].sort()).toEqual(Object.keys(routes).sort());
    expect(page.season.year).toBe(2026);
  });

  it('accepts only digit team ids, a known league and a four digit season, before requesting anything', async () => {
    const log: string[] = [];
    for (const bad of ['', 'abc', '2/../../x', '2?season=1', ' 2', '12345678901']) {
      await expect(fetchTeamPage(served(billsRoutes, log), 'nfl', bad, 2026)).rejects.toThrow('Team id must be 1 to 10 digits');
    }
    await expect(fetchTeamPage(served(billsRoutes, log), 'mlb' as never, '2', 2026)).rejects.toThrow('Unknown league "mlb"');
    await expect(fetchTeamPage(served(billsRoutes, log), 'nfl', '2', 26)).rejects.toThrow('Season must be a four digit year');
    expect(log).toEqual([]);
  });

  it('fails the whole page, naming the document, when any request fails', async () => {
    const url = `${BASE}/nfl/teams/2/schedule?season=2026&seasontype=3`;
    const routes = { ...billsRoutes };
    delete routes[url];
    await expect(fetchTeamPage(served(routes), 'nfl', '2', 2026)).rejects.toThrow(`ESPN postseason schedule for nfl team 2 could not be loaded (${url}): HTTP 404`);
  });

  it('refuses an answer for a different season than the one requested', async () => {
    const routes = {
      [`${BASE}/nfl/teams/2`]: bills,
      [`${BASE}/nfl/teams/2/schedule?season=2025&seasontype=2`]: bills2026,
      [`${BASE}/nfl/teams/2/schedule?season=2025&seasontype=3`]: billsPostseason2026,
    };
    await expect(fetchTeamPage(served(routes), 'nfl', '2', 2025)).rejects.toThrow('ESPN answered with season 2026 when season 2025 was requested for nfl team 2');
  });
});

describe('malformed documents', () => {
  const page = (teamJson: unknown, schedules: unknown[], fetchedAt = FETCHED_AT) => () => normalizeTeamPage('nfl', teamJson, schedules, fetchedAt);
  const withWeek1 = (change: (event: Raw) => void) => page(bills, [withEvent(bills2026, '401872660', change)]);

  it('throw an error naming what is missing from the team document', () => {
    expect(page(null, [bills2026])).toThrow('Team document was not a JSON object');
    expect(page({}, [bills2026])).toThrow('Team document had no team object');
    expect(page({ team: { abbreviation: 'BUF' } }, [bills2026])).toThrow('Team document had no team.id');
  });

  it('throw an error naming the schedule document that is wrong', () => {
    expect(page(bills, [])).toThrow('A team page needs at least one schedule document');
    expect(page(bills, ['schedule'])).toThrow('Schedule document 1 was not a JSON object');
    expect(page(bills, [bills2026, { team: { id: '2' } }])).toThrow('Schedule document 2 had no events list');
    expect(page(bills, [{ ...structuredClone(bills2026), team: { id: '34' } }])).toThrow('Schedule document 1 is for team 34, not team 2');
    expect(page(bills, [bills2026], 'yesterday')).toThrow('fetchedAt must be an ISO time');
  });

  it('throw an error naming the event and what it lacks', () => {
    expect(withWeek1((e) => delete e.id)).toThrow('Schedule document 1, event 1 had no id');
    expect(withWeek1((e) => (e.id = '4018/72660'))).toThrow('Schedule event 4018/72660 has an id that cannot form a game id');
    expect(withWeek1((e) => delete e.competitions)).toThrow('Schedule event 401872660 had no competition');
    expect(withWeek1((e) => delete e.date)).toThrow('Schedule event 401872660 had no valid date');
    expect(withWeek1((e) => (e.date = 'Sunday afternoon'))).toThrow('Schedule event 401872660 had no valid date');
    // Week 1 lists Houston first and Buffalo second.
    expect(withWeek1((e) => e.competitions[0].competitors.pop())).toThrow('Schedule event 401872660 did not list team 2 as a competitor');
    expect(withWeek1((e) => e.competitions[0].competitors.shift())).toThrow('Schedule event 401872660 had no opponent');
    expect(withWeek1((e) => delete e.competitions[0].competitors[1].homeAway)).toThrow('Schedule event 401872660 did not say whether team 2 was home or away');
    expect(
      withWeek1((e) => {
        delete e.competitions[0].competitors[0].id;
        delete e.competitions[0].competitors[0].team.id;
      }),
    ).toThrow('Schedule event 401872660 had an opponent without a team id');
  });
});
