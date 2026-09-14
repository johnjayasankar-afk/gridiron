/**
 * Kalshi public market data → Gridiron market prices.
 *
 * Kalshi's market data API answers without an account or key. Conventions
 * observed in its responses on 14 September 2026:
 * - Game contracts are in series KXNFLGAME and KXNCAAFGAME; spread and total
 *   ladders are in KXNFLSPREAD, KXNFLTOTAL, KXNCAAFSPREAD and KXNCAAFTOTAL.
 * - An event ticker ends with the game's US Eastern date and both teams' codes,
 *   away first: KXNFLGAME-26SEP14DENKC. A game contract's ticker ends with its
 *   team's code (KXNFLGAME-26SEP14DENKC-KC), and its Yes price is that team's
 *   chance to win.
 * - Spread contracts read "Kansas City wins by over 2.5 points" (floor_strike 2.5,
 *   ticker suffix KC3). Total contracts read "Over 43.5 points scored".
 * - Prices are dollar strings: yes_bid_dollars, yes_ask_dollars, last_price_dollars.
 * - NFL team codes equal ESPN's abbreviations except JAC (ESPN: JAX) and WAS (ESPN: WSH).
 *   College codes are used only where they equal ESPN's abbreviations.
 * Nothing is matched by team name, so a game whose codes differ simply has no prices.
 */
import type { PriceCandle } from '../../shared/marketHistory.js';
import type { GameSummary, MarketPrices, MarketQuote, Side, Team } from '../../shared/model.js';
import { parseDollars, quotePrice } from '../../shared/odds.js';
import { easternDateKey } from '../../shared/util.js';

export const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
export const KALSHI_NAME = 'Kalshi';

export const KALSHI_SERIES = {
  nfl: { game: 'KXNFLGAME', spread: 'KXNFLSPREAD', total: 'KXNFLTOTAL' },
  cfb: { game: 'KXNCAAFGAME', spread: 'KXNCAAFSPREAD', total: 'KXNCAAFTOTAL' },
} as const;

/** ESPN NFL abbreviations that Kalshi writes differently. */
const NFL_CODES: Record<string, string> = { JAX: 'JAC', WSH: 'WAS' };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** A ladder contract is used only within this many points of the sportsbook's line. */
const MAX_LINE_GAP = 3;

export interface KalshiMarket {
  ticker: string;
  status?: string;
  yes_sub_title?: string;
  floor_strike?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  title?: string;
  sub_title?: string;
  markets?: KalshiMarket[];
}

/** The contracts Gridiron reads for one game. */
export interface GameContracts {
  event: string;
  home: string | null;
  away: string | null;
  spread: { team: Side; line: number; ticker: string } | null;
  total: { line: number; ticker: string } | null;
}

export const isKalshiEvent = (v: unknown): v is KalshiEvent => !!v && typeof v === 'object' && typeof (v as KalshiEvent).event_ticker === 'string';

/** "26SEP14" → "20260914". */
export function dateFromTicker(token: string): string | null {
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(token);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  return month < 0 ? null : `20${m[1]}${String(month + 1).padStart(2, '0')}${m[3]}`;
}

/** KXNFLGAME-26SEP14DENKC → { series: "KXNFLGAME", date: "20260914", teams: "DENKC" }. */
export function parseEventTicker(ticker: string): { series: string; date: string; teams: string } | null {
  const m = /^([A-Z0-9]+)-(\d{2}[A-Z]{3}\d{2})([A-Z][A-Z0-9]*)$/.exec(ticker);
  if (!m) return null;
  const date = dateFromTicker(m[2]);
  return date ? { series: m[1], date, teams: m[3] } : null;
}

/** The last segment of a contract ticker: a team code for game contracts, a code and strike for spreads. */
const lastSegment = (ticker: string) => ticker.slice(ticker.lastIndexOf('-') + 1);

export function kalshiCode(team: Team): string {
  const abbreviation = team.abbreviation.toUpperCase();
  return team.league === 'nfl' ? (NFL_CODES[abbreviation] ?? abbreviation) : abbreviation;
}

/** The game event for this game: same US Eastern date, and contracts for both teams. */
export function findGameEvent(events: KalshiEvent[], game: GameSummary): KalshiEvent | null {
  const start = game.startTime ? Date.parse(game.startTime) : Number.NaN;
  if (!Number.isFinite(start)) return null;
  const date = easternDateKey(new Date(start));
  const away = kalshiCode(game.away);
  const home = kalshiCode(game.home);
  for (const e of events) {
    const t = parseEventTicker(e.event_ticker);
    if (!t || t.date !== date || (t.teams !== `${away}${home}` && t.teams !== `${home}${away}`)) continue;
    const codes = new Set((e.markets ?? []).map((m) => lastSegment(m.ticker)));
    if (codes.has(away) && codes.has(home)) return e;
  }
  return null;
}

/** The ladder contract whose strike is nearest `line`; for spreads, only `code`'s contracts. */
export function nearestStrike(markets: KalshiMarket[], line: number, code: string | null): KalshiMarket | null {
  let best: KalshiMarket | null = null;
  for (const m of markets) {
    if (typeof m.floor_strike !== 'number' || !Number.isFinite(m.floor_strike)) continue;
    if (code !== null && !new RegExp(`^${code}\\d+$`).test(lastSegment(m.ticker))) continue;
    if (!best || Math.abs(m.floor_strike - line) < Math.abs((best.floor_strike as number) - line)) best = m;
  }
  return best && Math.abs((best.floor_strike as number) - line) <= MAX_LINE_GAP ? best : null;
}

/**
 * Which contracts to read for a game: each team's game contract, and, when the
 * sportsbook reports lines, the spread and total contracts nearest those lines.
 */
export function contractsFor(game: GameSummary, gameEvent: KalshiEvent, spreadEvent: KalshiEvent | null, totalEvent: KalshiEvent | null): GameContracts | null {
  const markets = gameEvent.markets ?? [];
  const home = markets.find((m) => lastSegment(m.ticker) === kalshiCode(game.home))?.ticker ?? null;
  const away = markets.find((m) => lastSegment(m.ticker) === kalshiCode(game.away))?.ticker ?? null;
  if (!home && !away) return null;

  let spread: GameContracts['spread'] = null;
  const favorite = game.lines?.favorite ?? null;
  const favoriteLine = favorite ? (game.lines?.spread?.[favorite].latest?.line ?? null) : null;
  if (spreadEvent && favorite && favoriteLine !== null && favoriteLine < 0) {
    const m = nearestStrike(spreadEvent.markets ?? [], -favoriteLine, kalshiCode(game[favorite]));
    if (m) spread = { team: favorite, line: m.floor_strike as number, ticker: m.ticker };
  }

  let total: GameContracts['total'] = null;
  const bookTotal = game.lines?.total?.over.latest?.line ?? null;
  if (totalEvent && bookTotal !== null) {
    const m = nearestStrike(totalEvent.markets ?? [], bookTotal, null);
    if (m) total = { line: m.floor_strike as number, ticker: m.ticker };
  }
  return { event: gameEvent.event_ticker, home, away, spread, total };
}

export const contractTickers = (c: GameContracts): string[] => [c.home, c.away, c.spread?.ticker ?? null, c.total?.ticker ?? null].filter((t): t is string => t !== null);

/** A contract's quote, when it is open for trading and has a usable price. */
export function quoteOf(m: KalshiMarket | undefined): MarketQuote | null {
  if (!m || (m.status !== undefined && m.status !== 'active' && m.status !== 'open')) return null;
  const bid = parseDollars(m.yes_bid_dollars);
  const ask = parseDollars(m.yes_ask_dollars);
  const last = parseDollars(m.last_price_dollars);
  const price = quotePrice(bid, ask, last);
  if (price === null) return null;
  return { price, bid: bid !== null && bid > 0 ? bid : null, ask: ask !== null && ask > 0 ? ask : null, last: last !== null && last > 0 ? last : null };
}

/** Kalshi candlesticks as price candles: each period's end with its closing bid, ask and last trade. Malformed entries are left out. */
export function candlesFrom(raw: unknown): PriceCandle[] {
  if (!Array.isArray(raw)) return [];
  const out: PriceCandle[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as { end_period_ts?: unknown; price?: { close_dollars?: unknown }; yes_bid?: { close_dollars?: unknown }; yes_ask?: { close_dollars?: unknown } };
    if (typeof c.end_period_ts !== 'number' || !Number.isFinite(c.end_period_ts)) continue;
    out.push([c.end_period_ts, parseDollars(c.yes_bid?.close_dollars), parseDollars(c.yes_ask?.close_dollars), parseDollars(c.price?.close_dollars)]);
  }
  return out;
}

/** Prices for a game's contracts from a set of fetched markets; null when none has a usable price. */
export function pricesFrom(contracts: GameContracts, markets: ReadonlyMap<string, KalshiMarket>, changedAt: string, stale: boolean): MarketPrices | null {
  const quote = (ticker: string | null) => (ticker ? quoteOf(markets.get(ticker)) : null);
  const home = quote(contracts.home);
  const away = quote(contracts.away);
  const spreadQuote = contracts.spread ? quote(contracts.spread.ticker) : null;
  const totalQuote = contracts.total ? quote(contracts.total.ticker) : null;
  const moneyline = home || away ? { home, away } : null;
  const spread = contracts.spread && spreadQuote ? { team: contracts.spread.team, line: contracts.spread.line, quote: spreadQuote } : null;
  const total = contracts.total && totalQuote ? { line: contracts.total.line, over: totalQuote } : null;
  if (!moneyline && !spread && !total) return null;
  return { source: KALSHI_NAME, moneyline, spread, total, changedAt, stale };
}
