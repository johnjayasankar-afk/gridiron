/**
 * Captures Kalshi's recorded prices for the games of a real replay scenario, so replays can show
 * the market beside ESPN's win probability as it actually traded. Kalshi's market data needs no
 * account or key.
 *
 * For each game the event is found from its US Eastern date and both teams' codes, exactly as
 * the live reader matches games. Each team's contract to win is saved minute by minute, from an
 * hour before kickoff to ten minutes after the game: the closing best bid, best ask and last
 * trade of every minute that had any of them.
 *
 *   npx tsx scripts/capture-kalshi.ts [scenario id]      default: nfl-week1-sunday
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KALSHI_API, KALSHI_NAME, KALSHI_SERIES, kalshiCode } from '../server/markets/kalshi';
import { FixtureStore, SCENARIOS } from '../server/replay/scenarios';
import type { Team } from '../shared/model';
import { easternDateKey } from '../shared/util';

type Raw = Record<string, any>;
type Candle = [number, number | null, number | null, number | null];

const ROOT = join(import.meta.dirname, '..');
const scenarioId = process.argv[2] ?? 'nfl-week1-sunday';
const def = SCENARIOS.find((s) => s.id === scenarioId && !s.synthetic);
if (!def) throw new Error(`No real replay scenario is named ${scenarioId}`);
const built = def.build(new FixtureStore(join(ROOT, 'fixtures', 'espn')));
if (!built) throw new Error(`The captured ESPN data for ${scenarioId} is not installed`);

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** "20260913" → "26SEP13". */
const tickerDate = (dateKey: string) => `${dateKey.slice(2, 4)}${MONTHS[Number(dateKey.slice(4, 6)) - 1]}${dateKey.slice(6, 8)}`;
const dollars = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

let lastRequest = 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kalshi limits bursts, so requests are spaced out, and a 429 waits and tries again. */
async function get<T>(path: string, attempt = 0): Promise<T> {
  const wait = lastRequest + 500 - Date.now();
  if (wait > 0) await pause(wait);
  lastRequest = Date.now();
  const res = await fetch(`${KALSHI_API}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429 && attempt < 6) {
    const after = Number(res.headers.get('retry-after'));
    await pause(Number.isFinite(after) && after > 0 ? after * 1000 : 3_000 * (attempt + 1));
    return get<T>(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

// One file per league and provider day, shared by every scenario that replays those games.
const league = built.games[0]?.league ?? 'nfl';
const name = `${league}-${built.date}.json`;
const file = join(ROOT, 'fixtures', 'kalshi', name);
const refresh = process.argv.includes('--refresh');
const previous: Record<string, unknown> = existsSync(file) ? ((JSON.parse(readFileSync(file, 'utf8')) as { games?: Record<string, unknown> }).games ?? {}) : {};

const games: Record<string, { event: string; result: string | null; home: { ticker: string; candles: Candle[] } | null; away: { ticker: string; candles: Candle[] } | null }> = {};
for (const tl of built.games) {
  if (tl.scoreOnly) continue;
  if (previous[tl.id] && !refresh) {
    console.log(`${tl.id}: already captured (--refresh captures again)`);
    continue;
  }
  const competitors: Raw[] = tl.event.competitions?.[0]?.competitors ?? [];
  const team = (side: 'home' | 'away') => competitors.find((c) => c.homeAway === side)?.team as Raw | undefined;
  const home = team('home');
  const away = team('away');
  if (!home || !away) continue;
  const code = (t: Raw) => kalshiCode({ abbreviation: String(t.abbreviation), league: tl.league } as Team);
  const series = KALSHI_SERIES[tl.league].game;
  const scheduled = Date.parse(tl.event.date);
  const event = `${series}-${tickerDate(easternDateKey(new Date(scheduled)))}${code(away)}${code(home)}`;
  try {
    const { markets } = await get<{ markets?: Raw[] }>(`/markets?event_ticker=${encodeURIComponent(event)}&limit=10`);
    const start = Math.floor((Math.min(scheduled, tl.kickoffAt) - 60 * 60_000) / 1000);
    const end = Math.floor((tl.endAt + 10 * 60_000) / 1000);
    const contract = async (t: Raw) => {
      const ticker = `${event}-${code(t)}`;
      if (!(markets ?? []).some((m) => m.ticker === ticker)) return null;
      const data = await get<{ candlesticks?: Raw[] }>(`/series/${series}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=1`);
      const candles = (data.candlesticks ?? [])
        .map((c): Candle => [Number(c.end_period_ts), dollars(c.yes_bid?.close_dollars), dollars(c.yes_ask?.close_dollars), dollars(c.price?.close_dollars)])
        .filter((c) => Number.isFinite(c[0]) && (c[1] !== null || c[2] !== null || c[3] !== null));
      return { ticker, candles };
    };
    const homeContract = await contract(home);
    const awayContract = await contract(away);
    const winner = (markets ?? []).find((m) => m.result === 'yes');
    games[tl.id] = { event, result: winner ? String(winner.ticker) : null, home: homeContract, away: awayContract };
    console.log(`${tl.id} ${event}: home ${homeContract?.candles.length ?? 'none'}, away ${awayContract?.candles.length ?? 'none'} minutes`);
  } catch (e) {
    console.warn(`${tl.id} ${event}: not captured (${(e as Error).message})`);
  }
}

mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  `${JSON.stringify({
    source: KALSHI_NAME,
    date: built.date,
    capturedAt: new Date().toISOString(),
    about: "Minute candles from Kalshi's public market data for each team's contract to win: [end of the minute in Unix seconds, closing best bid, closing best ask, closing last trade], in dollars, null where the minute had none.",
    games: { ...previous, ...games },
  })}\n`,
);
console.log(`Saved ${Object.keys(games).length} games to fixtures/kalshi/${name}`);
