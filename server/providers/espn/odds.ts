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
import type { BettingLines, LinePrice, MatchupPredictor, OpenLatest, Side, WinProbability, WinProbabilityPoint } from '../../../shared/model.js';
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
