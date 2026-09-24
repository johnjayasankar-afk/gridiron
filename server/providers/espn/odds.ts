/**
 * ESPN's betting lines, win probability and matchup predictor → Gridiron's model.
 *
 * Conventions from responses captured on 14 September 2026 (a scheduled NFL game,
 * and finished NFL and college games):
 * - Scoreboard competitions carry `odds` and game summaries carry `pickcenter`: the
 *   same per-sportsbook entries, first priority first. Each has `moneyline`,
 *   `pointSpread` and `total`, and each side of those has `open` and `close`.
 *   Before kickoff `close` is the current line. A finished game's scoreboard drops
 *   `odds`, while its summary keeps `pickcenter` with the closing line.
 * - Odds are strings ("-130", "+110"), or "OFF" when a book posts no moneyline.
 *   Lines are strings too: spreads "-2.5" and "+2.5", totals "o43.5" and "u43.5".
 * - `winprobability` lists the home team's chance after each play (0 to 1), keyed by
 *   play id, in play order. It is empty before kickoff.
 * - `predictor` is the pre-game matchup predictor, each side's "gameProjection" in
 *   percent. The two sides need not add up to 100.
 * Nothing here computes a chance: every value is the provider's own.
 */
import type { BettingLines, LeagueId, LinePrice, MatchupPredictor, OpenLatest, Side, WinProbability, WinProbabilityPoint } from '../../../shared/model.js';
import type { GameWeather } from '../../../shared/sky.js';
import { parseAmerican } from '../../../shared/odds.js';
import { arr, at, bool, num, obj, str } from './raw.js';

export const WIN_PROBABILITY_SOURCE = 'ESPN';

function lineNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = str(raw)?.trim();
  if (!s) return null;
  if (/^(pk|pick|even)$/i.test(s)) return 0;
  const m = /^[ou]?\s*([+-]?\d+(?:\.\d+)?)$/i.exec(s);
  return m ? Number(m[1]) : null;
}

const oddsPair = (side: unknown): OpenLatest<number> => ({ open: parseAmerican(at(side, 'open', 'odds')), latest: parseAmerican(at(side, 'close', 'odds')) });

function linePrice(raw: unknown): LinePrice | null {
  const line = lineNumber(at(raw, 'line'));
  return line === null ? null : { line, odds: parseAmerican(at(raw, 'odds')) };
}

const linePair = (side: unknown): OpenLatest<LinePrice> => ({ open: linePrice(at(side, 'open')), latest: linePrice(at(side, 'close')) });

const reported = <T>(pair: OpenLatest<T>) => pair.open !== null || pair.latest !== null;

/**
 * The first-priority sportsbook's lines, from a scoreboard competition's `odds` or a
 * summary's `pickcenter`. When the entry names its teams, they must be this game's
 * teams (in either order); otherwise nothing is returned rather than a guess.
 */
export function normalizeLines(raw: unknown, homeProviderId: string, awayProviderId: string): BettingLines | null {
  const entries = arr(raw)
    .map(obj)
    .filter((e): e is Record<string, unknown> => e !== null && obj(e.provider) !== null);
  const e = entries.find((x) => num(at(x, 'provider', 'priority')) === 1) ?? entries[0];
  if (!e) return null;
  const provider = str(at(e, 'provider', 'displayName')) ?? str(at(e, 'provider', 'name'));
  if (!provider) return null;

  const homeId = str(at(e, 'homeTeamOdds', 'teamId')) ?? str(at(e, 'homeTeamOdds', 'team', 'id'));
  const awayId = str(at(e, 'awayTeamOdds', 'teamId')) ?? str(at(e, 'awayTeamOdds', 'team', 'id'));
  const swapped = homeId === awayProviderId && awayId === homeProviderId;
  if (!swapped && ((homeId !== null && homeId !== homeProviderId) || (awayId !== null && awayId !== awayProviderId))) return null;
  const H: Side = swapped ? 'away' : 'home';
  const A: Side = swapped ? 'home' : 'away';

  let moneyline: BettingLines['moneyline'] = obj(e.moneyline) ? { home: oddsPair(at(e, 'moneyline', H)), away: oddsPair(at(e, 'moneyline', A)) } : null;
  if (!moneyline || (!reported(moneyline.home) && !reported(moneyline.away))) {
    const home = parseAmerican(at(e, `${H}TeamOdds`, 'moneyLine'));
    const away = parseAmerican(at(e, `${A}TeamOdds`, 'moneyLine'));
    moneyline = home !== null || away !== null ? { home: { open: null, latest: home }, away: { open: null, latest: away } } : null;
  }

  const spreadRaw = obj(e.pointSpread);
  const spreadPairs = spreadRaw ? { home: linePair(spreadRaw[H]), away: linePair(spreadRaw[A]) } : null;
  const spread = spreadPairs && (reported(spreadPairs.home) || reported(spreadPairs.away)) ? spreadPairs : null;

  const totalRaw = obj(e.total);
  let total: BettingLines['total'] = totalRaw ? { over: linePair(totalRaw.over), under: linePair(totalRaw.under) } : null;
  if (!total || (!reported(total.over) && !reported(total.under))) {
    const line = num(e.overUnder);
    total = line !== null && line > 0 ? { over: { open: null, latest: { line, odds: parseAmerican(e.overOdds) } }, under: { open: null, latest: { line, odds: parseAmerican(e.underOdds) } } } : null;
  }

  if (!moneyline && !spread && !total) return null;
  const homeFavorite = bool(at(e, `${H}TeamOdds`, 'favorite'));
  const awayFavorite = bool(at(e, `${A}TeamOdds`, 'favorite'));
  const homeLine = spread?.home.latest?.line ?? null;
  const favorite: Side | null =
    homeFavorite === true && awayFavorite !== true ? 'home' : awayFavorite === true && homeFavorite !== true ? 'away' : homeLine !== null && homeLine !== 0 ? (homeLine < 0 ? 'home' : 'away') : null;

  return { provider, details: str(e.details), favorite, moneyline, spread, total };
}

/** The home team's chance after each play, in the provider's order, keyed by namespaced play id. */
export function normalizeWinProbability(raw: unknown, gameId: string): WinProbabilityPoint[] {
  const out: WinProbabilityPoint[] = [];
  for (const item of arr(raw)) {
    const e = obj(item);
    const home = num(e?.homeWinPercentage);
    const playId = str(e?.playId);
    if (home === null || home < 0 || home > 1 || !playId) continue;
    const tie = num(e?.tiePercentage);
    out.push({ playId: `${gameId}:${playId}`, home, tie: tie !== null && tie >= 0 && tie <= 1 ? tie : 0 });
  }
  return out;
}

export function latestWinProbability(points: WinProbabilityPoint[]): WinProbability | null {
  const last = points[points.length - 1];
  return last ? { home: last.home, tie: last.tie, playId: last.playId, source: WIN_PROBABILITY_SOURCE } : null;
}

/** A scoreboard's `situation.lastPlay.probability`, when the provider includes one. */
export function lastPlayWinProbability(lastPlay: unknown, gameId: string): WinProbability | null {
  const p = obj(at(lastPlay, 'probability'));
  const home = num(p?.homeWinPercentage);
  if (!p || home === null || home < 0 || home > 1) return null;
  const tie = num(p.tiePercentage);
  const id = str(at(lastPlay, 'id'));
  return { home, tie: tie !== null && tie >= 0 && tie <= 1 ? tie : 0, playId: id ? `${gameId}:${id}` : null, source: WIN_PROBABILITY_SOURCE };
}

/** The pre-game matchup predictor, when both sides are reported for these two teams. */
export function normalizePredictor(raw: unknown, homeProviderId: string, awayProviderId: string): MatchupPredictor | null {
  const p = obj(raw);
  if (!p) return null;
  const share = (side: unknown, teamId: string) => {
    const value = num(at(side, 'gameProjection'));
    return str(at(side, 'id')) === teamId && value !== null && value >= 0 && value <= 100 ? value / 100 : null;
  };
  const home = share(p.homeTeam, homeProviderId);
  const away = share(p.awayTeam, awayProviderId);
  return home !== null && away !== null ? { home, away, source: WIN_PROBABILITY_SOURCE } : null;
}

/**
 * The same sportsbook, from ESPN's core API, which is the only place the line a
 * book is offering right now appears.
 *
 * The scoreboard and the summary report an opening line and a closing one. While
 * a game runs there is no closing line yet, so those two payloads have nothing to
 * say about the line during the game, which is exactly when it moves most. The
 * core API's odds document carries `open`, `current` and `close`, and `current`
 * is the live one: on a finished game it equals the close and differs from the
 * open, so it tracked the game and stopped.
 *
 * Shape, from documents captured on 24 September 2026 (a scheduled NFL game and a
 * finished one): the competition's own `open`/`current`/`close` carry the total
 * and the price either side of it, and each of `homeTeamOdds`/`awayTeamOdds`
 * carries that team's `pointSpread`, the price on it (`spread`) and `moneyLine`.
 * Every figure is a string under `american`; a spread reads "-4.5" and a price
 * reads "-115", which is why lines and prices are read by different parsers.
 * Teams are named by a `$ref` ending in `/teams/{id}` rather than by a plain id.
 */
function coreTeamId(side: unknown): string | null {
  const ref = str(at(side, 'team', '$ref'));
  const m = ref ? /\/teams\/(\d+)(?:[/?]|$)/.exec(ref) : null;
  return m ? m[1] : (str(at(side, 'team', 'id')) ?? null);
}

/** A line ("-4.5", "42.5", "EVEN"); never a price. */
const coreLine = (raw: unknown): number | null => lineNumber(at(raw, 'american') ?? at(raw, 'value'));

/** A price ("-115"); never a line. */
const corePrice = (raw: unknown): number | null => parseAmerican(at(raw, 'american') ?? at(raw, 'alternateDisplayValue'));

/** `current` is what the book is offering; a game already finished has only its close. */
const coreNow = (o: Record<string, unknown>) => obj(o.current) ?? obj(o.close);

function coreSpread(side: unknown): OpenLatest<LinePrice> {
  const price = (from: unknown): LinePrice | null => {
    const line = coreLine(at(from, 'pointSpread'));
    return line === null ? null : { line, odds: corePrice(at(from, 'spread')) };
  };
  const o = obj(side);
  return { open: price(o?.open), latest: price(o ? coreNow(o) : null) };
}

function coreMoneyline(side: unknown): OpenLatest<number> {
  const o = obj(side);
  return { open: corePrice(at(o?.open, 'moneyLine')), latest: corePrice(at(o ? coreNow(o) : null, 'moneyLine')) };
}

function coreTotal(entry: Record<string, unknown>, which: 'over' | 'under'): OpenLatest<LinePrice> {
  const price = (from: unknown): LinePrice | null => {
    const line = coreLine(at(from, 'total'));
    return line === null ? null : { line, odds: corePrice(at(from, which)) };
  };
  return { open: price(entry.open), latest: price(coreNow(entry)) };
}

/**
 * The first-priority sportsbook's live line from a core odds collection. As with
 * the scoreboard's lines, when the document names its teams they must be this
 * game's teams, in either order, and nothing is returned rather than a guess.
 */
export function normalizeCoreOdds(raw: unknown, homeProviderId: string, awayProviderId: string): BettingLines | null {
  const entries = arr(at(raw, 'items') ?? raw)
    .map(obj)
    .filter((e): e is Record<string, unknown> => e !== null && obj(e.provider) !== null);
  const e = entries.find((x) => num(at(x, 'provider', 'priority')) === 1) ?? entries[0];
  if (!e) return null;
  const provider = str(at(e, 'provider', 'displayName')) ?? str(at(e, 'provider', 'name'));
  if (!provider) return null;

  const homeId = coreTeamId(e.homeTeamOdds);
  const awayId = coreTeamId(e.awayTeamOdds);
  const swapped = homeId === awayProviderId && awayId === homeProviderId;
  if (!swapped && ((homeId !== null && homeId !== homeProviderId) || (awayId !== null && awayId !== awayProviderId))) return null;
  const H = swapped ? 'awayTeamOdds' : 'homeTeamOdds';
  const A = swapped ? 'homeTeamOdds' : 'awayTeamOdds';

  const spreadPairs = { home: coreSpread(e[H]), away: coreSpread(e[A]) };
  const spread = reported(spreadPairs.home) || reported(spreadPairs.away) ? spreadPairs : null;
  const moneylinePairs = { home: coreMoneyline(e[H]), away: coreMoneyline(e[A]) };
  const moneyline = reported(moneylinePairs.home) || reported(moneylinePairs.away) ? moneylinePairs : null;
  const totalPairs = { over: coreTotal(e, 'over'), under: coreTotal(e, 'under') };
  const total = reported(totalPairs.over) || reported(totalPairs.under) ? totalPairs : null;
  if (!spread && !moneyline && !total) return null;

  const homeFavorite = bool(at(e, H, 'favorite'));
  const awayFavorite = bool(at(e, A, 'favorite'));
  const homeLine = spread?.home.latest?.line ?? null;
  const favorite: Side | null =
    homeFavorite === true && awayFavorite !== true ? 'home' : awayFavorite === true && homeFavorite !== true ? 'away' : homeLine !== null && homeLine !== 0 ? (homeLine < 0 ? 'home' : 'away') : null;

  return { provider, details: str(e.details), favorite, moneyline, spread, total };
}

/**
 * The core API's URL for a game's odds. The competition id equals the event id
 * for every football game ESPN reports, which is why one id fills both places.
 */
export function coreOddsUrl(league: LeagueId, providerEventId: string): string {
  const path = league === 'nfl' ? 'nfl' : 'college-football';
  const id = encodeURIComponent(providerEventId);
  return `https://sports.core.api.espn.com/v2/sports/football/leagues/${path}/events/${id}/competitions/${id}/odds?limit=10`;
}

/**
 * The live line, with anything only the summary knew kept.
 *
 * The two documents are the same book, so this is not a choice between sources:
 * the core one is preferred because it alone knows the line right now, and the
 * summary's value stands wherever the core one reported none. It is the rule the
 * rest of the merging uses, that a figure already known does not become unknown
 * because the next report left it out.
 */
export function preferLiveLines(fromSummary: BettingLines | null, fromCore: BettingLines | null): BettingLines | null {
  if (!fromCore) return fromSummary;
  if (!fromSummary || fromSummary.provider !== fromCore.provider) return fromCore;
  const pair = <T>(core: OpenLatest<T>, summary: OpenLatest<T> | undefined): OpenLatest<T> => ({
    open: core.open ?? summary?.open ?? null,
    latest: core.latest ?? summary?.latest ?? null,
  });
  return {
    ...fromCore,
    details: fromCore.details ?? fromSummary.details,
    favorite: fromCore.favorite ?? fromSummary.favorite,
    moneyline: fromCore.moneyline ? { home: pair(fromCore.moneyline.home, fromSummary.moneyline?.home), away: pair(fromCore.moneyline.away, fromSummary.moneyline?.away) } : fromSummary.moneyline,
    spread: fromCore.spread ? { home: pair(fromCore.spread.home, fromSummary.spread?.home), away: pair(fromCore.spread.away, fromSummary.spread?.away) } : fromSummary.spread,
    total: fromCore.total ? { over: pair(fromCore.total.over, fromSummary.total?.over), under: pair(fromCore.total.under, fromSummary.total?.under) } : fromSummary.total,
  };
}

/**
 * The weather the provider reports at a venue. Every field is optional and each
 * one is read on its own, because a report that carries a temperature and no
 * condition is still worth having and a missing field is not a zero.
 */
export function normalizeWeather(raw: unknown): GameWeather | null {
  const w = obj(raw);
  if (!w) return null;
  const conditionId = num(w.conditionId) ?? (str(w.conditionId) !== null ? Number(str(w.conditionId)) : null);
  const temperature = num(w.temperature) ?? num(w.highTemperature);
  const displayValue = str(w.displayValue);
  const id = conditionId !== null && Number.isFinite(conditionId) ? conditionId : null;
  if (id === null && temperature === null && !displayValue) return null;
  return { conditionId: id, temperature, displayValue };
}
