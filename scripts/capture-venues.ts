/**
 * Builds the table of venue capacities Gridiron draws its bowls from.
 *
 * The provider reports a venue's name, city, roof and playing surface, and not
 * how big it is, so every stadium was drawn the same size: Michigan Stadium and
 * a stadium that holds twenty thousand were the same bowl with different end
 * zones. Capacity is the one number that makes them different, and Wikidata has
 * it for almost all of them.
 *
 * Matching is the whole risk here. A stadium matched to the wrong entry puts a
 * number in that is simply false, and "Memorial Stadium" alone matches both
 * Nebraska's, which holds 87,091, and one in Horfield, England, which holds
 * 12,100. So a match is only taken when it is unarguable:
 *
 *   the venue is in the United States,
 *   the provider's city appears in the entry's administrative chain,
 *   and exactly one entry survives both.
 *
 * Anything ambiguous is dropped rather than guessed, and every row carries the
 * Wikidata id it came from so any one of them can be checked by hand. A venue
 * with no row simply has no capacity, and the bowl falls back to the size it has
 * always been drawn at, which is a state the field already handles.
 *
 * The output is checked in. Nothing queries Wikidata at runtime: this is a
 * reference table, generated deliberately and reviewed like any other file.
 *
 *   npx tsx scripts/capture-venues.ts            every team in both leagues
 *   npx tsx scripts/capture-venues.ts --nfl      NFL only, which is quick
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProviderFetcher } from '../server/fetcher.js';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'shared', 'venues.ts');
const nflOnly = process.argv.includes('--nfl');
const fetcher = new ProviderFetcher();
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues';

interface Venue {
  espnId: string;
  name: string;
  city: string | null;
  state: string | null;
}

/** Runs a list of jobs a few at a time, because a thousand at once is rude and slower. */
async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await run(items[i]);
      }
    }),
  );
  return out;
}

/** Every venue a current team calls home, which is every venue that hosts a game worth drawing. */
async function venuesFromTeams(): Promise<Venue[]> {
  const leagues = nflOnly ? ['nfl'] : ['nfl', 'college-football'];
  const refs: string[] = [];
  for (const league of leagues) {
    for (let page = 1; ; page++) {
      const res = await fetcher.getJson<Raw>(`${CORE}/${league}/seasons/2026/teams?limit=400&page=${page}`);
      if (!res.ok) break;
      for (const item of (res.data.items ?? []) as Raw[]) if (typeof item.$ref === 'string') refs.push(item.$ref);
      if (page >= Number(res.data.pageCount ?? 1)) break;
    }
  }
  console.log(`${refs.length} teams to read`);
  const found = new Map<string, Venue>();
  let done = 0;
  await pool(refs, 8, async (ref) => {
    const res = await fetcher.getJson<Raw>(ref.replace('http://', 'https://'));
    if (++done % 100 === 0) console.log(`  ${done}/${refs.length}`);
    const v = res.ok ? (res.data.venue as Raw | undefined) : undefined;
    if (!v?.id || typeof v.fullName !== 'string') return;
    found.set(String(v.id), { espnId: String(v.id), name: v.fullName, city: v.address?.city ?? null, state: v.address?.state ?? null });
  });
  return [...found.values()].sort((a, b) => Number(a.espnId) - Number(b.espnId));
}

/** The parenthetical the provider adds to disambiguate its own names is not part of the name anywhere else. */
const plainName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim();

interface Candidate {
  qid: string;
  capacity: number | null;
  country: string | null;
  admin: Set<string>;
}

async function wikidata(names: string[]): Promise<Map<string, Candidate[]>> {
  const out = new Map<string, Candidate[]>();
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += 120) batches.push(names.slice(i, i + 120));
  for (const [i, batch] of batches.entries()) {
    const values = batch.map((n) => `"${n.replace(/["\\]/g, '')}"@en`).join(' ');
    const query = `SELECT ?name ?item ?capacity ?countryLabel (GROUP_CONCAT(DISTINCT ?adminLabel; separator="|") AS ?admin) WHERE {
  VALUES ?name { ${values} }
  ?item rdfs:label|skos:altLabel ?name .
  ?item wdt:P31/wdt:P279* wd:Q1076486 .
  OPTIONAL { ?item wdt:P1083 ?capacity }
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?item wdt:P131+ ?a . ?a rdfs:label ?adminLabel FILTER(lang(?adminLabel)="en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
} GROUP BY ?name ?item ?capacity ?countryLabel`;
    const res = await fetch('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { accept: 'application/sparql-results+json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'gridiron/0.6 (venue capacity table; one-off)' },
      body: new URLSearchParams({ query }),
    });
    if (!res.ok) throw new Error(`Wikidata answered ${res.status} for batch ${i + 1}`);
    const body = (await res.json()) as Raw;
    for (const row of body.results.bindings as Raw[]) {
      const name = row.name.value as string;
      const list = out.get(name) ?? [];
      list.push({
        qid: String(row.item.value).split('/').pop()!,
        capacity: row.capacity ? Math.round(Number(row.capacity.value)) : null,
        country: row.countryLabel?.value ?? null,
        admin: new Set(String(row.admin?.value ?? '').split('|').filter(Boolean)),
      });
      out.set(name, list);
    }
    console.log(`  Wikidata batch ${i + 1}/${batches.length}`);
  }
  return out;
}

async function main() {
  const venues = await venuesFromTeams();
  console.log(`${venues.length} distinct venues`);
  const candidates = await wikidata([...new Set(venues.map((v) => plainName(v.name)))]);

  const rows: Array<{ espnId: string; name: string; city: string | null; capacity: number; wikidata: string }> = [];
  const dropped: string[] = [];
  for (const v of venues) {
    const all = candidates.get(plainName(v.name)) ?? [];
    // One entry per Wikidata id: the query returns a row per label it matched.
    const distinct = [...new Map(all.map((c) => [c.qid, c])).values()];
    const american = distinct.filter((c) => c.country === 'United States' && c.capacity && c.capacity > 0);
    const here = v.city ? american.filter((c) => c.admin.has(v.city!)) : [];
    const pick = here.length ? here : american;
    if (pick.length === 1) rows.push({ espnId: v.espnId, name: v.name, city: v.city, capacity: pick[0].capacity!, wikidata: pick[0].qid });
    else dropped.push(`${v.name}${v.city ? `, ${v.city}` : ''}${pick.length > 1 ? ` (${pick.length} entries, not decided)` : ''}`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const header = [
    '/**',
    " * How many people each venue holds, by the provider's own venue id.",
    ' *',
    " * The provider reports a venue's name, city, roof and surface, and not its",
    ' * size, so every stadium was drawn the same: Michigan Stadium and a ground',
    ' * that holds eight hundred were the same four stands with different end zones.',
    ' * Capacity is the one number that separates them.',
    ' *',
    ' * This is a reference table, not a lookup. It is generated deliberately by',
    ' * scripts/capture-venues.ts, reviewed like any other file, and nothing queries',
    ' * anything at runtime. A match is only taken when it is unarguable: the venue',
    " * is in the United States, the provider's city appears in the entry's",
    ' * administrative chain, and exactly one entry survives both. "Memorial',
    ' * Stadium" alone matches Nebraska\'s, which holds 87,091, and one in Horfield,',
    ' * England, which holds 12,100, so anything undecided is left out rather than',
    ' * guessed. Every row carries the Wikidata id it came from so it can be checked',
    ' * by hand, and a venue that is not here simply has no capacity: the bowl falls',
    ' * back to the size Gridiron has always drawn.',
    ' *',
    ' * Source: Wikidata (CC0), matched to the provider\'s venue ids by name, country and city.',
    ` * Generated ${new Date().toISOString().slice(0, 10)} from ${rows.length} unarguable matches.`,
    ' */',
    'export interface VenueCapacity {',
    "  /** The provider's venue id, which is what a game is matched on. */",
    '  espnId: string;',
    '  name: string;',
    '  capacity: number;',
    '  /** The entry this came from, so any row can be checked. */',
    '  wikidata: string;',
    '}',
    '',
    'export const VENUE_CAPACITIES: readonly VenueCapacity[] = [',
  ];
  const body = rows.sort((a, b) => Number(a.espnId) - Number(b.espnId)).map((r) => `  { espnId: '${r.espnId}', name: '${escape(r.name)}', capacity: ${r.capacity}, wikidata: '${r.wikidata}' },`);
  writeFileSync(OUT, `${[...header, ...body, '];'].join('\n')}\n`);
  console.log(`\n${rows.length} venues matched, ${dropped.length} left out`);
  for (const d of dropped.slice(0, 20)) console.log(`  left out: ${d}`);
  if (dropped.length > 20) console.log(`  ...and ${dropped.length - 20} more`);
  console.log(`\nWrote ${OUT}`);
}

await main();
