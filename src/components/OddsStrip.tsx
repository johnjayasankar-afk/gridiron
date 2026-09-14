/**
 * One line of odds for a game card: the sportsbook's spread and total, and the
 * exchange price for the market's favorite. Shows nothing when neither is reported.
 */
import type { GameSummary, Side } from '../../shared/model';
import { formatMarketPrice, formatSpread, formatTotal } from '../../shared/odds';
import { usePrefs } from '../state/prefs';

export function OddsStrip({ game }: { game: GameSummary }) {
  const format = usePrefs((s) => s.oddsFormat);
  const lines = game.lines ?? null;
  const market = game.market ?? null;

  const homeLine = lines?.spread?.home.latest?.line ?? null;
  const favorite = lines?.favorite ?? null;
  const favoriteLine = favorite ? (lines?.spread?.[favorite].latest?.line ?? null) : null;
  const spread = homeLine === 0 ? 'PK' : favorite && favoriteLine !== null ? `${game[favorite].abbreviation} ${formatSpread(favoriteLine)}` : null;
  const total = lines?.total?.over.latest?.line ?? null;

  const moneyline = market?.moneyline ?? null;
  const leader: Side | null = moneyline ? ((moneyline.home?.price ?? 0) >= (moneyline.away?.price ?? 0) ? 'home' : 'away') : null;
  const quote = moneyline && leader ? moneyline[leader] : null;

  if (!(lines && (spread || total !== null)) && !(market && quote && leader)) return null;
  return (
    <p className="odds-strip mono">
      {lines && (spread || total !== null) && (
        <span className="odds-chip" title={lines.details ? `${lines.provider}: ${lines.details}` : lines.provider}>
          <span className="odds-src">{lines.provider}</span>
          {spread && <span>{spread}</span>}
          {total !== null && <span>O/U {formatTotal(total)}</span>}
        </span>
      )}
      {market && quote && leader && (
        <span className={`odds-chip is-market${market.stale ? ' is-stale' : ''}`} title={`${market.source}: ${game[leader].displayName} to win${market.stale ? '. These prices may be out of date.' : ''}`}>
          <span className="odds-src">{market.source}</span>
          <span>
            {game[leader].abbreviation} {formatMarketPrice(quote.price, format)}
          </span>
        </span>
      )}
    </p>
  );
}
