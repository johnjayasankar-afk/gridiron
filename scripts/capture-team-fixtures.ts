/**
 * Captures ESPN team and team schedule documents into fixtures/espn/team,
 * trimmed to the fields the team page normalizer reads
 * (server/providers/espn/team.ts). Used by tests/team.test.ts.
 *
 *   npx tsx scripts/capture-team-fixtures.ts
 *
 * The captured files are ESPN's data, kept small and used only for testing.
 * Before anything is written, every schedule is normalized with its team
 * document both untrimmed and trimmed, and the two pages must be identical.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LeagueId } from '../shared/model';
import type { SeasonType } from '../shared/team';
import { arr, obj, str } from '../server/providers/espn/raw';
import { normalizeTeamPage, teamScheduleUrl, teamUrl } from '../server/providers/espn/team';

export const TEAM_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'espn', 'team');

type Json = unknown;

export interface TeamCapture {
  file: string;
  league: LeagueId;
  teamId: string;
  /** Absent for the team document itself. */
  schedule?: { season: number; seasonType: SeasonType };
  note: string;
}

export const TEAM_CAPTURES: TeamCapture[] = [
  // The four core documents.
  { file: 'nfl-team-2.json', league: 'nfl', teamId: '2', note: 'Buffalo Bills team document' },
  { file: 'nfl-team-2-schedule-2026.json', league: 'nfl', teamId: '2', schedule: { season: 2026, seasonType: 2 }, note: 'Buffalo 2026 regular season' },
  { file: 'cfb-team-333.json', league: 'cfb', teamId: '333', note: 'Alabama Crimson Tide team document' },
  { file: 'cfb-team-333-schedule-2026.json', league: 'cfb', teamId: '333', schedule: { season: 2026, seasonType: 2 }, note: 'Alabama 2026 regular season' },
  // Bye week, postseason, neutral site and preseason cases.
  { file: 'nfl-team-2-schedule-2025.json', league: 'nfl', teamId: '2', schedule: { season: 2025, seasonType: 2 }, note: 'Buffalo 2025 regular season, for bye weeks' },
  { file: 'cfb-team-333-schedule-2025.json', league: 'cfb', teamId: '333', schedule: { season: 2025, seasonType: 2 }, note: 'Alabama 2025 regular season, to merge with its postseason' },
  { file: 'cfb-team-333-schedule-2025-st3.json', league: 'cfb', teamId: '333', schedule: { season: 2025, seasonType: 3 }, note: 'Alabama 2025 postseason' },
  { file: 'nfl-team-2-schedule-2026-st1.json', league: 'nfl', teamId: '2', schedule: { season: 2026, seasonType: 1 }, note: 'Buffalo 2026 preseason' },
  { file: 'nfl-team-2-schedule-2026-st3.json', league: 'nfl', teamId: '2', schedule: { season: 2026, seasonType: 3 }, note: 'Buffalo 2026 postseason, before it has any games' },
];

const pick = (v: Json, keys: string[]): Record<string, Json> | undefined => {
  const src = obj(v);
  if (!src) return undefined;
  const out: Record<string, Json> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

/** Only the "full" default and dark logos; every other variant is dropped. */
const keepLogos = (logos: Json) =>
  arr(logos)
    .filter((l) => {
      const rel = arr(obj(l)?.rel);
      return rel.includes('full') && (rel.includes('default') || rel.includes('dark')) && !rel.includes('scoreboard');
    })
    .map((l) => pick(l, ['href', 'rel']));

const TEAM_KEYS = ['id', 'uid', 'abbreviation', 'displayName', 'shortDisplayName', 'name', 'location', 'color', 'alternateColor', 'logo', 'standingSummary', 'rank'];
const STAT_NAMES = ['wins', 'losses', 'ties', 'pointsFor', 'pointsAgainst', 'pointDifferential', 'streak'];

/** Team document: identity, colors, two logos, rank, standing and record. Links, franchise and nextEvent are dropped. */
export function trimTeamDocument(doc: Json): Json {
  const team = obj(obj(doc)?.team);
  if (!team) throw new Error('Team document had no team object');
  const out = pick(team, TEAM_KEYS) ?? {};
  out.logos = keepLogos(team.logos);
  out.record = {
    items: arr(obj(team.record)?.items).map((item) => ({
      ...pick(item, ['type', 'summary']),
      stats: arr(obj(item)?.stats)
        .filter((s) => STAT_NAMES.includes(String(obj(s)?.name)))
        .map((s) => pick(s, ['name', 'value'])),
    })),
  };
  return { team: out };
}

const trimCompetitor = (c: Json) => {
  const out = pick(c, ['id', 'homeAway', 'winner']) ?? {};
  const team = obj(obj(c)?.team);
  out.team = { ...pick(team, ['id', 'abbreviation', 'displayName', 'shortDisplayName', 'name', 'logo']), logos: keepLogos(team?.logos) };
  const score = obj(c)?.score;
  if (score !== undefined) out.score = obj(score) ? pick(score, ['value', 'displayValue']) : score;
  const rank = pick(obj(c)?.curatedRank, ['current']);
  if (rank) out.curatedRank = rank;
  return out;
};

const trimEvent = (e: Json) => {
  const out = pick(e, ['id', 'date', 'timeValid']) ?? {};
  out.season = pick(obj(e)?.season, ['year']);
  out.seasonType = pick(obj(e)?.seasonType, ['type', 'name']);
  out.week = pick(obj(e)?.week, ['number', 'text']);
  const c = obj(arr(obj(e)?.competitions)[0]);
  if (c) {
    const comp = pick(c, ['neutralSite']) ?? {};
    comp.venue = pick(c.venue, ['fullName']);
    comp.notes = arr(c.notes).map((n) => pick(n, ['headline']));
    comp.broadcasts = arr(c.broadcasts).map((b) => ({ type: pick(obj(b)?.type, ['shortName']), media: pick(obj(b)?.media, ['shortName']) }));
    comp.status = { type: pick(obj(c.status)?.type, ['state', 'completed', 'detail', 'shortDetail']) };
    comp.competitors = arr(c.competitors).map(trimCompetitor);
    out.competitions = [comp];
  }
  return out;
};

/**
 * Schedule document: seasons, team id and the events. Links, tickets, leaders,
 * attendance and competitor records are dropped. `byeWeek` is not read by the
 * normalizer; it is kept so the tests can show that its value is ignored.
 */
export function trimTeamSchedule(doc: Json): Json {
  const root = obj(doc);
  if (!root || !Array.isArray(root.events)) throw new Error('Schedule document had no events list');
  return {
    season: pick(root.season, ['year', 'type', 'name', 'displayName']),
    requestedSeason: pick(root.requestedSeason, ['year', 'type', 'name', 'displayName']),
    byeWeek: root.byeWeek,
    team: pick(root.team, ['id']),
    events: root.events.map(trimEvent),
  };
}

export const captureUrl = (c: TeamCapture): string =>
  c.schedule ? teamScheduleUrl(c.league, c.teamId, c.schedule.seasonType, c.schedule.season) : teamUrl(c.league, c.teamId);

export const trimCapture = (c: TeamCapture, raw: Json): Json => (c.schedule ? trimTeamSchedule(raw) : trimTeamDocument(raw));

export interface CapturedDocument {
  capture: TeamCapture;
  raw: Json;
}

/** Every schedule, normalized with its team document, must give the same page before and after trimming. Returns how many were checked. */
export function assertTrimsKeepTeamPages(captured: CapturedDocument[]): number {
  const fetchedAt = '2026-09-14T00:00:00.000Z';
  let checked = 0;
  for (const { capture, raw } of captured) {
    if (!capture.schedule) continue;
    const team = captured.find((d) => !d.capture.schedule && d.capture.league === capture.league && d.capture.teamId === capture.teamId);
    if (!team) throw new Error(`No team document captured for ${capture.file}`);
    const before = JSON.stringify(normalizeTeamPage(capture.league, team.raw, [raw], fetchedAt));
    const after = JSON.stringify(normalizeTeamPage(capture.league, trimTeamDocument(team.raw), [trimTeamSchedule(raw)], fetchedAt));
    if (before !== after) throw new Error(`Trimming ${capture.file} changed the normalized team page`);
    checked++;
  }
  return checked;
}

/** Writes the trimmed documents and a manifest recording where each came from. Returns the file names written. */
export function writeTeamFixtures(captured: CapturedDocument[], meta: { capturedAt: string | null; source: string }, dir = TEAM_FIXTURES): string[] {
  mkdirSync(dir, { recursive: true });
  const files = captured.map(({ capture, raw }) => {
    writeFileSync(join(dir, capture.file), JSON.stringify(trimCapture(capture, raw)));
    return { file: capture.file, url: captureUrl(capture), note: capture.note, providerTimestamp: str(obj(raw)?.timestamp) };
  });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ provider: 'ESPN site API (undocumented)', capturedAt: meta.capturedAt, source: meta.source, files }, null, 2),
  );
  return files.map((f) => f.file);
}

async function getJson(url: string): Promise<Json> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main() {
  const captured: CapturedDocument[] = [];
  for (const capture of TEAM_CAPTURES) captured.push({ capture, raw: await getJson(captureUrl(capture)) });
  const checked = assertTrimsKeepTeamPages(captured);
  const files = writeTeamFixtures(captured, { capturedAt: new Date().toISOString(), source: 'Fetched by scripts/capture-team-fixtures.ts' });
  console.log(`captured ${files.length} team documents into ${TEAM_FIXTURES}; ${checked} schedules normalize identically after trimming`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
