/**
 * Adds provider fields to the captured summaries without changing anything else
 * in them, so existing tests keep their exact inputs: game leaders, attendance,
 * the first sportsbook's lines (without its betting links), and the win
 * probability after each play.
 * Needs network access: `npx tsx scripts/augment-fixtures.ts`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = Record<string, unknown>;
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'espn', 'summary');
const CATEGORIES = new Set(['passingYards', 'rushingYards', 'receivingYards']);

const o = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const pick = (v: unknown, keys: string[]): Json | undefined => {
  const src = o(v);
  if (!src) return undefined;
  return Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
};

function trimLeaders(raw: unknown) {
  return a(raw).map((entry) => ({
    team: pick(o(entry)?.team, ['id', 'abbreviation']),
    leaders: a(o(entry)?.leaders)
      .filter((c) => CATEGORIES.has(String(o(c)?.name)))
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
  }));
}

/** The first-priority sportsbook's lines, opening and latest, without links or logos. */
function trimLines(raw: unknown) {
  const entries = a(raw)
    .map(o)
    .filter((e): e is Json => e !== null && o(e.provider) !== null);
  const e = entries.find((x) => o(x.provider)?.priority === 1) ?? entries[0];
  if (!e) return undefined;
  const side = (v: unknown) => pick(v, ['favorite', 'underdog', 'moneyLine', 'spreadOdds', 'teamId', 'favoriteAtOpen']);
  const openClose = (v: unknown, keys: string[]) => ({ open: pick(o(v)?.open, keys), close: pick(o(v)?.close, keys) });
  return [
    {
      provider: pick(e.provider, ['id', 'name', 'priority']),
      ...pick(e, ['details', 'overUnder', 'spread', 'overOdds', 'underOdds']),
      awayTeamOdds: side(e.awayTeamOdds),
      homeTeamOdds: side(e.homeTeamOdds),
      moneyline: { home: openClose(o(e.moneyline)?.home, ['odds']), away: openClose(o(e.moneyline)?.away, ['odds']) },
      pointSpread: { home: openClose(o(e.pointSpread)?.home, ['line', 'odds']), away: openClose(o(e.pointSpread)?.away, ['line', 'odds']) },
      total: { over: openClose(o(e.total)?.over, ['line', 'odds']), under: openClose(o(e.total)?.under, ['line', 'odds']) },
    },
  ];
}

const trimWinProbability = (raw: unknown) =>
  a(raw)
    .map((entry) => pick(entry, ['homeWinPercentage', 'tiePercentage', 'playId']))
    .filter((e): e is Json => e !== undefined);

async function main() {
  const files = readdirSync(DIR).filter((f) => /^(nfl|cfb)-\d+\.json$/.test(f));
  let updated = 0;
  for (const file of files) {
    const [, league, id] = /^(nfl|cfb)-(\d+)\.json$/.exec(file)!;
    const path = league === 'nfl' ? 'nfl' : 'college-football';
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/${path}/summary?event=${id}`);
    if (!res.ok) {
      console.warn(`skip ${file}: ${res.status}`);
      continue;
    }
    const live = (await res.json()) as Json;
    const fixture = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Json;
    fixture.leaders = trimLeaders(live.leaders);
    const attendance = o(live.gameInfo)?.attendance;
    if (typeof attendance === 'number') fixture.gameInfo = { ...(o(fixture.gameInfo) ?? {}), attendance };
    const lines = trimLines(live.pickcenter);
    if (lines) fixture.pickcenter = lines;
    const winProbability = trimWinProbability(live.winprobability);
    if (winProbability.length) fixture.winprobability = winProbability;
    writeFileSync(join(DIR, file), JSON.stringify(fixture));
    updated++;
    console.log(
      `${file}: ${a(fixture.leaders).length} teams with leaders, attendance ${typeof attendance === 'number' ? attendance : 'not reported'}, lines ${lines ? String(o(lines[0])?.details ?? 'reported') : 'not reported'}, win probability for ${winProbability.length} plays`,
    );
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`Updated ${updated} of ${files.length} summaries.`);
}

void main();
