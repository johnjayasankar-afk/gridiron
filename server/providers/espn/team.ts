/**
 * ESPN team and team schedule documents → Gridiron's team page model.
 *
 * Conventions established from real responses captured on 14 September 2026
 * (team and schedule documents for Buffalo, Houston, Detroit, Kansas City and
 * Alabama; 2025 and 2026 seasons; preseason, regular season and postseason):
 *
 * - Team ids collide across leagues (NFL team 2 is Buffalo, college team 2 is
 *   Auburn), so every key carries the league. The team document's uid names
 *   its league ("s:20~l:28~t:2" is NFL, "l:23" is college) and is checked.
 * - A schedule document's `season` is the provider's current season whatever
 *   was requested. `requestedSeason` names the season its events belong to,
 *   and an empty document can leave it out.
 * - `byeWeek` is unreliable: Buffalo's 2025 and 2026 documents both say 5, yet
 *   both schedules skip week 7 (it did match for Houston, Detroit and Kansas
 *   City). Bye weeks are derived from gaps in the regular season week numbers.
 * - `timeValid` false means the kickoff time is not set; the date is then a
 *   placeholder at midnight US Eastern.
 * - A completed game's `score` is an object {value, displayValue}, next to a
 *   `winner` flag. Scheduled games have neither.
 * - `curatedRank.current` is 99 for an unranked team.
 * - Preseason week numbers differ from their labels ("Preseason Week 1" is
 *   week 2), and postseason weeks start again at 1.
 * - `nextEvent` on the team document can already be final, so it is not read.
 *
 * Unlike the scoreboard, a malformed document or event throws instead of being
 * skipped: a silently dropped game would show up as an invented bye week.
 */
import type { LeagueId } from '../../../shared/model.js';
import { LEAGUES, gameId as toGameId, parseGameId, teamKey } from '../../../shared/model.js';
import { byeWeeksFrom, type ScheduleGame, type SeasonType, type TeamPage, type TeamProfile, type TeamSeason } from '../../../shared/team.js';
import { SITE_BASE, espnLeaguePath, normalizeBroadcasts } from './normalize.js';
import { arr, at, bool, hexColor, num, obj, safeUrl, str } from './raw.js';

/** ESPN team ids are numeric; anything else is refused before a URL is built. */
export const TEAM_ID_PATTERN = /^\d{1,10}$/;

const SEASON_TYPE_NAME: Record<SeasonType, string> = { 1: 'preseason', 2: 'regular season', 3: 'postseason' };

/** The league number inside a team uid, as seen in real team documents. */
const UID_LEAGUE: Record<LeagueId, string> = { nfl: '28', cfb: '23' };

type Raw = Record<string, unknown>;
const nonNull = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

function assertLeague(league: unknown): asserts league is LeagueId {
  if (league !== 'nfl' && league !== 'cfb') throw new Error(`Unknown league ${JSON.stringify(league)}`);
}

function assertTeamId(teamId: unknown): asserts teamId is string {
  if (typeof teamId !== 'string' || !TEAM_ID_PATTERN.test(teamId)) {
    throw new Error(`Team id must be 1 to 10 digits, got ${JSON.stringify(teamId)}`);
  }
}

function assertSeason(season: unknown): asserts season is number {
  if (typeof season !== 'number' || !Number.isInteger(season) || season < 1000 || season > 9999) {
    throw new Error(`Season must be a four digit year, got ${JSON.stringify(season)}`);
  }
}

// ---------------------------------------------------------------- urls

export function teamUrl(league: LeagueId, teamId: string): string {
  assertLeague(league);
  assertTeamId(teamId);
  return `${SITE_BASE}/${espnLeaguePath(league)}/teams/${teamId}`;
}

/** Without a season, the provider answers for its current season. */
export function teamScheduleUrl(league: LeagueId, teamId: string, seasonType: SeasonType, season?: number): string {
  assertLeague(league);
  assertTeamId(teamId);
  if (seasonType !== 1 && seasonType !== 2 && seasonType !== 3) {
    throw new Error(`Season type must be 1, 2 or 3, got ${JSON.stringify(seasonType)}`);
  }
  const q = new URLSearchParams();
  if (season !== undefined) {
    assertSeason(season);
    q.set('season', String(season));
  }
  q.set('seasontype', String(seasonType));
  return `${SITE_BASE}/${espnLeaguePath(league)}/teams/${teamId}/schedule?${q.toString()}`;
}

// ---------------------------------------------------------------- shared readers

/** A place in the poll. The feed writes 99 for unranked, and only 1-25 is a rank. */
function pollRank(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= 25 ? n : null;
}

/** The scoreboard's logo rule: a "full" logo of the wanted variant that is not the scoreboard variant. */
function pickLogo(logos: unknown, want: 'default' | 'dark'): string | null {
  const hit = arr(logos)
    .map(obj)
    .find((l) => {
      const rel = arr(l?.rel).map((r) => str(r));
      return rel.includes('full') && rel.includes(want) && !rel.includes('scoreboard');
    });
  return hit ? safeUrl(hit.href) : null;
}

// ---------------------------------------------------------------- team profile

export function normalizeTeamProfile(league: LeagueId, teamJson: unknown): TeamProfile {
  assertLeague(league);
  const root = obj(teamJson);
  if (!root) throw new Error('Team document was not a JSON object');
  const t = obj(root.team);
  if (!t) throw new Error('Team document had no team object');
  const providerId = str(t.id);
  if (!providerId) throw new Error('Team document had no team.id');
  const uid = str(t.uid);
  const uidLeague = uid?.split('~').find((part) => part.startsWith('l:'))?.slice(2) ?? null;
  if (uidLeague !== null && uidLeague !== UID_LEAGUE[league]) {
    throw new Error(`Team document ${uid} is not a ${LEAGUES[league].name} team`);
  }

  const items = arr(at(t, 'record', 'items')).map(obj).filter(nonNull);
  const recordItem = (type: string) => items.find((i) => str(i.type) === type) ?? null;
  const total = recordItem('total');
  const stat = (name: string) => num(arr(total?.stats).map(obj).find((s) => str(s?.name) === name)?.value);
  const abbreviation = str(t.abbreviation) ?? providerId;
  return {
    key: teamKey(league, providerId),
    league,
    providerId,
    abbreviation,
    displayName: str(t.displayName) ?? str(t.name) ?? abbreviation,
    shortName: str(t.shortDisplayName) ?? str(t.name) ?? abbreviation,
    location: str(t.location),
    name: str(t.name),
    color: hexColor(t.color),
    alternateColor: hexColor(t.alternateColor),
    logo: safeUrl(t.logo) ?? pickLogo(t.logos, 'default'),
    logoDark: pickLogo(t.logos, 'dark'),
    rank: pollRank(t.rank),
    standingSummary: str(t.standingSummary),
    record: {
      total: str(total?.summary),
      home: str(recordItem('home')?.summary),
      road: str(recordItem('road')?.summary),
    },
    stats: {
      wins: stat('wins'),
      losses: stat('losses'),
      ties: stat('ties'),
      pointsFor: stat('pointsFor'),
      pointsAgainst: stat('pointsAgainst'),
      pointDifferential: stat('pointDifferential'),
      streak: stat('streak'),
    },
  };
}

// ---------------------------------------------------------------- schedule documents

interface ScheduleDocument {
  events: unknown[];
  /** The season the events belong to, when the document says so. */
  season: TeamSeason | null;
  /** The provider's current season, which is not necessarily the one requested. */
  currentSeason: TeamSeason | null;
  label: string;
}

function seasonOf(raw: unknown): TeamSeason | null {
  const s = obj(raw);
  const year = num(s?.year);
  const type = num(s?.type);
  if (!s || year === null || type === null || !Number.isInteger(year) || !Number.isInteger(type)) return null;
  return { year, type, label: str(s.name) ?? str(s.displayName) ?? String(year) };
}

function parseScheduleDocument(json: unknown, index: number, teamId: string): ScheduleDocument {
  const label = `Schedule document ${index + 1}`;
  const root = obj(json);
  if (!root) throw new Error(`${label} was not a JSON object`);
  if (!Array.isArray(root.events)) throw new Error(`${label} had no events list`);
  const docTeam = str(at(root, 'team', 'id'));
  if (docTeam !== null && docTeam !== teamId) throw new Error(`${label} is for team ${docTeam}, not team ${teamId}`);
  const first = obj(root.events[0]);
  const fromEvents = first
    ? seasonOf({ year: at(first, 'season', 'year'), type: at(first, 'seasonType', 'type'), name: at(first, 'seasonType', 'name') })
    : null;
  return { events: root.events, season: seasonOf(root.requestedSeason) ?? fromEvents, currentSeason: seasonOf(root.season), label };
}

/** The requested season: the regular season document's, and every document must agree on the year. */
function pageSeason(docs: ScheduleDocument[]): TeamSeason {
  const stated = docs.map((d) => d.season).filter(nonNull);
  if (stated.length === 0) {
    // No document said which season it covers (they were all empty), so the provider's current season is the only one reported.
    const current = docs.map((d) => d.currentSeason).find(nonNull);
    if (!current) throw new Error('Schedule documents did not say which season they cover');
    return current;
  }
  const years = [...new Set(stated.map((s) => s.year))];
  if (years.length > 1) throw new Error(`Schedule documents cover different seasons (${years.join(', ')})`);
  return stated.find((s) => s.type === 2) ?? stated[0];
}

// ---------------------------------------------------------------- schedule games

const competitorTeamId = (c: Raw | null): string | null => str(at(c, 'team', 'id')) ?? str(c?.id);

/** Schedule documents send the score as an object {value, displayValue}; scoreboards send a string. */
const scoreOf = (c: Raw): number | null => num(c.score) ?? num(at(c, 'score', 'value'));

function resultOf(completed: boolean, us: Raw, them: Raw, score: ScheduleGame['score']): ScheduleGame['result'] {
  if (!completed) return null;
  const usWon = bool(us.winner);
  const themWon = bool(them.winner);
  if (usWon === true && themWon !== true) return 'W';
  if (themWon === true && usWon !== true) return 'L';
  // Both flagged as winners, or no score to go on.
  if (usWon === true || score === null) return null;
  if (score.team === score.opponent) return 'T';
  // Neither flag reported: the final score decides. Two "not the winner" flags with unequal scores contradict each other.
  if (usWon === null && themWon === null) return score.team > score.opponent ? 'W' : 'L';
  return null;
}

function normalizeScheduleEvent(league: LeagueId, raw: unknown, teamId: string, position: string): ScheduleGame {
  const e = obj(raw);
  if (!e) throw new Error(`${position} was not a JSON object`);
  const providerId = str(e.id);
  if (!providerId) throw new Error(`${position} had no id`);
  const label = `Schedule event ${providerId}`;
  const id = toGameId(league, providerId);
  if (!parseGameId(id)) throw new Error(`${label} has an id that cannot form a game id`);
  const comp = obj(at(e, 'competitions', 0));
  if (!comp) throw new Error(`${label} had no competition`);
  const kickoff = Date.parse(str(e.date) ?? str(comp.date) ?? '');
  if (!Number.isFinite(kickoff)) throw new Error(`${label} had no valid date`);
  const competitors = arr(comp.competitors).map(obj).filter(nonNull);
  const us = competitors.find((c) => competitorTeamId(c) === teamId);
  if (!us) throw new Error(`${label} did not list team ${teamId} as a competitor`);
  const them = competitors.find((c) => c !== us);
  if (!them) throw new Error(`${label} had no opponent`);
  const homeAway = str(us.homeAway);
  if (homeAway !== 'home' && homeAway !== 'away') throw new Error(`${label} did not say whether team ${teamId} was home or away`);
  const opponentId = competitorTeamId(them);
  if (!opponentId) throw new Error(`${label} had an opponent without a team id`);
  const opponentTeam = obj(them.team);
  const opponentAbbreviation = str(opponentTeam?.abbreviation) ?? opponentId;

  const statusType = obj(at(comp, 'status', 'type')) ?? obj(at(e, 'status', 'type'));
  const reportedState = str(statusType?.state);
  const state = reportedState === 'pre' || reportedState === 'in' || reportedState === 'post' ? reportedState : 'unknown';
  const completed = bool(statusType?.completed) === true;
  const usScore = scoreOf(us);
  const themScore = scoreOf(them);
  // A score counts once play has started; postponed and canceled games are "post" without being completed.
  const score = (completed || state === 'in') && usScore !== null && themScore !== null ? { team: usScore, opponent: themScore } : null;
  const weekNumber = num(at(e, 'week', 'number'));
  const seasonType = num(at(e, 'seasonType', 'type'));

  return {
    gameId: id,
    providerId,
    date: new Date(kickoff).toISOString(),
    timeValid: (bool(e.timeValid) ?? bool(comp.timeValid)) === true,
    week: { number: weekNumber !== null && Number.isInteger(weekNumber) ? weekNumber : null, text: str(at(e, 'week', 'text')) },
    seasonType: seasonType === 1 || seasonType === 2 || seasonType === 3 ? seasonType : null,
    homeAway,
    neutralSite: bool(comp.neutralSite) === true,
    opponent: {
      key: teamKey(league, opponentId),
      providerId: opponentId,
      abbreviation: opponentAbbreviation,
      displayName: str(opponentTeam?.displayName) ?? str(opponentTeam?.name) ?? opponentAbbreviation,
      shortName: str(opponentTeam?.shortDisplayName) ?? str(opponentTeam?.name) ?? opponentAbbreviation,
      logo: safeUrl(opponentTeam?.logo) ?? pickLogo(opponentTeam?.logos, 'default'),
      rank: pollRank(at(them, 'curatedRank', 'current')),
    },
    venue: str(at(comp, 'venue', 'fullName')),
    status: { state, completed, detail: str(statusType?.detail), shortDetail: str(statusType?.shortDetail) },
    score,
    result: resultOf(completed, us, them, score),
    broadcasts: normalizeBroadcasts(comp).map((b) => b.name),
    notes: arr(comp.notes)
      .map((n) => str(obj(n)?.headline))
      .filter(nonNull),
  };
}

/** Order for games at the same moment: regular season, then preseason, then postseason, then unknown. */
const tieOrder = (type: SeasonType | null) => (type === 2 ? 0 : (type ?? 9));

// ---------------------------------------------------------------- team page

/**
 * One team document plus one or more schedule documents (for example the
 * regular season and the postseason of one season) → a team page. Pure: the
 * same input always gives the same page.
 */
export function normalizeTeamPage(league: LeagueId, teamJson: unknown, scheduleJsons: unknown[], fetchedAt: string): TeamPage {
  assertLeague(league);
  if (typeof fetchedAt !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) {
    throw new Error(`fetchedAt must be an ISO time, got ${JSON.stringify(fetchedAt)}`);
  }
  const team = normalizeTeamProfile(league, teamJson);
  if (!Array.isArray(scheduleJsons) || scheduleJsons.length === 0) throw new Error('A team page needs at least one schedule document');
  const docs = scheduleJsons.map((json, i) => parseScheduleDocument(json, i, team.providerId));
  const season = pageSeason(docs);

  const ordered = docs
    .flatMap((doc) => doc.events.map((event, i) => normalizeScheduleEvent(league, event, team.providerId, `${doc.label}, event ${i + 1}`)))
    .map((game, order) => ({ game, order, time: Date.parse(game.date) }))
    .sort((a, b) => a.time - b.time || tieOrder(a.game.seasonType) - tieOrder(b.game.seasonType) || a.order - b.order);
  const schedule: ScheduleGame[] = [];
  const seen = new Set<string>();
  for (const { game } of ordered) {
    // An event listed by two documents appears once.
    if (seen.has(game.gameId)) continue;
    seen.add(game.gameId);
    schedule.push(game);
  }
  return { team, season, schedule, byeWeeks: byeWeeksFrom(schedule), fetchedAt };
}

export interface FetchTeamPageOptions {
  /** Also request the preseason schedule. Off by default. */
  preseason?: boolean;
  /** Clock for fetchedAt. */
  now?: () => number;
}

/**
 * Requests the team document and the regular season and postseason schedules
 * (plus the preseason when asked) in parallel, then normalizes them. `getJson`
 * resolves to the parsed body or rejects. Any failed request fails the whole
 * page, because a schedule missing one of its parts would still look complete.
 */
export async function fetchTeamPage(
  getJson: (url: string) => Promise<unknown>,
  league: LeagueId,
  teamId: string,
  season?: number,
  options: FetchTeamPageOptions = {},
): Promise<TeamPage> {
  assertLeague(league);
  assertTeamId(teamId);
  if (season !== undefined) assertSeason(season);
  const now = options.now ?? Date.now;
  const types: SeasonType[] = options.preseason ? [2, 3, 1] : [2, 3];
  const request = async (url: string, what: string): Promise<unknown> => {
    try {
      return await getJson(url);
    } catch (e) {
      throw new Error(`ESPN ${what} for ${league} team ${teamId} could not be loaded (${url}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const [teamJson, ...schedules] = await Promise.all([
    request(teamUrl(league, teamId), 'team document'),
    ...types.map((type) => request(teamScheduleUrl(league, teamId, type, season), `${SEASON_TYPE_NAME[type]} schedule`)),
  ]);
  const page = normalizeTeamPage(league, teamJson, schedules, new Date(now()).toISOString());
  if (season !== undefined && page.season.year !== season) {
    throw new Error(`ESPN answered with season ${page.season.year} when season ${season} was requested for ${league} team ${teamId}`);
  }
  return page;
}
