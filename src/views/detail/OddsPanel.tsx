/**
 * The game page's odds panel: ESPN's win probability after the latest play (or the play
 * being inspected), its matchup predictor before kickoff, the sportsbook lines ESPN
 * reports, Kalshi prices, and how the home team's Kalshi price has moved. Every figure
 * is reported, or a direct conversion of one; the format only changes how odds are written.
 */
import { lineAtPlay, lineHeading, lineTrack, type LineAtPlay, type LineTrack } from '../../../shared/lineHistory';
import { formatCents, priceAtPlay, priceSummary, type PriceAtPlay } from '../../../shared/marketHistory';
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

/*
 * The live figures light for a moment when the book moves one, keyed on the
 * value so the animation runs when the value changed and not when the table
 * happened to render. It is the same treatment the exchange's price has, and it
 * is only worth having now that the line moves during a game: before there was a
 * live line to read, these numbers changed twice, at the open and at the close.
 */
function OddsCell({ pair, format }: { pair: OpenLatest<number>; format: OddsFormat }) {
  if (pair.latest === null && pair.open === null) return <span className="odds-off">Off</span>;
  return (
    <>
      <span key={pair.latest ?? 'off'} className="odds-now is-fresh">
        {pair.latest !== null ? formatBookOdds(pair.latest, format) : 'Off'}
      </span>{' '}
      {pair.open !== null && pair.open !== pair.latest && <span className="odds-open">Open {formatBookOdds(pair.open, format)}</span>}
    </>
  );
}

/**
 * One figure as the book had it when a play happened, and what it had been
 * before that. No "open" here: the rewound table is about the line standing at a
 * moment, and the opening line is somewhere further back in the same record.
 */
function AtCell({ value, was }: { value: string | null; was: string | null }) {
  if (value === null) return <span className="odds-off">Off</span>;
  return (
    <>
      <span className="odds-now">{value}</span>{' '}
      {was !== null && was !== value && <span className="odds-open">Was {was}</span>}
    </>
  );
}

/**
 * The book's line as the record has it at the play being looked at. Same rows as
 * the live table, so the block does not change shape as you scrub; only the
 * figures and the heading above them do.
 */
function AtLineRows({ at, format }: { at: LineAtPlay; format: OddsFormat }) {
  const now = at.point;
  const was = at.before;
  const odds = (n: number) => formatBookOdds(n, format);
  const priced = (line: number | null, price: number | null, write: (n: number) => string) => (line === null ? null : `${write(line)}${price === null ? '' : ` ${odds(price)}`}`);
  return (
    <tbody>
      {(now.spreadHome !== null || now.spreadAway !== null) && (
        <tr>
          <th scope="row">Spread</th>
          <td>
            <AtCell value={priced(now.spreadAway, now.spreadOddsAway, formatSpread)} was={priced(was?.spreadAway ?? null, was?.spreadOddsAway ?? null, formatSpread)} />
          </td>
          <td>
            <AtCell value={priced(now.spreadHome, now.spreadOddsHome, formatSpread)} was={priced(was?.spreadHome ?? null, was?.spreadOddsHome ?? null, formatSpread)} />
          </td>
        </tr>
      )}
      {(now.moneylineAway !== null || now.moneylineHome !== null) && (
        <tr>
          <th scope="row">Moneyline</th>
          <td>
            <AtCell value={now.moneylineAway === null ? null : odds(now.moneylineAway)} was={was?.moneylineAway == null ? null : odds(was.moneylineAway)} />
          </td>
          <td>
            <AtCell value={now.moneylineHome === null ? null : odds(now.moneylineHome)} was={was?.moneylineHome == null ? null : odds(was.moneylineHome)} />
          </td>
        </tr>
      )}
      {now.total !== null && (
        <tr>
          <th scope="row">Total</th>
          <td>
            <AtCell value={priced(now.total, now.totalOddsOver, (n) => `O ${formatTotal(n)}`)} was={priced(was?.total ?? null, was?.totalOddsOver ?? null, (n) => `O ${formatTotal(n)}`)} />
          </td>
          <td>
            <AtCell value={priced(now.total, now.totalOddsUnder, (n) => `U ${formatTotal(n)}`)} was={priced(was?.total ?? null, was?.totalOddsUnder ?? null, (n) => `U ${formatTotal(n)}`)} />
          </td>
        </tr>
      )}
    </tbody>
  );
}

function LineCell({ pair, format, write }: { pair: OpenLatest<LinePrice>; format: OddsFormat; write: (line: number) => string }) {
  const now = pair.latest;
  const open = pair.open;
  if (!now && !open) return <span className="odds-off">Off</span>;
  return (
    <>
      {now ? (
        <span key={`${now.line}|${now.odds}`} className="odds-now is-fresh">
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

/**
 * How the book's own line has moved, from Gridiron's recording of it.
 *
 * A step line, not a sloped one, for the same reason the tape's ribbon steps: a
 * book posts a line and it stands until the book posts another, so the space
 * between two readings is a line held rather than a line travelling. The reading
 * itself is marked, so you can see how often the book actually moved and not
 * only where it ended up.
 */
const MARKS_LEGIBLE_UP_TO = 24;

function LineSpark({ track, kickoff, w = 120, h = 30 }: { track: LineTrack; kickoff: string | null; w?: number; h?: number }) {
  const pad = 3;
  const points = track.points;
  const t0 = Date.parse(points[0].at);
  const t1 = Date.parse(points[points.length - 1].at);
  const span = Math.max(1, t1 - t0);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    low = Math.min(low, p.value);
    high = Math.max(high, p.value);
  }
  // At least a point of range either side, so a half point move is not drawn as a cliff.
  const middle = (low + high) / 2;
  const half = Math.max(1, (high - low) / 2) + 0.25;
  const X = (at: number) => pad + ((at - t0) / span) * (w - pad * 2);
  const Y = (value: number) => pad + (1 - (value - (middle - half)) / (2 * half)) * (h - pad * 2);
  const steps: string[] = [];
  points.forEach((p, i) => {
    const x = X(Date.parse(p.at)).toFixed(1);
    if (i > 0) steps.push(`L${x},${Y(points[i - 1].value).toFixed(1)}`);
    steps.push(`${i === 0 ? 'M' : 'L'}${x},${Y(p.value).toFixed(1)}`);
  });
  // The line holds from the last reading to now, so it runs to the right edge.
  steps.push(`L${(w - pad).toFixed(1)},${Y(track.last).toFixed(1)}`);
  const kick = kickoff ? Date.parse(kickoff) : Number.NaN;
  return (
    <svg className="odds-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      {middle - half < 0 && middle + half > 0 && <line className="odds-spark-mid" x1={pad} x2={w - pad} y1={Y(0)} y2={Y(0)} />}
      {kick > t0 && kick < t1 && <line className="odds-spark-kick" x1={X(kick)} x2={X(kick)} y1={pad} y2={h - pad} />}
      <path className="odds-spark-line" d={steps.join('')} />
      {/*
        A mark per reading, while they can still be told apart. Past that they
        would be a smear across a 120 pixel line and the marks are redundant
        anyway: the step line already turns a corner at every reading, which is
        the same information drawn by the line itself.
      */}
      {points.length <= MARKS_LEGIBLE_UP_TO &&
        points.map((p, i) => <circle key={i} className="odds-spark-step" cx={X(Date.parse(p.at))} cy={Y(p.value)} r={1.4} />)}
      <circle className="odds-spark-end" cx={w - pad} cy={Y(track.last)} r={2.5} />
    </svg>
  );
}

/**
 * The book's line over the record, with how far it has come.
 *
 * It is drawn only where there is a record with movement in it, which means a
 * game Gridiron was watching while the book moved. A game it was not watching
 * has no trend rather than a flat one, because a flat trend claims the book
 * stood still when the truth is that nobody looked.
 */
function LineTrend({ game, track, figure, at }: { game: GameSummary; track: LineTrack; figure: 'spreadHome' | 'total'; at?: LineAtPlay | null }) {
  const side: Side = track.last <= 0 ? 'home' : 'away';
  /*
   * Which way it went, named. For a spread that is the team getting shorter; for
   * a total it is simply up or down, because a total moving toward a team is not
   * a thing.
   */
  const toward = figure === 'total' ? (track.change < 0 ? 'down' : 'up') : track.change < 0 ? game.home.abbreviation : game.away.abbreviation;
  const points = Math.abs(track.change);
  const written = points % 1 === 0 ? String(points) : points.toFixed(1);
  return (
    <div className="odds-trend">
      <LineSpark track={track} kickoff={game.startTime} />
      <p className="odds-trend-text">
        {figure === 'total' ? (
          <>
            <span className="odds-label">Total</span>{' '}
            <span key={track.last} className="odds-now is-fresh">
              {formatTotal(track.last)}
            </span>
          </>
        ) : /* A spread of zero is not a team favoured by nothing, it is a pick'em, and the book says so. */ track.last === 0 ? (
          <span key="pk" className="odds-now is-fresh">
            Pick&apos;em
          </span>
        ) : (
          <>
            <span className="odds-label">{game[side].abbreviation} by</span>{' '}
            <span key={track.last} className="odds-now is-fresh">
              {formatTotal(Math.abs(track.last))}
            </span>
          </>
        )}{' '}
        {/*
          No up or down colour on a line move. A price going up is good for
          whoever holds it; a spread moving toward a team is neither good nor
          bad, it is a direction, and colouring it would be the page taking a
          side the book did not.
        */}
        <span className="odds-move">
          {figure === 'total' ? `${written} ${toward}` : `${written} toward ${toward}`}
          {at ? ' by this play' : ` from ${figure !== 'total' && track.first === 0 ? "pick'em" : formatTotal(Math.abs(track.first))}`}
        </span>
      </p>
    </div>
  );
}

/** How the home team's contract has moved: over the recorded week before kickoff, or from an hour before kickoff once the game has started. */
function PriceTrend({ game, history, at }: { game: GameSummary; history: MarketHistory; at?: PriceAtPlay | null }) {
  const kickoff = game.startTime ? Date.parse(game.startTime) : Number.NaN;
  const started = game.status.kind !== 'scheduled' && Number.isFinite(kickoff);
  /*
   * While a play is being looked at, the line stops there. Everything else on the
   * page is as of that play, and a line running on to the latest price under a
   * heading that says "at this play" is the market saying two things at once.
   */
  const until = at ? Date.parse(at.at) : Number.POSITIVE_INFINITY;
  const points = history.points.filter((p) => {
    const t = Date.parse(p.at);
    return (!started || t >= kickoff - HOUR) && t <= until;
  });
  const summary = priceSummary({ ...history, points });
  if (!summary) return null;
  const team = game[at ? at.team : 'home'];
  const flat = Math.abs(summary.change) < 0.0005;
  const move = flat ? 'Unchanged' : `${summary.change > 0 ? '+' : '−'}${formatCents(Math.abs(summary.change))}`;
  const onPlay = at && at.swing !== null && Math.abs(at.swing) >= 0.005 ? `${at.swing > 0 ? '+' : '−'}${formatCents(Math.abs(at.swing))} on this play` : at ? 'Unchanged on this play' : null;
  return (
    <div className="odds-trend">
      <PriceSpark points={points} kickoff={game.startTime} />
      <p className="odds-trend-text">
        <span className="odds-label">{team.abbreviation} to win</span>{' '}
        {/*
          Cents, whichever format the odds tables are in: this line is about how
          the price moved, and a move is in cents. Keyed on the value so a new
          one lights briefly as it arrives; the number itself never counts up
          through figures the exchange did not record.
        */}
        <span key={formatCents(at ? at.price : summary.last.price)} className="odds-now is-fresh">
          {formatCents(at ? at.price : summary.last.price)}
        </span>{' '}
        {onPlay ? (
          <span className={`odds-move${at!.swing && at!.swing > 0 ? ' is-up' : at!.swing ? ' is-down' : ''}`}>{onPlay}</span>
        ) : (
          <span className="odds-move">
            {move} since {sinceLabel(summary.first.at)}
          </span>
        )}
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
  // The market as it stood at the play being looked at, from the exchange's own record.
  const atMarket = frame && detail ? priceAtPlay(detail, frame.play.id) : null;
  const atLine = frame && detail ? lineAtPlay(detail, frame.play.id) : null;
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
  /*
   * The provider reports an opening line and a latest one and nothing in
   * between, so Gridiron keeps its own record of every line it is told and when
   * it was told it (see shared/lineHistory). While a play is being looked at,
   * that record is rewound to it, the same as the exchange price beside it.
   * Where the record has nothing to say about that moment the block says so,
   * rather than showing today's line under a heading about a play.
   */
  const when = lineHeading(atLine, { inspecting: !!frame, recorded: (detail?.lineHistory?.points.length ?? 0) > 0, replay, final, live });
  const result = final && lines && !frame ? againstTheLines(game, lines) : [];
  /*
   * The book's line over the record. While a play is being looked at it stops
   * there, as the exchange's trend does, so the whole block is one moment.
   */
  /*
   * The figure that actually moved, the spread first because it is the line most
   * people mean. A real recording from a live game showed why this cannot be the
   * spread alone: over one evening at Lambeau the handicap never budged off 4.5
   * while the total went 42.5 to 43.5 and the moneyline came in seven points.
   * Drawing only the spread would have shown nothing at all and called it a
   * book standing still.
   */
  const until = atLine ? Date.parse(atLine.point.at) : undefined;
  const spread = lineTrack(detail?.lineHistory, 'spreadHome', until);
  const moved: { track: LineTrack; figure: 'spreadHome' | 'total' } | null = spread ? { track: spread, figure: 'spreadHome' } : (() => {
    const total = lineTrack(detail?.lineHistory, 'total', until);
    return total ? { track: total, figure: 'total' as const } : null;
  })();

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
            {atLine ? (
              <AtLineRows at={atLine} format={format} />
            ) : (
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
            )}
          </table>
          {/* How the book's own line has moved, from the record, cut at the play being looked at the same way the exchange's trend is. */}
          {moved && <LineTrend game={game} track={moved.track} figure={moved.figure} at={atLine} />}
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
            <span>{atMarket ? 'As traded at this play' : replay ? 'As traded, captured each minute' : market.stale ? 'Prices may be out of date' : 'Live market prices'}</span>
          </p>
          {atMarket && (market.spread || market.total) && <p className="odds-note">Only the to win price was recorded through the game.</p>}
          {!atMarket && (
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
          )}
          {history && <PriceTrend game={game} history={history} at={atMarket} />}
        </div>
      ) : history && final ? (
        <div className="odds-block is-market">
          <p className="odds-block-head">
            <span className="odds-src">{history.source}</span>
            <span>{atMarket ? 'As traded at this play' : history.captured ? 'During the game, as captured' : 'During the game'}</span>
          </p>
          <PriceTrend game={game} history={history} at={atMarket} />
        </div>
      ) : replay && (live || scheduled) ? (
        <p className="odds-note">No Kalshi prices were captured for this game.</p>
      ) : null}

      <p className="odds-foot">{GAMBLING_NOTE}</p>
    </section>
  );
}
