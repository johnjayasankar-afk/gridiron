/**
 * Captures real ESPN responses into fixtures/espn, trimmed to the fields
 * Gridiron reads. Used by the unit tests, the browser tests and the replay lab.
 *
 *   npx tsx scripts/capture-fixtures.ts
 *
 * The captured files are ESPN's data. They are kept small and used only for
 * testing and clearly labelled replays; see README "Fixtures".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_BASE, coreRef } from '../server/providers/espn/coverage';
import { SITE_BASE } from '../server/providers/espn/normalize';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'espn');

type Json = unknown;
const o = (v: Json) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : null);
const a = (v: Json) => (Array.isArray(v) ? v : []);
const pick = (v: Json, keys: string[]): Record<string, Json> | undefined => {
  const src = o(v);
  if (!src) return undefined;
  const out: Record<string, Json> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

const TEAM_KEYS = ['id', 'abbreviation', 'displayName', 'shortDisplayName', 'name', 'location', 'color', 'alternateColor', 'logo', 'conferenceId', 'groups'];
const trimLogos = (team: Json) => {
  const t = pick(team, TEAM_KEYS) ?? {};
  const logos = a(o(team)?.logos).filter((l) => {
    const rel = a(o(l)?.rel);
    return rel.includes('full') && (rel.includes('default') || rel.includes('dark')) && !rel.includes('scoreboard');
  }).map((l) => pick(l, ['href', 'rel', 'width', 'height']));
  if (logos.length) t.logos = logos;
  return t;
};
const STATE_KEYS = ['down', 'distance', 'yardLine', 'yardsToEndzone', 'downDistanceText', 'shortDownDistanceText', 'possessionText', 'team'];
const trimState = (s: Json) => {
  const out = pick(s, STATE_KEYS);
  if (out?.team) out.team = pick(out.team, ['id']);
  return out;
};
const trimPlay = (p: Json) => {
  const out = pick(p, ['id', 'sequenceNumber', 'type', 'text', 'awayScore', 'homeScore', 'period', 'clock', 'scoringPlay', 'modified', 'wallclock', 'statYardage', 'isTurnover', 'isPenalty']) ?? {};
  out.start = trimState(o(p)?.start);
  out.end = trimState(o(p)?.end);
  return out;
};
const trimDrive = (d: Json) => {
  const out = pick(d, ['id', 'description', 'start', 'end', 'timeElapsed', 'yards', 'isScore', 'offensivePlays', 'result', 'shortDisplayResult', 'displayResult']) ?? {};
  out.team = pick(o(d)?.team, ['id', 'abbreviation']);
  out.plays = a(o(d)?.plays).map(trimPlay);
  return out;
};
const trimCompetitor = (c: Json) => {
  const out = pick(c, ['id', 'homeAway', 'score', 'curatedRank', 'rank', 'records', 'record', 'possession', 'winner']) ?? {};
  out.team = trimLogos(o(c)?.team);
  return out;
};

export function trimScoreboard(sb: Json): Json {
  const root = o(sb) ?? {};
  const league = o(a(root.leagues)[0]);
  return {
    leagues: league ? [pick(league, ['id', 'abbreviation', 'season', 'calendar', 'calendarType'])] : [],
    season: root.season,
    week: root.week,
    events: a(root.events).map((e) => {
      const ev = pick(e, ['id', 'date', 'name', 'shortName', 'season', 'week', 'links', 'status']) ?? {};
      ev.links = a(o(e)?.links).filter((l) => a(o(l)?.rel).includes('summary')).map((l) => pick(l, ['rel', 'href', 'text']));
      const c = o(a(o(e)?.competitions)[0]);
      if (c) {
        const comp = pick(c, ['id', 'date', 'neutralSite', 'conferenceCompetition', 'playByPlayAvailable', 'status', 'broadcasts', 'geoBroadcasts', 'notes', 'format', 'situation']) ?? {};
        comp.venue = pick(c.venue, ['fullName', 'address']);
        comp.competitors = a(c.competitors).map(trimCompetitor);
        ev.competitions = [comp];
      }
      return ev;
    }),
  };
}

export function trimSummary(s: Json): Json {
  const root = o(s) ?? {};
  const header = o(root.header) ?? {};
  const comp = o(a(header.competitions)[0]) ?? {};
  return {
    format: root.format,
    header: {
      id: header.id,
      season: header.season,
      week: header.week,
      links: a(header.links).filter((l) => a(o(l)?.rel).includes('summary')).map((l) => pick(l, ['rel', 'href', 'text'])),
      competitions: [
        {
          ...pick(comp, ['id', 'date', 'neutralSite', 'conferenceCompetition', 'playByPlaySource', 'boxscoreSource', 'status', 'broadcasts', 'situation']),
          competitors: a(comp.competitors).map(trimCompetitor),
        },
      ],
    },
    drives: o(root.drives)
      ? { previous: a(o(root.drives)?.previous).map(trimDrive), ...(o(o(root.drives)?.current) ? { current: trimDrive(o(root.drives)?.current) } : {}) }
      : undefined,
    scoringPlays: a(root.scoringPlays).map((sp) => ({ ...pick(sp, ['id', 'type', 'text', 'awayScore', 'homeScore', 'period', 'clock']), team: pick(o(sp)?.team, ['id', 'abbreviation']) })),
    boxscore: o(root.boxscore)
      ? { teams: a(o(root.boxscore)?.teams).map((t) => ({ team: pick(o(t)?.team, ['id']), statistics: a(o(t)?.statistics).map((st) => pick(st, ['name', 'label', 'displayValue'])) })) }
      : undefined,
    gameInfo: o(root.gameInfo) ? { venue: pick(o(root.gameInfo)?.venue, ['fullName', 'address']), attendance: o(root.gameInfo)?.attendance } : undefined,
    leaders: a(root.leaders).map((entry) => ({
      team: pick(o(entry)?.team, ['id', 'abbreviation']),
      leaders: a(o(entry)?.leaders)
        .filter((c) => ['passingYards', 'rushingYards', 'receivingYards'].includes(String(o(c)?.name)))
        .map((c) => ({
          name: o(c)?.name,
          displayName: o(c)?.displayName,
          leaders: a(o(c)?.leaders)
            .slice(0, 1)
            .map((l) => ({
              displayValue: o(l)?.displayValue,
              athlete: { ...pick(o(l)?.athlete, ['displayName', 'shortName', 'jersey']), position: pick(o(o(l)?.athlete)?.position, ['abbreviation']), headshot: pick(o(o(l)?.athlete)?.headshot, ['href']) },
            })),
        })),
    })),
  };
}

async function getJson(url: string): Promise<Json> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function save(rel: string, data: Json) {
  const file = join(ROOT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return file;
}

async function main() {
  const manifest: Record<string, Json> = { capturedAt: new Date().toISOString(), provider: 'ESPN site API (undocumented)', files: [] as Json[] };
  const files = manifest.files as Json[];
  const record = (rel: string, url: string, note: string) => files.push({ file: rel, url, note });

  // NFL Week 1 2026, the Sunday slate, and every summary in it (the replay lab uses all of them).
  const nflDate = '20260913';
  const nflSbUrl = `${SITE_BASE}/nfl/scoreboard?dates=${nflDate}&limit=500`;
  const nflSb = await getJson(nflSbUrl);
  save(`scoreboard/nfl-${nflDate}.json`, trimScoreboard(nflSb));
  record(`scoreboard/nfl-${nflDate}.json`, nflSbUrl, 'NFL Sunday slate, all final at capture');
  for (const e of a(o(nflSb)?.events)) {
    const id = String(o(e)?.id);
    const url = `${SITE_BASE}/nfl/summary?event=${id}`;
    save(`summary/nfl-${id}.json`, trimSummary(await getJson(url)));
    record(`summary/nfl-${id}.json`, url, 'NFL game summary');
  }

  // College: discovery documents, then each division's scoreboard for Saturday.
  const cfbDate = '20260912';
  const groupsUrl = `${CORE_BASE}/seasons/2026/types/2/groups?limit=100`;
  const groups = await getJson(groupsUrl);
  save('core/groups-2026-2.json', groups);
  record('core/groups-2026-2.json', groupsUrl, 'College top-level groups');
  for (const item of a(o(groups)?.items)) {
    const parentUrl = coreRef(o(item)?.$ref);
    if (!parentUrl) continue;
    const parent = await getJson(parentUrl);
    const pid = String(o(parent)?.id);
    save(`core/group-${pid}.json`, pick(parent, ['id', 'name', 'abbreviation', 'shortName', 'isConference']));
    const childrenUrl = `${parentUrl.split('?')[0]}/children?limit=100`;
    const children = await getJson(childrenUrl);
    save(`core/group-${pid}-children.json`, children);
    record(`core/group-${pid}-children.json`, childrenUrl, `Children of group ${pid}`);
    for (const c of a(o(children)?.items)) {
      const childUrl = coreRef(o(c)?.$ref);
      if (!childUrl) continue;
      const child = await getJson(childUrl);
      save(`core/group-${String(o(child)?.id)}.json`, pick(child, ['id', 'name', 'abbreviation', 'shortName', 'isConference']));
    }
  }
  const divisionGroups = ['80', '81', '57', '58'];
  const cfbIds: Record<string, string[]> = {};
  for (const g of divisionGroups) {
    const url = `${SITE_BASE}/college-football/scoreboard?dates=${cfbDate}&groups=${g}&limit=500`;
    const sb = await getJson(url);
    save(`scoreboard/cfb-${cfbDate}-g${g}.json`, trimScoreboard(sb));
    record(`scoreboard/cfb-${cfbDate}-g${g}.json`, url, `College scoreboard for group ${g}`);
    cfbIds[g] = a(o(sb)?.events).map((e) => String(o(e)?.id));
  }
  const cfbSummaries = new Set<string>([
    '401856682', // Ohio State at Texas, a one-point game
    '401856673', // Western Kentucky at Georgia, spot-signal disagreements
    '401872616', // a scoring play appended after the end of the game
    ...cfbIds['80'].slice(0, 9),
    ...cfbIds['81'].slice(-4),
    ...cfbIds['57'].slice(0, 3), // Division II: mostly score-only coverage
  ]);
  for (const id of cfbSummaries) {
    const url = `${SITE_BASE}/college-football/summary?event=${id}`;
    try {
      save(`summary/cfb-${id}.json`, trimSummary(await getJson(url)));
      record(`summary/cfb-${id}.json`, url, 'College game summary');
    } catch (e) {
      files.push({ file: null, url, note: `capture failed: ${(e as Error).message}` });
    }
  }
  save('manifest.json', manifest);
  console.log(`captured ${files.length} documents into ${ROOT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
