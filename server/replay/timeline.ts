/**
 * Replay timelines.
 *
 * A captured game summary lists every reported play with the wall-clock time
 * ESPN logged it. A timeline answers "what would the provider have been showing
 * at virtual time T?" by cutting that summary at T and rebuilding the two
 * documents the live provider returns: a scoreboard event and a game summary,
 * in ESPN's own shape. Those documents then go through exactly the same
 * normalization, engine, alerts and rendering as live data.
 *
 * What is reconstructed, and how:
 * - Visible plays: those logged at or before T.
 * - Score: the reported score on the last visible play.
 * - Status: scheduled before the first play; halftime after the provider's
 *   "End of Half" play; end of period after "End Period"; final after
 *   "End of Game"; otherwise in progress with the last play's reported clock.
 * - Situation: the end state of the last visible snap, as reported.
 * - A drive still in progress keeps its plays but loses the summary fields that
 *   describe its outcome, so the replay cannot leak the future.
 * - Team stats appear only once the game is final (intermediate totals were
 *   never reported); records and the winner flag are removed.
 * - Win probability is cut at T like the plays: the reported values for visible
 *   plays only. The sportsbook lines were captured after the game, so they are the
 *   closing lines and appear throughout.
 * - Kalshi prices, where they were captured minute by minute, are cut at T too:
 *   each contract's latest recorded minute, and the price history up to T. Like
 *   live prices, they end when the game does.
 * Score-only games have no play-by-play; they appear with their reported final
 * state throughout, and the scenario says so.
 */
import { pricePoints, type PriceCandle } from '../../shared/marketHistory.js';
import type { BettingLines, Division, LeagueId, LineHistory, LinePoint, LinePrice, MarketHistory, MarketPrices, MarketQuote } from '../../shared/model.js';
import { quotePrice } from '../../shared/odds.js';

type Raw = Record<string, any>;

export interface TimelinePlay {
  raw: Raw;
  drive: number;
  index: number;
  t: number;
}

export type TimelineEdit =
  /** Test scenario: a play is revised at a later time; later plays' scores shift by `scoreDelta`. */
  | { kind: 'revise'; at: number; playId: string; patch: (raw: Raw) => Raw; scoreDelta: { home: number; away: number } }
  /** Test scenario: plays logged in [from, until) are withheld and arrive together at `until`. */
  | { kind: 'hold'; from: number; until: number }
  /** Test scenario: plays logged in [from, until) lose their reported spot. */
  | { kind: 'strip-spot'; from: number; until: number }
  /** Test scenario: every play gets a lateral position estimated from its description (see lateral.ts). */
  | { kind: 'synthetic-lateral' };

/** One team's contract to win, captured minute by minute (scripts/capture-kalshi.ts), oldest first. */
export interface CapturedContract {
  ticker: string;
  candles: PriceCandle[];
}

/** A game's captured exchange contracts. */
export interface CapturedMarket {
  source: string;
  event: string;
  home: CapturedContract | null;
  away: CapturedContract | null;
}

export interface GameTimeline {
  id: string;
  league: LeagueId;
  providerEventId: string;
  divisions: Division[];
  event: Raw;
  summary: Raw;
  plays: TimelinePlay[];
  kickoffAt: number;
  endAt: number;
  scoreOnly: boolean;
  edits: TimelineEdit[];
  /** Exchange prices captured for this game, attached for real replays only. */
  market: CapturedMarket | null;
  /**
   * The sportsbook's line as Gridiron recorded it while this game ran.
   *
   * The provider reports an opening line and a closing one and nothing between,
   * and has no endpoint that says what a line was at a past moment: the core
   * API's own movement collection exists and is always empty. So unlike the
   * exchange, whose history can be asked for after the fact, a book's line can
   * only be known for a game somebody was watching at the time. A scenario
   * captured before Gridiron recorded one simply has none, and says so.
   */
  lines: CapturedLines | null;
}

const STOPPAGE = /timeout|two-minute|end period|end of |coin toss/i;

export function buildTimeline(league: LeagueId, event: Raw, summary: Raw, divisions: Division[]): GameTimeline {
  const drives: Raw[] = summary.drives?.previous ?? [];
  const plays: TimelinePlay[] = [];
  let last = Number.NaN;
  let index = 0;
  drives.forEach((d, drive) => {
    for (const raw of d.plays ?? []) {
      const parsed = Date.parse(raw.wallclock);
      const t = Number.isFinite(parsed) ? parsed : last;
      plays.push({ raw, drive, index: index++, t });
      if (Number.isFinite(t)) last = t;
    }
  });
  const firstKnown = plays.find((p) => Number.isFinite(p.t))?.t;
  const scheduled = Date.parse(event.competitions?.[0]?.date ?? event.date);
  for (const p of plays) if (!Number.isFinite(p.t)) p.t = firstKnown ?? scheduled;
  const scoreOnly = plays.length === 0;
  const kickoffAt = scoreOnly ? scheduled : Math.min(...plays.map((p) => p.t));
  const endPlay = [...plays].reverse().find((p) => /end of game/i.test(p.raw.type?.text ?? ''));
  const endAt = scoreOnly ? Number.NEGATIVE_INFINITY : endPlay ? endPlay.t : Math.max(...plays.map((p) => p.t)) + 5 * 60_000;
  return { id: `${league}-${event.id}`, league, providerEventId: String(event.id), divisions, event, summary, plays, kickoffAt, endAt, scoreOnly, edits: [], market: null, lines: null };
}

/** The line a book was offering, as Gridiron saw it, each reading stamped with when it was seen. */
export interface CapturedLines {
  provider: string;
  points: LinePoint[];
}

/** The last reading taken at or before virtual time `tv`, which is the line that stood then. */
function lineAt(tl: GameTimeline, tv: number): LinePoint | null {
  let found: LinePoint | null = null;
  for (const point of tl.lines?.points ?? []) {
    const at = Date.parse(point.at);
    if (!Number.isFinite(at)) continue;
    if (at > tv) break;
    found = point;
  }
  return found;
}

/**
 * The book's line as a live reader would have seen it at virtual time `tv`,
 * shaped back into the model the page draws. The opening line is the first
 * reading recorded, because that is the earliest the record can speak to, and
 * `latest` is the reading standing now. Nothing before the first reading, as
 * live: a replay wound back before Gridiron started watching has no line.
 */
export function linesAt(tl: GameTimeline, tv: number): BettingLines | null {
  const now = lineAt(tl, tv);
  if (!tl.lines || !now) return null;
  const first = tl.lines.points[0];
  const price = (line: number | null, odds: number | null): LinePrice | null => (line === null ? null : { line, odds });
  const spread =
    now.spreadHome === null && now.spreadAway === null
      ? null
      : {
          home: { open: price(first.spreadHome, first.spreadOddsHome), latest: price(now.spreadHome, now.spreadOddsHome) },
          away: { open: price(first.spreadAway, first.spreadOddsAway), latest: price(now.spreadAway, now.spreadOddsAway) },
        };
  const moneyline = now.moneylineHome === null && now.moneylineAway === null ? null : { home: { open: first.moneylineHome, latest: now.moneylineHome }, away: { open: first.moneylineAway, latest: now.moneylineAway } };
  const total =
    now.total === null
      ? null
      : {
          over: { open: price(first.total, first.totalOddsOver), latest: price(now.total, now.totalOddsOver) },
          under: { open: price(first.total, first.totalOddsUnder), latest: price(now.total, now.totalOddsUnder) },
        };
  if (!spread && !moneyline && !total) return null;
  const homeLine = now.spreadHome;
  return { provider: tl.lines.provider, details: null, favorite: homeLine !== null && homeLine !== 0 ? (homeLine < 0 ? 'home' : 'away') : null, spread, moneyline, total };
}

/** The recorded line up to virtual time `tv`, so a replay rewinds it exactly as a live session does. */
export function lineHistoryAt(tl: GameTimeline, tv: number): LineHistory | null {
  if (!tl.lines) return null;
  const points = tl.lines.points.filter((p) => {
    const at = Date.parse(p.at);
    return Number.isFinite(at) && at <= tv;
  });
  return points.length ? { provider: tl.lines.provider, points, captured: true } : null;
}

/** A contract's order book at the end of the latest minute recorded by `tv`, with its most recent trade by then. */
function bookAt(contract: CapturedContract | null, tv: number): PriceCandle | null {
  if (!contract) return null;
  let book: PriceCandle | null = null;
  let last: number | null = null;
  for (const c of contract.candles) {
    if (c[0] * 1000 > tv) break;
    book = c;
    if (c[3] !== null) last = c[3];
  }
  return book ? [book[0], book[1], book[2], last] : null;
}

function quoteFrom(book: PriceCandle | null): MarketQuote | null {
  if (!book) return null;
  const [, bid, ask, last] = book;
  const price = quotePrice(bid, ask, last);
  if (price === null) return null;
  return { price, bid: bid !== null && bid > 0 ? bid : null, ask: ask !== null && ask > 0 ? ask : null, last: last !== null && last > 0 ? last : null };
}

/**
 * The captured prices a live reader would have shown at virtual time `tv`: each team's contract
 * as of its latest recorded minute. None before the first capture, and none once the game is
 * over, as live.
 */
export function marketAt(tl: GameTimeline, tv: number): MarketPrices | null {
  const market = tl.market;
  if (!market || tl.scoreOnly || tv >= tl.endAt) return null;
  const homeBook = bookAt(market.home, tv);
  const awayBook = bookAt(market.away, tv);
  const home = quoteFrom(homeBook);
  const away = quoteFrom(awayBook);
  if (!home && !away) return null;
  const at = Math.max(homeBook?.[0] ?? 0, awayBook?.[0] ?? 0) * 1000;
  return { source: market.source, moneyline: { home, away }, spread: null, total: null, changedAt: new Date(at).toISOString(), stale: false };
}

/** The home team's captured prices up to virtual time `tv`, never past the end of the game. */
export function marketHistoryAt(tl: GameTimeline, tv: number): MarketHistory | null {
  const market = tl.market;
  if (!market?.home || tl.scoreOnly) return null;
  const cut = Math.min(tv, tl.endAt);
  const points = pricePoints(market.home.candles.filter((c) => c[0] * 1000 <= cut));
  return points.length >= 2 ? { source: market.source, team: 'home', points, captured: true } : null;
}

/** Plays the provider would have shown at virtual time `tv`, with any test-scenario edits applied. */
export function visiblePlays(tl: GameTimeline, tv: number): TimelinePlay[] {
  const holds = tl.edits.filter((e): e is Extract<TimelineEdit, { kind: 'hold' }> => e.kind === 'hold');
  const strips = tl.edits.filter((e): e is Extract<TimelineEdit, { kind: 'strip-spot' }> => e.kind === 'strip-spot');
  const revisions = tl.edits.filter((e): e is Extract<TimelineEdit, { kind: 'revise' }> => e.kind === 'revise' && tv >= e.at);
  const out: TimelinePlay[] = [];
  for (const p of tl.plays) {
    const hold = holds.find((h) => p.t >= h.from && p.t < h.until);
    if ((hold ? hold.until : p.t) > tv) continue;
    let raw = p.raw;
    for (const r of revisions) {
      const target = tl.plays.find((x) => String(x.raw.id) === r.playId);
      if (!target) continue;
      if (String(raw.id) === r.playId) raw = r.patch(raw);
      if (p.index >= target.index) raw = { ...raw, homeScore: Number(raw.homeScore) + r.scoreDelta.home, awayScore: Number(raw.awayScore) + r.scoreDelta.away };
    }
    if (raw.end && strips.some((s) => p.t >= s.from && p.t < s.until)) {
      const { possessionText: _p, yardLine: _y, yardsToEndzone: _t, ...rest } = raw.end;
      raw = { ...raw, end: { ...rest, downDistanceText: typeof raw.end.downDistanceText === 'string' ? raw.end.downDistanceText.replace(/ at .*$/, '') : raw.end.downDistanceText } };
    }
    out.push({ ...p, raw });
  }
  return out;
}

/**
 * The captured win probability entries the provider would have listed at this
 * point: in the captured order, stopping at the first entry for a play that is not
 * visible yet. Nothing is listed before the first play.
 */
export function visibleWinProbability(tl: GameTimeline, visible: TimelinePlay[]): Raw[] {
  const entries: Raw[] = Array.isArray(tl.summary.winprobability) ? tl.summary.winprobability : [];
  if (!visible.length || !entries.length) return [];
  const known = new Set(tl.plays.map((p) => String(p.raw.id)));
  const shown = new Set(visible.map((p) => String(p.raw.id)));
  const out: Raw[] = [];
  for (const e of entries) {
    const id = String(e.playId);
    if (known.has(id) && !shown.has(id)) break;
    out.push(e);
  }
  return out;
}

const PERIOD_NAMES = ['1st Quarter', '2nd Quarter', '3rd Quarter', '4th Quarter'];
const PERIOD_SHORT = ['1st', '2nd', '3rd', '4th'];
const periodName = (p: number) => (p <= 4 ? PERIOD_NAMES[p - 1] : p === 5 ? 'OT' : `${p - 4}OT`);
const periodShort = (p: number) => (p <= 4 ? PERIOD_SHORT[p - 1] : p === 5 ? 'OT' : `${p - 4}OT`);
const clockSeconds = (display: string | undefined) => {
  const m = /^(\d+):(\d{2})/.exec(display ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

export function statusAt(tl: GameTimeline, visible: TimelinePlay[], tv: number): Raw {
  const final = tl.event.competitions?.[0]?.status ?? tl.event.status;
  if (tl.scoreOnly) return final;
  if (!visible.length) {
    return { clock: 0, displayClock: '0:00', period: 0, type: { id: '1', name: 'STATUS_SCHEDULED', state: 'pre', completed: false, description: 'Scheduled', detail: 'Scheduled', shortDetail: 'Scheduled' } };
  }
  const last = visible[visible.length - 1].raw;
  const type = String(last.type?.text ?? '');
  if (/end of game/i.test(type) || tv >= tl.endAt) return final;
  const period = Number(last.period?.number ?? 1);
  if (/end of half/i.test(type)) {
    return { clock: 0, displayClock: '0:00', period, type: { id: '23', name: 'STATUS_HALFTIME', state: 'in', completed: false, description: 'Halftime', detail: 'Halftime', shortDetail: 'Halftime' } };
  }
  if (/^end period$|end of regulation/i.test(type)) {
    return { clock: 0, displayClock: '0:00', period, type: { id: '22', name: 'STATUS_END_PERIOD', state: 'in', completed: false, description: 'End of Period', detail: `End of ${periodName(period)}`, shortDetail: `End of ${periodShort(period)}` } };
  }
  const display = String(last.clock?.displayValue ?? '0:00');
  return {
    clock: clockSeconds(display),
    displayClock: display,
    period,
    type: { id: '2', name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, description: 'In Progress', detail: `${display} - ${periodName(period)}`, shortDetail: `${display} - ${periodShort(period)}` },
  };
}

function scoreOf(tl: GameTimeline, visible: TimelinePlay[]): { home: number; away: number } {
  if (tl.scoreOnly) {
    const comps: Raw[] = tl.event.competitions?.[0]?.competitors ?? [];
    return {
      home: Number(comps.find((c) => c.homeAway === 'home')?.score ?? 0),
      away: Number(comps.find((c) => c.homeAway === 'away')?.score ?? 0),
    };
  }
  // The feed sometimes reports 0-0 on a stoppage (captured on a two-minute warning); a stoppage never changes the score.
  for (let i = visible.length - 1; i >= 0; i--) {
    const raw = visible[i].raw;
    const home = Number(raw.homeScore ?? 0);
    const away = Number(raw.awayScore ?? 0);
    if (home === 0 && away === 0 && i > 0 && STOPPAGE.test(String(raw.type?.text ?? ''))) continue;
    return { home, away };
  }
  return { home: 0, away: 0 };
}

function situationOf(visible: TimelinePlay[], probability: Map<string, Raw>): Raw | undefined {
  for (let i = visible.length - 1; i >= 0; i--) {
    const p = visible[i].raw;
    if (STOPPAGE.test(String(p.type?.text ?? ''))) continue;
    const e = p.end ?? {};
    const wp = probability.get(String(p.id));
    return {
      down: e.down,
      distance: e.distance,
      yardLine: e.yardLine,
      downDistanceText: e.downDistanceText,
      shortDownDistanceText: e.shortDownDistanceText,
      possessionText: e.possessionText,
      possession: e.team?.id,
      lastPlay: {
        id: p.id,
        type: p.type,
        text: p.text,
        statYardage: p.statYardage,
        team: { id: p.start?.team?.id },
        ...(wp ? { probability: { homeWinPercentage: wp.homeWinPercentage, tiePercentage: wp.tiePercentage } } : {}),
      },
    };
  }
  return undefined;
}

const probabilityByPlay = (entries: Raw[]) => new Map(entries.map((e) => [String(e.playId), e]));

const stripResult = (c: Raw, final: boolean): Raw => {
  const { records: _r, record: _rec, winner, ...rest } = c;
  return final ? { ...rest, winner } : rest;
};

export function scoreboardEventAt(tl: GameTimeline, tv: number): Raw {
  const comp = tl.event.competitions[0];
  const visible = visiblePlays(tl, tv);
  const status = statusAt(tl, visible, tv);
  const final = status.type?.name === 'STATUS_FINAL';
  const score = scoreOf(tl, visible);
  const competitors = (comp.competitors as Raw[]).map((c) => ({
    ...stripResult(c, final),
    score: status.type?.state === 'pre' ? '0' : String(c.homeAway === 'home' ? score.home : score.away),
  }));
  const situation = status.type?.name === 'STATUS_IN_PROGRESS' ? situationOf(visible, probabilityByPlay(visibleWinProbability(tl, visible))) : undefined;
  const odds = Array.isArray(tl.summary.pickcenter) ? { odds: tl.summary.pickcenter } : {};
  return { ...tl.event, status, competitions: [{ ...comp, competitors, status, situation, ...odds }] };
}

export function summaryAt(tl: GameTimeline, tv: number): Raw {
  const s = tl.summary;
  const visible = visiblePlays(tl, tv);
  const status = statusAt(tl, visible, tv);
  const final = status.type?.name === 'STATUS_FINAL';
  const score = scoreOf(tl, visible);
  const winprobability = visibleWinProbability(tl, visible);
  const situation = status.type?.name === 'STATUS_IN_PROGRESS' ? situationOf(visible, probabilityByPlay(winprobability)) : undefined;

  const byDrive = new Map<number, Raw[]>();
  for (const p of visible) byDrive.set(p.drive, [...(byDrive.get(p.drive) ?? []), p.raw]);
  const lastDrive = visible.length ? visible[visible.length - 1].drive : -1;
  const previous: Raw[] = [];
  let current: Raw | undefined;
  (s.drives?.previous ?? []).forEach((d: Raw, i: number) => {
    const plays = byDrive.get(i);
    if (!plays) return;
    const complete = plays.length === (d.plays?.length ?? 0) && (i < lastDrive || final);
    const cut = { ...d, plays, description: undefined, result: undefined, shortDisplayResult: undefined, displayResult: undefined, yards: undefined, offensivePlays: undefined, end: undefined, timeElapsed: undefined, isScore: undefined };
    if (complete) previous.push({ ...d, plays });
    else if (i === lastDrive && !final) current = cut;
    else previous.push(cut);
  });

  const visibleIds = new Set(visible.map((p) => String(p.raw.id)));
  const nonScoring = new Set(visible.filter((p) => p.raw.scoringPlay === false).map((p) => String(p.raw.id)));
  const lastScoring = new Map(visible.map((p) => [String(p.raw.id), p.raw]));
  const scoringPlays = (s.scoringPlays ?? [])
    .filter((sp: Raw) => visibleIds.has(String(sp.id)) && !nonScoring.has(String(sp.id)))
    .map((sp: Raw) => {
      const play = lastScoring.get(String(sp.id));
      return play ? { ...sp, homeScore: play.homeScore, awayScore: play.awayScore } : sp;
    });

  const comp = s.header.competitions[0];
  const possessionTeam = situation?.possession;
  return {
    format: s.format,
    // Attendance and leaders were captured for the finished game, so they appear only once the replay reaches the final.
    gameInfo: final ? s.gameInfo : s.gameInfo ? { ...s.gameInfo, attendance: undefined } : undefined,
    boxscore: final ? s.boxscore : undefined,
    leaders: final ? s.leaders : undefined,
    pickcenter: s.pickcenter,
    winprobability,
    header: {
      ...s.header,
      competitions: [
        {
          ...comp,
          status,
          competitors: (comp.competitors as Raw[]).map((c) => ({
            ...stripResult(c, final),
            score: status.type?.state === 'pre' ? '0' : String(c.homeAway === 'home' ? score.home : score.away),
            possession: status.type?.state === 'in' && possessionTeam !== undefined && String(c.team?.id) === String(possessionTeam),
          })),
        },
      ],
    },
    drives: tl.scoreOnly ? undefined : { previous, ...(current ? { current } : {}) },
    scoringPlays,
  };
}
