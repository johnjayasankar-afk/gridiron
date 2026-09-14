/**
 * The game page's odds panel: ESPN's win probability after the latest play (or the play
 * being inspected), its matchup predictor before kickoff, the sportsbook lines ESPN
 * reports, Kalshi prices, and how the home team's Kalshi price has moved. Every figure
 * is reported, or a direct conversion of one; the format only changes how odds are written.
 */
import { formatCents, priceSummary } from '../../../shared/marketHistory';
import type { BettingLines, GameDetail, GameSummary, LinePrice, MarketHistory, MarketQuote, OpenLatest, Side } from '../../../shared/model';
import { isLiveOrPaused } from '../../../shared/model';
import { formatBookOdds, formatChance, formatMarketPrice, formatSpread, formatSwing, formatTotal, type OddsFormat } from '../../../shared/odds';
import type { PlayFrame } from '../../../shared/replayFrames';
import { currentWinProbability, lastSwing, probabilityAtPlay } from '../../../shared/winProbability';
import { Segmented } from '../../components/controls';
import { GAMBLING_NOTE, ODDS_FORMATS } from '../../components/OddsSettings';
import { WinProbabilityMeter } from '../../components/WinProbabilityMeter';
import { usePrefs } from '../../state/prefs';

const other = (side: Side): Side => (side === 'home' ? 'away' : 'home');
const HOUR = 3_600_000;

/** When a price trend starts: a time today, a weekday and time within the week, otherwise a date and time. */
function sinceLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (new Date(now).toDateString() === d.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  if (now - d.getTime() < 6 * 24 * HOUR) return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(d);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

function OddsCell({ pair, format }: { pair: OpenLatest<number>; format: OddsFormat }) {
  if (pair.latest === null && pair.open === null) return <span className="odds-off">Off</span>;
  return (
    <>
      <span className="odds-now">{pair.latest !== null ? formatBookOdds(pair.latest, format) : 'Off'}</span>{' '}
      {pair.open !== null && pair.open !== pair.latest && <span className="odds-open">Open {formatBookOdds(pair.open, format)}</span>}
    </>
  );
}

function LineCell({ pair, format, write }: { pair: OpenLatest<LinePrice>; format: OddsFormat; write: (line: number) => string }) {
  const now = pair.latest;
  const open = pair.open;
  if (!now && !open) return <span className="odds-off">Off</span>;
  return (
    <>
      {now ? (
        <span className="odds-now">
          {write(now.line)}
          {now.odds !== null && (
            <>
              {' '}
              <span className="odds-price">{formatBookOdds(now.odds, format)}</span>
            </>
          )}
        </span>
      ) : (
        <span className="odds-off">Off</span>
      )}{' '}
      {open && (open.line !== now?.line || open.odds !== now?.odds) && (
        <span className="odds-open">
          Open {write(open.line)}
          {open.odds !== null ? ` ${formatBookOdds(open.odds, format)}` : ''}
        </span>
      )}
    </>
  );
}

function QuoteCell({ quote, format }: { quote: MarketQuote | null; format: OddsFormat }) {
  if (!quote) return <span className="odds-off">No price</span>;
  const book = [quote.bid !== null ? `Bid ${formatChance(quote.bid)}` : null, quote.ask !== null ? `ask ${formatChance(quote.ask)}` : null, quote.last !== null ? `last trade ${formatChance(quote.last)}` : null].filter(Boolean).join(', ');
  return (
    <span className="odds-now" title={book || undefined}>
      {formatMarketPrice(quote.price, format)}
    </span>
  );
}

/** A contract's price across the window shown, with kickoff marked. Decorative: the text beside it says the same. */
function PriceSpark({ points, kickoff }: { points: MarketHistory['points']; kickoff: string | null }) {
  const w = 132;
  const h = 34;
  const pad = 3;
  const t0 = Date.parse(points[0].at);
  const t1 = Date.parse(points[points.length - 1].at);
  const span = Math.max(1, t1 - t0);
  let low = 1;
  let high = 0;
  for (const p of points) {
    low = Math.min(low, p.price);
    high = Math.max(high, p.price);
  }
  // At least a ten cent range, so a small move is not drawn as a cliff.
  const middle = (low + high) / 2;
  const half = Math.max(0.05, (high - low) / 2) + 0.01;
  const lo = Math.max(0, middle - half);
  const hi = Math.min(1, middle + half);
  const X = (t: number) => pad + ((t - t0) / span) * (w - pad * 2);
  const Y = (price: number) => pad + (1 - (price - lo) / Math.max(0.01, hi - lo)) * (h - pad * 2);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(Date.parse(p.at)).toFixed(1)},${Y(p.price).toFixed(1)}`).join('');
  const kick = kickoff ? Date.parse(kickoff) : Number.NaN;
  const last = points[points.length - 1];
  return (
    <svg className="odds-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      {lo < 0.5 && hi > 0.5 && <line className="odds-spark-mid" x1={pad} x2={w - pad} y1={Y(0.5)} y2={Y(0.5)} />}
      {kick > t0 && kick < t1 && <line className="odds-spark-kick" x1={X(kick)} x2={X(kick)} y1={pad} y2={h - pad} />}
      <path className="odds-spark-line" d={line} />
      <circle className="odds-spark-end" cx={X(Date.parse(last.at))} cy={Y(last.price)} r={2.5} />
    </svg>
  );
}

/** How the home team's contract has moved: over the recorded week before kickoff, or from an hour before kickoff once the game has started. */
function PriceTrend({ game, history }: { game: GameSummary; history: MarketHistory }) {
  const kickoff = game.startTime ? Date.parse(game.startTime) : Number.NaN;
  const started = game.status.kind !== 'scheduled' && Number.isFinite(kickoff);
  const points = started ? history.points.filter((p) => Date.parse(p.at) >= kickoff - HOUR) : history.points;
  const summary = priceSummary({ ...history, points });
  if (!summary) return null;
  const flat = Math.abs(summary.change) < 0.0005;
  const move = flat ? 'Unchanged' : `${summary.change > 0 ? '+' : '−'}${formatCents(Math.abs(summary.change))}`;
  return (
    <div className="odds-trend">
      <PriceSpark points={points} kickoff={game.startTime} />
      <p className="odds-trend-text">
        <span className="odds-label">{game.home.abbreviation} to win</span>{' '}
        <span className="odds-now">{formatCents(summary.last.price)}</span>{' '}
        <span className="odds-move">
          {move} since {sinceLabel(summary.first.at)}
        </span>
      </p>
    </div>
  );
}

/** How the final score compared with the closing lines. */
function againstTheLines(game: GameSummary, lines: BettingLines): string[] {
  const { home, away } = game.score;
  if (home === null || away === null) return [];
  const out: string[] = [];
  const favorite = lines.favorite;
  const favoriteLine = favorite ? (lines.spread?.[favorite].latest?.line ?? null) : null;
  if (favorite && favoriteLine !== null) {
    const result = (favorite === 'home' ? home - away : away - home) + favoriteLine;
    const underdog = other(favorite);
    out.push(result > 0 ? `${game[favorite].abbreviation} covered ${formatSpread(favoriteLine)}` : result < 0 ? `${game[underdog].abbreviation} covered ${formatSpread(-favoriteLine)}` : `Push at ${formatSpread(favoriteLine)}`);
  }
  const total = lines.total?.over.latest?.line ?? null;
  if (total !== null) {
    const points = home + away;
    out.push(points > total ? `Over ${formatTotal(total)}, ${points} points` : points < total ? `Under ${formatTotal(total)}, ${points} points` : `Push at ${formatTotal(total)}`);
  }
  return out;
}

export function OddsPanel({ game, detail, frame, replay }: { game: GameSummary; detail: GameDetail | null; frame: PlayFrame | null; replay: boolean }) {
  const showOdds = usePrefs((s) => s.showOdds);
  const format = usePrefs((s) => s.oddsFormat);
  if (!showOdds) return null;
  const live = isLiveOrPaused(game.status.kind);
  const final = game.status.kind === 'final';
  const scheduled = game.status.kind === 'scheduled';
  const atPlay = frame && detail ? probabilityAtPlay(detail, frame.play.id) : null;
  const latest = live ? currentWinProbability(game, detail) : null;
  const swing = atPlay ? atPlay.swing : latest ? lastSwing(detail) : null;
  const predictor = scheduled ? (game.predictor ?? null) : null;
  const lines = game.lines ?? null;
  const market = game.market ?? null;
  const history = detail?.marketHistory ?? null;
  const showWinProbability = !!(atPlay || latest || predictor);
  if (!showWinProbability && !lines && !market && !history) return null;

  const swingText = swing !== null && Math.abs(swing) >= 0.005 ? `${(swing > 0 ? game.home : game.away).abbreviation} ${formatSwing(Math.abs(swing))} on ${atPlay ? 'this play' : 'the latest play'}` : null;
  const note = atPlay
    ? `ESPN win probability after this play${swingText ? `: ${swingText}` : ''}.`
    : latest
      ? `ESPN win probability after the latest play${swingText ? `: ${swingText}` : ''}.`
      : predictor
        ? `ESPN matchup predictor before kickoff: ${game.away.abbreviation} ${formatChance(predictor.away)}, ${game.home.abbreviation} ${formatChance(predictor.home)}.`
        : null;
  const when = replay ? 'Closing lines, as captured' : final ? 'Closing lines' : live ? 'Latest lines reported' : 'Current lines';
  const result = final && lines ? againstTheLines(game, lines) : [];

  return (
    <section className="panel odds-panel" aria-label="Odds and win probability">
      <header className="odds-head">
        <p className="eyebrow">Odds and win probability</p>
        {(lines || market) && <Segmented<OddsFormat> className="odds-format" label="Odds format" value={format} options={ODDS_FORMATS} onChange={(v) => usePrefs.getState().set({ oddsFormat: v })} />}
      </header>

      {showWinProbability && (
        <div className="odds-wp">
          <WinProbabilityMeter game={game} detail={detail} size="large" at={atPlay ? { home: atPlay.home, tie: atPlay.tie } : null} />
          {note && <p className="odds-note">{note}</p>}
        </div>
      )}

      {lines && (
        <div className="odds-block">
          <p className="odds-block-head">
            <span className="odds-src">{lines.provider}</span>
            <span>{when}</span>
          </p>
          <table className="odds-table">
            <caption className="sr-only">{`${lines.provider}: ${when}`}</caption>
            <thead>
              <tr>
                <td />
                <th scope="col">{game.away.abbreviation}</th>
                <th scope="col">{game.home.abbreviation}</th>
              </tr>
            </thead>
            <tbody>
              {lines.spread && (
                <tr>
                  <th scope="row">Spread</th>
                  <td>
                    <LineCell pair={lines.spread.away} format={format} write={formatSpread} />
                  </td>
                  <td>
                    <LineCell pair={lines.spread.home} format={format} write={formatSpread} />
                  </td>
                </tr>
              )}
              {lines.moneyline && (
                <tr>
                  <th scope="row">Moneyline</th>
                  <td>
                    <OddsCell pair={lines.moneyline.away} format={format} />
                  </td>
                  <td>
                    <OddsCell pair={lines.moneyline.home} format={format} />
                  </td>
                </tr>
              )}
              {lines.total && (
                <tr>
                  <th scope="row">Total</th>
                  <td>
                    <LineCell pair={lines.total.over} format={format} write={(line) => `O ${formatTotal(line)}`} />
                  </td>
                  <td>
                    <LineCell pair={lines.total.under} format={format} write={(line) => `U ${formatTotal(line)}`} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {result.length > 0 && (
            <p className="odds-result">
              {result.map((r) => (
                <span key={r} className="odds-chip">
                  {r}
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {market ? (
        <div className={`odds-block is-market${market.stale ? ' is-stale' : ''}`}>
          <p className="odds-block-head">
            <span className="odds-src">{market.source}</span>
            <span>{replay ? 'As traded, captured each minute' : market.stale ? 'Prices may be out of date' : 'Live market prices'}</span>
          </p>
          <table className="odds-table">
            <caption className="sr-only">{`${market.source} prices`}</caption>
            {market.moneyline && (
              <thead>
                <tr>
                  <td />
                  <th scope="col">{game.away.abbreviation}</th>
                  <th scope="col">{game.home.abbreviation}</th>
                </tr>
              </thead>
            )}
            <tbody>
              {market.moneyline && (
                <tr>
                  <th scope="row">To win</th>
                  <td>
                    <QuoteCell quote={market.moneyline.away} format={format} />
                  </td>
                  <td>
                    <QuoteCell quote={market.moneyline.home} format={format} />
                  </td>
                </tr>
              )}
              {market.spread && (
                <tr>
                  <th scope="row">Spread</th>
                  <td colSpan={2}>
                    <span className="odds-label">
                      {game[market.spread.team].abbreviation} by more than {formatTotal(market.spread.line)}
                    </span>{' '}
                    <QuoteCell quote={market.spread.quote} format={format} />
                  </td>
                </tr>
              )}
              {market.total && (
                <tr>
                  <th scope="row">Total</th>
                  <td colSpan={2}>
                    <span className="odds-label">Over {formatTotal(market.total.line)} points</span> <QuoteCell quote={market.total.over} format={format} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {history && <PriceTrend game={game} history={history} />}
        </div>
      ) : history && final ? (
        <div className="odds-block is-market">
          <p className="odds-block-head">
            <span className="odds-src">{history.source}</span>
            <span>{history.captured ? 'During the game, as captured' : 'During the game'}</span>
          </p>
          <PriceTrend game={game} history={history} />
        </div>
      ) : replay && (live || scheduled) ? (
        <p className="odds-note">No Kalshi prices were captured for this game.</p>
      ) : null}

      <p className="odds-foot">{GAMBLING_NOTE}</p>
    </section>
  );
}
