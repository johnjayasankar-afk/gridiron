/**
 * Records a sportsbook's line while games are actually running, so replays can
 * rewind it the way they already rewind the exchange's price.
 *
 * The exchange can be asked after the fact what a contract traded at during a
 * past game. A sportsbook cannot: the provider reports an opening line and a
 * closing one, and its own line-movement collection exists and is always empty.
 * The only way a replay can ever say what the book was offering at a play is if
 * something was watching and wrote it down. This is that something.
 *
 * It uses the same rule the live server uses, from shared/lineHistory, so a
 * recording made here and a recording made by a running Gridiron are the same
 * kind of thing: a reading is written only when it differs from the last one,
 * and every reading carries the moment it was seen. Nothing is written for a
 * moment nobody looked at, and nothing is filled in between readings.
 *
 * The file is rewritten after every round, so stopping it keeps what it has.
 *
 *   npx tsx scripts/capture-lines.ts nfl-401872948 [more ids...]
 *   npx tsx scripts/capture-lines.ts --league nfl --live     every game in progress
 *   npx tsx scripts/capture-lines.ts --league nfl --date 20260927
 *
 *   --every <seconds>   how often to read      (default 20, minimum 10)
 *   --until <ISO time>  when to stop           (default: when every game is final)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProviderFetcher } from '../server/fetcher.js';
import { coreOddsUrl, normalizeCoreOdds } from '../server/providers/espn/odds.js';
import { recordLine } from '../shared/lineHistory.js';
import type { LeagueId, LineHistory } from '../shared/model.js';
import { parseGameId } from '../shared/model.js';
import { easternDateKey } from '../shared/util.js';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROOT = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (name: string) => argv.includes(`--${name}`);
const everyMs = Math.max(10, Number(flag('every') ?? 20)) * 1000;
const until = flag('until') ? Date.parse(flag('until')!) : null;
const league = (flag('league') as LeagueId | null) ?? 'nfl';

const fetcher = new ProviderFetcher();
const path = (l: LeagueId) => (l === 'nfl' ? 'nfl' : 'college-football');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Watched {
  id: string;
  league: LeagueId;
  providerEventId: string;
  homeId: string;
  awayId: string;
  dateKey: string;
  name: string;
  done: boolean;
}

/** The games to watch: named on the command line, or everything live or on a date. */
async function discover(): Promise<Watched[]> {
  const named = argv.filter((a) => !a.startsWith('--') && parseGameId(a));
  const date = flag('date');
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/${path(league)}/scoreboard?limit=500${date ? `&dates=${date}` : ''}`;
  const res = await fetcher.getJson<Raw>(url);
  if (!res.ok) throw new Error(`Scoreboard could not be read: ${res.error}`);
  const out: Watched[] = [];
  for (const e of (res.data.events ?? []) as Raw[]) {
    const id = `${league === 'nfl' ? 'nfl' : 'cfb'}-${e.id}`;
    const state = e.competitions?.[0]?.status?.type?.state;
    if (named.length) {
      if (!named.includes(id)) continue;
    } else if (has('live') && state !== 'in') continue;
    /*
     * A game already over is not recorded. The reading would be honest about
     * when it was taken and would describe no moment in the game, so it would
     * sit after every play in a replay and answer none of them.
     */
    if (state === 'post') {
      console.warn(`${id} is already final; nothing about a finished game can be recorded now.`);
      continue;
    }
    const competitors = (e.competitions?.[0]?.competitors ?? []) as Raw[];
    const home = competitors.find((c) => c.homeAway === 'home');
    const away = competitors.find((c) => c.homeAway === 'away');
    if (!home?.id || !away?.id) continue;
    out.push({
      id,
      league,
      providerEventId: String(e.id),
      homeId: String(home.id),
      awayId: String(away.id),
      dateKey: easternDateKey(new Date(e.date)),
      name: String(e.shortName ?? e.id),
      done: state === 'post',
    });
  }
  if (named.length && out.length < named.length) console.warn(`Only ${out.length} of ${named.length} named games are on the ${league.toUpperCase()} scoreboard.`);
  return out;
}

/** One file per league and provider day, beside the exchange's captures. */
function fileFor(l: LeagueId, dateKey: string) {
  return join(ROOT, 'fixtures', 'lines', `${l}-${dateKey}.json`);
}

function load(l: LeagueId, dateKey: string): Raw {
  const file = fileFor(l, dateKey);
  if (!existsSync(file)) return { league: l, dateKey, provider: null, capturedBy: 'scripts/capture-lines.ts', games: {} };
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Raw;
  } catch {
    throw new Error(`${file} exists and is not readable JSON; move it aside rather than losing what is in it.`);
  }
}

function save(l: LeagueId, dateKey: string, doc: Raw) {
  const file = fileFor(l, dateKey);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

async function main() {
  const games = await discover();
  if (!games.length) {
    console.log('No games to watch. Name game ids, or use --live, or --date YYYYMMDD.');
    return;
  }
  console.log(`Watching ${games.length} game${games.length === 1 ? '' : 's'} every ${everyMs / 1000}s:`);
  for (const g of games) console.log(`  ${g.id}  ${g.name}`);

  const docs = new Map<string, Raw>();
  const held = new Map<string, LineHistory | null>();
  for (const g of games) {
    const key = `${g.league}|${g.dateKey}`;
    if (!docs.has(key)) docs.set(key, load(g.league, g.dateKey));
    const existing = docs.get(key)!.games?.[g.id];
    held.set(g.id, existing?.points?.length ? { provider: String(existing.provider ?? 'Sportsbook'), points: existing.points, captured: true } : null);
  }

  let rounds = 0;
  for (;;) {
    rounds++;
    let wrote = 0;
    await Promise.all(
      games.map(async (g) => {
        const res = await fetcher.getJson<unknown>(coreOddsUrl(g.league, g.providerEventId));
        if (!res.ok) return;
        const lines = normalizeCoreOdds(res.data, g.homeId, g.awayId);
        if (!lines) return;
        const before = held.get(g.id) ?? null;
        const after = recordLine(before, lines, new Date(res.receivedAt).toISOString());
        if (after === before || !after) return;
        held.set(g.id, after);
        wrote++;
        const doc = docs.get(`${g.league}|${g.dateKey}`)!;
        doc.provider = doc.provider ?? after.provider;
        doc.games[g.id] = { name: g.name, provider: after.provider, points: after.points };
      }),
    );
    if (wrote) for (const [key, doc] of docs) save(doc.league as LeagueId, key.split('|')[1], doc);
    const total = [...held.values()].reduce((n, h) => n + (h?.points.length ?? 0), 0);
    console.log(`${new Date().toISOString()}  round ${rounds}: ${wrote} line${wrote === 1 ? '' : 's'} moved, ${total} readings held`);

    if (until !== null && Date.now() >= until) break;
    if (until === null && games.every((g) => g.done)) break;
    await pause(everyMs);
    // A game that has finished stops being watched, and the run ends when they all have.
    if (until === null) {
      const fresh = await discover().catch(() => games);
      for (const g of games) g.done = fresh.find((f) => f.id === g.id)?.done ?? g.done;
    }
  }
  console.log('Done. Recordings are in fixtures/lines; a replay of these games will rewind the line to the play.');
}

await main();
