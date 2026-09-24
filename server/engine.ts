/**
 * The engine owns Gridiron's authoritative live state on a persistent server.
 *
 * - One polling task per league per day and one per game of interest, however
 *   many browsers are connected. A task never overlaps itself: the next run is
 *   scheduled only after the previous one finishes, with jitter.
 * - Intervals adapt to what is happening: live days poll quickly, finished days
 *   slowly; focused games more often than games merely on screen.
 * - Clients declare interest (day, divisions, focused/visible/monitored games).
 *   Interest is aggregated; when nobody needs a game any more its task stops.
 * - Changes are detected by fingerprinting normalized data. A poll that returns
 *   identical data updates "last successful fetch" but not "last change".
 * - A failed request never erases what is already known. It marks the data
 *   stale or unavailable and says why.
 * - Prediction market prices are kept beside the provider's data and attached to
 *   each game's summary, so they travel, and are delayed, with everything else.
 */
import type {
  ConferenceInfo,
  CoverageReport,
  Division,
  DivisionCoverage,
  Freshness,
  GameDetail,
  GameId,
  GameSummary,
  LeagueId,
  LineHistory,
  MarketHistory,
  MarketPrices,
  SlateSnapshot,
} from '../shared/model.js';
import { EMPTY_FRESHNESS, isLiveOrPaused, isOver } from '../shared/model.js';
import { computeDetailDelta, type DetailDelta } from '../shared/detailDelta.js';
import { sameHistory } from '../shared/marketHistory.js';
import { recordLine, sameLineHistory } from '../shared/lineHistory.js';
import { mergeSummaries, withDerivedSituation } from '../shared/situation.js';
import { easternDateKey, fingerprint, jitter, shiftDateKey } from '../shared/util.js';
import type { ProviderPushEvent, SportsProvider } from './providers/types.js';

export interface PollIntervals {
  slateLive: number;
  slateIdle: number;
  slatePast: number;
  detailFocus: number;
  detailVisible: number;
  detailBackground: number;
  detailScheduled: number;
  detailFinal: number;
}

export const DEFAULT_INTERVALS: PollIntervals = {
  slateLive: 25_000,
  slateIdle: 5 * 60_000,
  slatePast: 30 * 60_000,
  detailFocus: 12_000,
  detailVisible: 25_000,
  detailBackground: 60_000,
  detailScheduled: 10 * 60_000,
  detailFinal: 20 * 60_000,
};

export const DEFAULT_DIVISIONS: Division[] = ['FBS', 'FCS'];

export interface ClientInterest {
  date: string;
  divisions: Division[];
  focus: GameId[];
  visible: GameId[];
  monitored: GameId[];
  /** Keep play detail for every live full-coverage game on the day, so alerts can see plays. */
  alertsAllGames: boolean;
}

export type EngineMessage =
  | { type: 'slate'; snapshot: SlateSnapshot }
  | {
      type: 'slate-delta';
      date: string;
      seq: number;
      generatedAt: string;
      upserts: GameSummary[];
      removed: GameId[];
      freshness: Record<LeagueId, Freshness>;
      coverage: CoverageReport;
    }
  | { type: 'detail'; gameId: GameId; version: number; detail: GameDetail; freshness: Freshness }
  | { type: 'detail-delta'; gameId: GameId; delta: DetailDelta; freshness: Freshness }
  | { type: 'detail-freshness'; gameId: GameId; version: number; freshness: Freshness };

type Send = (message: EngineMessage) => void;

interface Client {
  id: string;
  interest: ClientInterest;
  send: Send;
  detailVersions: Map<GameId, number>;
}

interface LeagueSlate {
  games: Map<GameId, GameSummary>;
  prints: Map<GameId, string>;
  freshness: Freshness;
  divisions: DivisionCoverage[];
  conferences: ConferenceInfo[];
  discovery: string;
  limitations: string[];
  fetched: boolean;
  failures: number;
  inflight: Promise<void> | null;
  fetchedDivisions: Division[];
}

interface DaySlate {
  date: string;
  seq: number;
  leagues: Record<LeagueId, LeagueSlate>;
  lastRequested: number;
}

interface DetailEntry {
  detail: GameDetail | null;
  previous: GameDetail | null;
  version: number;
  print: string | null;
  freshness: Freshness;
  failures: number;
  inflight: Promise<void> | null;
  delta: DetailDelta | null;
  lastRequested: number;
}

interface Task {
  key: string;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  nextAt: number | null;
}

type InterestLevel = 'focus' | 'visible' | 'background';
const LEVEL_RANK: Record<InterestLevel, number> = { focus: 3, visible: 2, background: 1 };

/** Reads market prices on request, for deployments that cannot poll in the background. */
export interface MarketReader {
  read(games: GameSummary[]): Promise<Map<GameId, MarketPrices | null>>;
}

export interface EngineOptions {
  provider: SportsProvider;
  mode: 'live' | 'replay';
  replayLabel?: string | null;
  now?: () => number;
  random?: () => number;
  intervals?: Partial<PollIntervals>;
  /** The provider day treated as "today". Defaults to today in US Eastern time. */
  today?: () => string;
  log?: (message: string) => void;
  /** Serverless deployments: read market prices whenever a slate is requested. A persistent server feeds prices with setMarketPrices instead. */
  markets?: MarketReader;
  /** Reads the home team's market price history for a followed game, which rides on its detail. The replay lab's provider supplies captured history itself. */
  marketHistory?: (game: GameSummary) => Promise<MarketHistory | null>;
}

/** Serverless deployments: how long a failed league or game waits before a request asks the provider again. */
const ON_DEMAND_RETRY_MS = { slate: 30_000, detail: 10_000 };
/**
 * Serverless deployments: a healthy slate or game counts as due this much before its polling interval. Viewers poll on the
 * same cycle as those intervals, so a request arriving a moment early would otherwise wait out a whole further cycle.
 */
const ON_DEMAND_EARLY_MS = 3_000;

const iso = (ms: number) => new Date(ms).toISOString();

const newLeague = (): LeagueSlate => ({
  games: new Map(),
  prints: new Map(),
  freshness: { ...EMPTY_FRESHNESS },
  divisions: [],
  conferences: [],
  discovery: '',
  limitations: [],
  fetched: false,
  failures: 0,
  inflight: null,
  fetchedDivisions: [],
});

export class GridironEngine {
  readonly mode: 'live' | 'replay';
  readonly replayLabel: string | null;
  private readonly provider: SportsProvider;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly intervals: PollIntervals;
  private readonly todayKey: () => string;
  private readonly log: (message: string) => void;
  private readonly marketReader: MarketReader | null;
  private readonly days = new Map<string, DaySlate>();
  private readonly details = new Map<GameId, DetailEntry>();
  private readonly clients = new Map<string, Client>();
  private readonly tasks = new Map<string, Task>();
  private readonly marketPrices = new Map<GameId, MarketPrices>();
  /** Whether an exchange feeds prices here. Without one, summaries keep the prices their provider supplied (the replay lab's captured prices). */
  private marketsAttached: boolean;
  private readonly historyReader: ((game: GameSummary) => Promise<MarketHistory | null>) | null;
  private readonly histories = new Map<GameId, { history: MarketHistory | null; at: number; inflight: Promise<void> | null }>();
  /*
   * Gridiron's own record of a sportsbook's line. The provider reports an
   * opening and a latest line with no times attached, which is two numbers and
   * not a history, so a game page could say what a prediction market traded at
   * during any play and could not say the same about the book. Every reading
   * that differs from the last one written down becomes a point, stamped with
   * when it was seen; nothing is ever written for a moment nobody looked at.
   */
  private readonly lines = new Map<GameId, LineHistory>();
  private seq = 0;
  private running = false;

  constructor(options: EngineOptions) {
    this.provider = options.provider;
    this.mode = options.mode;
    this.replayLabel = options.replayLabel ?? null;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
    this.todayKey = options.today ?? (() => easternDateKey(new Date(this.now())));
    this.log = options.log ?? (() => {});
    this.marketReader = options.markets ?? null;
    this.marketsAttached = !!options.markets;
    this.historyReader = options.marketHistory ?? null;
  }

  // ------------------------------------------------------------ lifecycle

  /** The provider's push subscription while the engine runs, for providers that push. */
  private unsubscribePush: (() => void) | null = null;

  start() {
    this.running = true;
    if (this.provider.subscribe && !this.unsubscribePush) this.unsubscribePush = this.provider.subscribe((event) => this.onPush(event));
    this.reconcile();
  }

  stop() {
    this.running = false;
    this.unsubscribePush?.();
    this.unsubscribePush = null;
    for (const t of this.tasks.values()) if (t.timer) clearTimeout(t.timer);
    this.tasks.clear();
  }

  get providerInfo() {
    return this.provider.info;
  }

  today() {
    return this.todayKey();
  }

  /** The engine's clock: wall time when live, the replay clock in the replay lab. */
  clock(): number {
    return this.now();
  }

  /** The detail the engine already holds for a game, without asking the provider for more. */
  peekDetail(gameId: GameId): { version: number; detail: GameDetail | null; freshness: Freshness } | null {
    const entry = this.details.get(gameId);
    return entry ? { version: entry.version, detail: entry.detail, freshness: entry.freshness } : null;
  }

  /** The summary the engine holds for a game on any day it has read, without asking the provider. */
  knownSummary(gameId: GameId): GameSummary | null {
    return this.findSummary(gameId);
  }

  // ------------------------------------------------------------ market prices

  /** Every game on the days the engine is following: the candidates for market prices. */
  marketGames(): GameSummary[] {
    const games = new Map<GameId, GameSummary>();
    for (const date of this.activeDates()) {
      const day = this.days.get(date);
      if (!day) continue;
      for (const league of [day.leagues.nfl, day.leagues.cfb]) for (const g of league.games.values()) games.set(g.id, g);
    }
    return [...games.values()];
  }

  /** Stores market prices (null removes a game's prices) and sends the games whose summaries changed. */
  setMarketPrices(prices: Map<GameId, MarketPrices | null>) {
    this.marketsAttached = true;
    let changed = false;
    for (const [id, value] of prices) {
      if (value) {
        if (this.marketPrices.get(id) === value) continue;
        this.marketPrices.set(id, value);
        changed = true;
      } else if (this.marketPrices.delete(id)) changed = true;
    }
    if (!changed) return;
    for (const day of this.days.values()) {
      const upserts: GameSummary[] = [];
      for (const league of [day.leagues.nfl, day.leagues.cfb]) {
        for (const [id, game] of league.games) {
          if (!prices.has(id)) continue;
          const next = this.withMarket(game);
          if (next === game) continue;
          league.games.set(id, next);
          const print = summaryPrint(next);
          if (league.prints.get(id) !== print) {
            league.prints.set(id, print);
            upserts.push(next);
          }
        }
      }
      if (upserts.length) this.emitDay(day, upserts, []);
    }
  }

  /** A summary carrying the market prices held for its game, or none. */
  private withMarket(game: GameSummary): GameSummary {
    if (!this.marketsAttached) return game;
    const market = this.marketPrices.get(game.id) ?? null;
    if ((game.market ?? null) === market) return game;
    return { ...game, market };
  }

  /**
   * A provider push goes through the same merge, versioning and broadcast as a
   * poll, so clients cannot tell the two apart. Polling continues underneath
   * and reconciles anything a push missed. Detail is kept only for games
   * someone follows; for other games a push updates the slate summary alone.
   */
  private onPush(event: ProviderPushEvent) {
    if (!this.running) return;
    try {
      if (event.kind === 'detail' && event.detail) {
        const entry = this.details.get(event.gameId);
        if (entry) this.acceptDetail(event.gameId, entry, event.detail, event.receivedAt);
        else this.mergeIntoSlate({ ...event.detail.summary, receivedAt: event.receivedAt, source: 'summary' });
      } else if (event.kind === 'summary' && event.summary && event.summary.id === event.gameId) {
        this.mergeIntoSlate({ ...event.summary, receivedAt: event.receivedAt, source: 'scoreboard' });
      }
    } catch (e) {
      this.log(`push event for ${event.gameId} could not be applied: ${(e as Error).message}`);
    }
  }

  stats() {
    return {
      clients: this.clients.size,
      tasks: [...this.tasks.values()].map((t) => ({ key: t.key, running: t.running, nextInMs: t.nextAt === null ? null : Math.max(0, t.nextAt - this.now()) })),
      days: [...this.days.keys()],
      details: this.details.size,
      marketGames: this.marketPrices.size,
    };
  }

  // ------------------------------------------------------------ clients

  connect(clientId: string, interest: ClientInterest, send: Send): () => void {
    const existing = this.clients.get(clientId);
    const client: Client = { id: clientId, interest: normalizeInterest(interest), send, detailVersions: new Map() };
    this.clients.set(clientId, client);
    if (existing) existing.send = () => {};
    this.onInterest(client, null);
    return () => {
      if (this.clients.get(clientId) === client) {
        this.clients.delete(clientId);
        this.reconcile();
      }
    };
  }

  setInterest(clientId: string, interest: ClientInterest): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    const previous = client.interest;
    client.interest = normalizeInterest(interest);
    this.onInterest(client, previous);
    return true;
  }

  private onInterest(client: Client, previous: ClientInterest | null) {
    const i = client.interest;
    const day = this.ensureDay(i.date);
    day.lastRequested = this.now();
    if (!previous || previous.date !== i.date) client.send({ type: 'slate', snapshot: this.snapshot(i.date) });
    const newDivisions = i.divisions.filter((d) => !day.leagues.cfb.fetchedDivisions.includes(d));
    if (newDivisions.length && day.leagues.cfb.fetched) void this.refreshLeague('cfb', i.date);
    const before = new Set(previous ? [...previous.focus, ...previous.visible, ...previous.monitored] : []);
    for (const id of [...i.focus, ...i.visible, ...i.monitored]) {
      const entry = this.details.get(id);
      if (entry?.detail && (!before.has(id) || client.detailVersions.get(id) !== entry.version)) {
        client.send({ type: 'detail', gameId: id, version: entry.version, detail: entry.detail, freshness: entry.freshness });
        client.detailVersions.set(id, entry.version);
      }
    }
    this.reconcile();
  }

  // ------------------------------------------------------------ queries

  async getSlate(date: string, waitMs = 10_000): Promise<SlateSnapshot> {
    const day = this.ensureDay(date);
    day.lastRequested = this.now();
    // A running engine keeps its slates fresh on a timer. Nothing polls between requests on a serverless deployment,
    // so there a request refreshes each league whose last attempt is older than its polling interval.
    const unfetched = !day.leagues.nfl.fetched || !day.leagues.cfb.fetched;
    const due: LeagueId[] = unfetched ? ['nfl', 'cfb'] : this.running ? [] : (['nfl', 'cfb'] as const).filter((league) => this.dueOnDemand(day, league));
    if (due.length) await withTimeout(Promise.all(due.map((league) => this.refreshLeague(league, date))), waitMs);
    if (this.marketReader) {
      const games = [...day.leagues.nfl.games.values(), ...day.leagues.cfb.games.values()];
      const prices = await withTimeout(
        this.marketReader.read(games).catch((e: unknown) => {
          this.log(`market prices failed: ${(e as Error).message}`);
          return undefined;
        }),
        3_000,
      );
      if (prices) this.setMarketPrices(prices);
    }
    this.reconcile();
    return this.snapshot(date);
  }

  async getDetail(gameId: GameId, waitMs = 10_000): Promise<{ version: number; detail: GameDetail | null; freshness: Freshness }> {
    const entry = this.ensureDetail(gameId);
    entry.lastRequested = this.now();
    const age = entry.freshness.lastSuccessAt ? this.now() - Date.parse(entry.freshness.lastSuccessAt) : Infinity;
    const sinceAttempt = entry.freshness.lastAttemptAt ? this.now() - Date.parse(entry.freshness.lastAttemptAt) : Infinity;
    // on a serverless deployment a failing game is asked for again at most every 10 seconds, not on every request,
    // and a healthy one a little before 12 seconds, the interval at which the client asks for a game in focus
    const spaced = this.running || !entry.failures || sinceAttempt >= ON_DEMAND_RETRY_MS.detail;
    const stale = age > this.intervals.detailFocus - (this.running ? 0 : ON_DEMAND_EARLY_MS);
    if ((!entry.detail || stale) && spaced) await withTimeout(this.refreshDetail(gameId), waitMs);
    // A serverless function may stop once it answers, so the price history is read before answering, briefly.
    if (this.historyReader && entry.detail) await withTimeout(this.refreshHistory(gameId), 3_000);
    return { version: entry.version, detail: entry.detail, freshness: entry.freshness };
  }

  snapshot(date: string): SlateSnapshot {
    const day = this.ensureDay(date);
    const { nfl, cfb } = day.leagues;
    return {
      seq: day.seq,
      mode: this.mode,
      replayLabel: this.replayLabel,
      date,
      generatedAt: iso(this.now()),
      games: [...nfl.games.values(), ...cfb.games.values()],
      freshness: { nfl: nfl.freshness, cfb: cfb.freshness },
      coverage: this.coverage(day),
    };
  }

  private coverage(day: DaySlate): CoverageReport {
    const { nfl, cfb } = day.leagues;
    return {
      provider: this.provider.info.name,
      date: day.date,
      divisions: [...nfl.divisions, ...cfb.divisions],
      conferences: [...nfl.conferences, ...cfb.conferences],
      discovery: [nfl.discovery, cfb.discovery].filter(Boolean).join(' '),
      limitations: [...nfl.limitations, ...cfb.limitations],
    };
  }

  /** Re-poll everything now (used by the replay lab after it advances time). */
  async refreshAll(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const key of this.tasks.keys()) {
      const [kind, a, b] = key.split('|');
      work.push(kind === 'slate' ? this.refreshLeague(a as LeagueId, b) : this.refreshDetail(a));
    }
    await Promise.all(work);
  }

  // ------------------------------------------------------------ state

  private ensureDay(date: string): DaySlate {
    let day = this.days.get(date);
    if (!day) {
      day = { date, seq: 0, leagues: { nfl: newLeague(), cfb: newLeague() }, lastRequested: this.now() };
      this.days.set(date, day);
    }
    return day;
  }

  private ensureDetail(id: GameId): DetailEntry {
    let entry = this.details.get(id);
    if (!entry) {
      entry = { detail: null, previous: null, version: 0, print: null, freshness: { ...EMPTY_FRESHNESS }, failures: 0, inflight: null, delta: null, lastRequested: 0 };
      this.details.set(id, entry);
    }
    return entry;
  }

  private findSummary(id: GameId): GameSummary | null {
    for (const day of this.days.values()) {
      const g = day.leagues.nfl.games.get(id) ?? day.leagues.cfb.games.get(id);
      if (g) return g;
    }
    return null;
  }

  private divisionsFor(date: string): Division[] {
    const set = new Set<Division>();
    for (const c of this.clients.values()) if (c.interest.date === date) c.interest.divisions.forEach((d) => set.add(d));
    if (!set.size) DEFAULT_DIVISIONS.forEach((d) => set.add(d));
    return [...set].filter((d) => d !== 'NFL');
  }

  // ------------------------------------------------------------ polling

  refreshLeague(league: LeagueId, date: string): Promise<void> {
    const day = this.ensureDay(date);
    const slate = day.leagues[league];
    if (slate.inflight) return slate.inflight;
    const divisions: Division[] = league === 'nfl' ? ['NFL'] : this.divisionsFor(date);
    slate.freshness = { ...slate.freshness, lastAttemptAt: iso(this.now()), health: slate.fetched ? slate.freshness.health : 'reconnecting' };
    slate.inflight = (async () => {
      try {
        const result = await this.provider.fetchSlate(league, date, { divisions });
        this.applySlate(day, league, result, divisions);
      } catch (e) {
        this.log(`slate ${league} ${date} crashed: ${(e as Error).message}`);
        slate.failures++;
        slate.fetched = true;
        slate.freshness = { ...slate.freshness, health: slate.games.size ? 'stale' : 'unavailable', error: (e as Error).message, consecutiveFailures: slate.failures };
        this.emitDay(day, [], []);
      }
    })().finally(() => {
      slate.inflight = null;
    });
    return slate.inflight;
  }

  private applySlate(day: DaySlate, league: LeagueId, result: Awaited<ReturnType<SportsProvider['fetchSlate']>>, divisions: Division[]) {
    const slate = day.leagues[league];
    slate.fetched = true;
    slate.discovery = result.discovery || slate.discovery;
    slate.limitations = result.limitations;
    if (result.conferences?.length) slate.conferences = result.conferences;
    const errorText = result.errors.map((e) => `${e.scope}: ${e.message}`).join('; ') || null;
    if (result.failed) {
      slate.failures++;
      slate.divisions = result.divisions.length ? result.divisions : slate.divisions.map((d) => ({ ...d, health: 'unavailable' as const }));
      slate.freshness = { ...slate.freshness, health: slate.games.size ? 'stale' : 'unavailable', error: errorText ?? 'Provider unavailable', consecutiveFailures: slate.failures };
      this.emitDay(day, [], []);
      return;
    }
    slate.failures = 0;
    slate.fetchedDivisions = divisions;
    slate.divisions = result.divisions;
    const failedDivisions = new Set(result.divisions.filter((d) => d.health === 'unavailable').map((d) => d.division));
    const upserts: GameSummary[] = [];
    const removed: GameId[] = [];
    const seen = new Set<GameId>();
    for (const incoming of result.games) {
      const stamped: GameSummary = { ...incoming, receivedAt: result.receivedAt, source: 'scoreboard' };
      seen.add(stamped.id);
      const prev = slate.games.get(stamped.id);
      const merged = this.withMarket(prev ? mergeSummaries(prev, stamped) : stamped);
      slate.games.set(stamped.id, merged);
      this.recordLines(stamped.id, merged, result.receivedAt);
      const print = summaryPrint(merged);
      if (slate.prints.get(stamped.id) !== print) {
        slate.prints.set(stamped.id, print);
        upserts.push(merged);
      }
    }
    for (const [id, prev] of slate.games) {
      if (seen.has(id)) continue;
      const stillWanted = league === 'nfl' || prev.divisions.some((d) => divisions.includes(d));
      const inFailedDivision = prev.divisions.some((d) => failedDivisions.has(d));
      if (!stillWanted || !inFailedDivision) {
        slate.games.delete(id);
        slate.prints.delete(id);
        removed.push(id);
      }
    }
    const changed = upserts.length > 0 || removed.length > 0;
    slate.freshness = {
      lastAttemptAt: slate.freshness.lastAttemptAt,
      lastSuccessAt: iso(result.receivedAt),
      lastChangeAt: changed ? iso(result.receivedAt) : slate.freshness.lastChangeAt,
      health: result.errors.length ? 'stale' : 'connected',
      error: errorText,
      consecutiveFailures: 0,
    };
    this.emitDay(day, upserts, removed);
  }

  refreshDetail(id: GameId): Promise<void> {
    const entry = this.ensureDetail(id);
    if (entry.inflight) return entry.inflight;
    entry.freshness = { ...entry.freshness, lastAttemptAt: iso(this.now()) };
    entry.inflight = (async () => {
      try {
        const summary = this.findSummary(id);
        const result = await this.provider.fetchDetail(id, summary?.divisions);
        if (!result.ok) {
          entry.failures++;
          entry.freshness = { ...entry.freshness, health: entry.detail ? 'stale' : 'unavailable', error: result.error.message, consecutiveFailures: entry.failures };
          this.emitDetailFreshness(id, entry);
          return;
        }
        this.acceptDetail(id, entry, result.detail, result.receivedAt, 'poll');
      } catch (e) {
        entry.failures++;
        entry.freshness = { ...entry.freshness, health: entry.detail ? 'stale' : 'unavailable', error: (e as Error).message, consecutiveFailures: entry.failures };
        this.emitDetailFreshness(id, entry);
      }
    })().finally(() => {
      entry.inflight = null;
      this.reconcile();
    });
    return entry.inflight;
  }

  /** When each game's detail last arrived by push, so a slower poll cannot undo it. */
  private readonly lastPush = new Map<GameId, number>();

  /**
   * Stores a provider detail for a followed game when it changed, and tells
   * interested clients. Polls and pushes both come through here. Anything
   * received before the latest push is ignored; without pushes nothing is, so
   * the replay lab can seek backwards.
   */
  private acceptDetail(id: GameId, entry: DetailEntry, detail: GameDetail, receivedAt: number, via: 'poll' | 'push' = 'push') {
    const pushed = this.lastPush.get(id);
    if (pushed !== undefined && receivedAt < pushed) return;
    if (via === 'push') this.lastPush.set(id, receivedAt);
    const summary = this.findSummary(id);
    entry.failures = 0;
    const derived = withDerivedSituation({
      ...detail,
      summary: { ...detail.summary, receivedAt, source: 'summary', divisions: summary?.divisions ?? detail.summary.divisions },
    });
    // With an exchange attached, the held price history rides along; the replay lab's provider supplies its own.
    const withMarket: GameDetail = this.historyReader ? { ...derived, marketHistory: this.histories.get(id)?.history ?? null } : derived;
    /*
     * The line this detail carries is written down before the detail is stamped,
     * so a reading and the detail that brought it reach clients as one version
     * rather than as a detail followed by an amendment to it.
     */
    this.recordLines(id, derived.summary, receivedAt, false);
    // The replay lab supplies its own recording, cut at the replay clock, the same way it supplies its own price history.
    const stamped: GameDetail = this.mode === 'replay' ? withMarket : { ...withMarket, lineHistory: this.lines.get(id) ?? null };
    const print = fingerprint(JSON.stringify({ ...stamped, summary: { ...stamped.summary, receivedAt: 0 } }));
    const changed = print !== entry.print;
    entry.freshness = {
      lastAttemptAt: entry.freshness.lastAttemptAt,
      lastSuccessAt: iso(receivedAt),
      lastChangeAt: changed ? iso(receivedAt) : entry.freshness.lastChangeAt,
      health: 'connected',
      error: null,
      consecutiveFailures: 0,
    };
    if (!changed) {
      this.emitDetailFreshness(id, entry);
      void this.refreshHistory(id);
      return;
    }
    entry.previous = entry.detail;
    entry.detail = stamped;
    entry.print = print;
    entry.version++;
    entry.delta = entry.previous ? computeDetailDelta(entry.previous, stamped, entry.version - 1, entry.version) : null;
    this.emitDetail(id, entry);
    this.mergeIntoSlate(stamped.summary);
    void this.refreshHistory(id);
  }

  private mergeIntoSlate(summary: GameSummary) {
    for (const day of this.days.values()) {
      const slate = day.leagues[summary.league];
      const prev = slate.games.get(summary.id);
      if (!prev) continue;
      const merged = this.withMarket(mergeSummaries(prev, summary));
      slate.games.set(summary.id, merged);
      const print = summaryPrint(merged);
      if (slate.prints.get(summary.id) !== print) {
        slate.prints.set(summary.id, print);
        this.emitDay(day, [merged], []);
      }
    }
  }

  /**
   * Reads a followed game's market price history when it is due: every 45 seconds while the game
   * is live, every 5 minutes before it. A finished game keeps the history it had. Nothing is read
   * without an exchange attached.
   */
  private refreshHistory(id: GameId): Promise<void> {
    const reader = this.historyReader;
    const entry = this.details.get(id);
    const game = entry?.detail?.summary;
    if (!reader || !entry?.detail || !game || game.status.kind === 'final') return Promise.resolve();
    let held = this.histories.get(id);
    if (!held) {
      held = { history: null, at: 0, inflight: null };
      this.histories.set(id, held);
    }
    if (held.inflight) return held.inflight;
    const due = isLiveOrPaused(game.status.kind) ? 45_000 : 5 * 60_000;
    if (held.at && this.now() - held.at < due) return Promise.resolve();
    const slot = held;
    slot.inflight = reader(game)
      .then((history) => {
        slot.history = history;
        slot.at = this.now();
        this.attachHistory(id);
      })
      .catch((e: unknown) => this.log(`market history failed: ${(e as Error).message}`))
      .finally(() => {
        slot.inflight = null;
      });
    return slot.inflight;
  }

  /** Writes down a sportsbook's line when it differs from the last reading taken. */
  private recordLines(id: GameId, summary: GameSummary, receivedAt: number, attach = true) {
    /*
     * Not in the replay lab. A replay runs on the original game's clock, so its
     * plays are stamped with a Sunday months ago while a reading taken now would
     * be stamped with today. Writing that down would put a reading in the record
     * that stands after every play in the game and describes none of them, and
     * would turn "the provider reports no line during a game" into the false
     * "nothing was recorded at this play". A replay has no line from then
     * because nobody was watching then, and the page says exactly that.
     */
    if (this.mode === 'replay') return;
    const held = this.lines.get(id) ?? null;
    const next = recordLine(held, summary.lines, iso(receivedAt));
    if (next === held || !next) return;
    this.lines.set(id, next);
    if (attach) this.attachLines(id);
  }

  /** Puts the recorded line on a game's detail when it differs, as a new detail version. */
  private attachLines(id: GameId) {
    const entry = this.details.get(id);
    if (!entry?.detail) return;
    const history = this.lines.get(id) ?? null;
    if (sameLineHistory(entry.detail.lineHistory, history)) return;
    const next: GameDetail = { ...entry.detail, lineHistory: history };
    entry.previous = entry.detail;
    entry.detail = next;
    entry.print = fingerprint(JSON.stringify({ ...next, summary: { ...next.summary, receivedAt: 0 } }));
    entry.version++;
    entry.delta = computeDetailDelta(entry.previous, next, entry.version - 1, entry.version);
    this.emitDetail(id, entry);
  }

  /** Puts the held price history on a game's detail when it differs, as a new detail version. */
  private attachHistory(id: GameId) {
    const entry = this.details.get(id);
    if (!entry?.detail) return;
    const history = this.histories.get(id)?.history ?? null;
    if (sameHistory(entry.detail.marketHistory, history)) return;
    const next: GameDetail = { ...entry.detail, marketHistory: history };
    entry.previous = entry.detail;
    entry.detail = next;
    entry.print = fingerprint(JSON.stringify({ ...next, summary: { ...next.summary, receivedAt: 0 } }));
    entry.version++;
    entry.delta = computeDetailDelta(entry.previous, next, entry.version - 1, entry.version);
    this.emitDetail(id, entry);
  }

  // ------------------------------------------------------------ messages

  private emitDay(day: DaySlate, upserts: GameSummary[], removed: GameId[]) {
    day.seq = ++this.seq;
    const message: EngineMessage = {
      type: 'slate-delta',
      date: day.date,
      seq: day.seq,
      generatedAt: iso(this.now()),
      upserts,
      removed,
      freshness: { nfl: day.leagues.nfl.freshness, cfb: day.leagues.cfb.freshness },
      coverage: this.coverage(day),
    };
    for (const c of this.clients.values()) if (c.interest.date === day.date) c.send(message);
  }

  private interestedClients(id: GameId): Client[] {
    const out: Client[] = [];
    for (const c of this.clients.values()) {
      const i = c.interest;
      if (i.focus.includes(id) || i.visible.includes(id) || i.monitored.includes(id)) out.push(c);
      else if (i.alertsAllGames && this.findSummary(id)) out.push(c);
    }
    return out;
  }

  private emitDetail(id: GameId, entry: DetailEntry) {
    if (!entry.detail) return;
    for (const c of this.interestedClients(id)) {
      const held = c.detailVersions.get(id);
      if (entry.delta && held === entry.delta.baseVersion) c.send({ type: 'detail-delta', gameId: id, delta: entry.delta, freshness: entry.freshness });
      else c.send({ type: 'detail', gameId: id, version: entry.version, detail: entry.detail, freshness: entry.freshness });
      c.detailVersions.set(id, entry.version);
    }
  }

  private emitDetailFreshness(id: GameId, entry: DetailEntry) {
    for (const c of this.interestedClients(id)) c.send({ type: 'detail-freshness', gameId: id, version: entry.version, freshness: entry.freshness });
  }

  // ------------------------------------------------------------ scheduling

  private activeDates(): Set<string> {
    const today = this.todayKey();
    const dates = new Set<string>([today]);
    const yesterday = shiftDateKey(today, -1);
    const y = this.days.get(yesterday);
    // Yesterday stays in the loop until it has been read and while any of its games are still going (past midnight).
    if (!y || !y.leagues.nfl.fetched || !y.leagues.cfb.fetched || this.hasActive(y)) dates.add(yesterday);
    for (const c of this.clients.values()) dates.add(c.interest.date);
    for (const [date, day] of this.days) if (this.now() - day.lastRequested < 2 * 60_000) dates.add(date);
    return dates;
  }

  private hasActive(day: DaySlate): boolean {
    for (const league of [day.leagues.nfl, day.leagues.cfb]) for (const g of league.games.values()) if (isLiveOrPaused(g.status.kind)) return true;
    return false;
  }

  private hasImminent(day: DaySlate): boolean {
    const now = this.now();
    for (const league of [day.leagues.nfl, day.leagues.cfb]) {
      for (const g of league.games.values()) {
        if (g.status.kind !== 'scheduled' || !g.startTime) continue;
        const start = Date.parse(g.startTime);
        if (start - now < 45 * 60_000 && now - start < 3 * 60 * 60_000) return true;
      }
    }
    return false;
  }

  private detailInterest(): Map<GameId, InterestLevel> {
    const levels = new Map<GameId, InterestLevel>();
    const raise = (id: GameId, level: InterestLevel) => {
      const cur = levels.get(id);
      if (!cur || LEVEL_RANK[level] > LEVEL_RANK[cur]) levels.set(id, level);
    };
    for (const c of this.clients.values()) {
      c.interest.focus.forEach((id) => raise(id, 'focus'));
      c.interest.visible.forEach((id) => raise(id, 'visible'));
      c.interest.monitored.forEach((id) => raise(id, 'visible'));
      if (c.interest.alertsAllGames) {
        const day = this.days.get(c.interest.date);
        if (day) {
          for (const league of [day.leagues.nfl, day.leagues.cfb]) {
            for (const g of league.games.values()) {
              if (isLiveOrPaused(g.status.kind) && g.coverage.level !== 'score-only' && g.divisions.some((d) => d === 'NFL' || c.interest.divisions.includes(d))) raise(g.id, 'background');
            }
          }
        }
      }
    }
    const now = this.now();
    for (const [id, entry] of this.details) if (now - entry.lastRequested < 90_000) raise(id, 'visible');
    return levels;
  }

  private reconcile() {
    if (!this.running) return;
    const wanted = new Map<string, number>();
    for (const date of this.activeDates()) {
      wanted.set(`slate|nfl|${date}`, 0);
      wanted.set(`slate|cfb|${date}`, 0);
    }
    for (const id of this.detailInterest().keys()) wanted.set(`detail|${id}`, 0);
    for (const [key, delay] of wanted) {
      if (!this.tasks.has(key)) {
        const task: Task = { key, timer: null, running: false, nextAt: null };
        this.tasks.set(key, task);
        this.schedule(task, key.startsWith('detail') && this.details.get(key.slice(7))?.detail ? this.intervalFor(key) ?? delay : delay);
      }
    }
    for (const [key, task] of this.tasks) {
      if (wanted.has(key)) continue;
      if (task.timer) clearTimeout(task.timer);
      this.tasks.delete(key);
    }
    // forget days nobody has asked about for a while
    const active = this.activeDates();
    for (const [date, day] of this.days) if (!active.has(date) && this.now() - day.lastRequested > 30 * 60_000) this.days.delete(date);
  }

  private schedule(task: Task, delayMs: number) {
    if (task.timer) clearTimeout(task.timer);
    const delay = Math.max(0, delayMs);
    task.nextAt = this.now() + delay;
    task.timer = setTimeout(() => void this.run(task), delay);
    (task.timer as { unref?: () => void }).unref?.();
  }

  private async run(task: Task) {
    if (task.running || this.tasks.get(task.key) !== task) return;
    task.running = true;
    task.timer = null;
    task.nextAt = null;
    try {
      const [kind, a, b] = task.key.split('|');
      if (kind === 'slate') await this.refreshLeague(a as LeagueId, b);
      else await this.refreshDetail(a);
    } finally {
      task.running = false;
      if (this.tasks.get(task.key) === task && this.running) {
        const next = this.intervalFor(task.key);
        if (next === null) this.tasks.delete(task.key);
        else this.schedule(task, jitter(next, 0.12, this.random));
      }
    }
  }

  /** How often a day's slate is polled while it is healthy: live, idle, or a past day. */
  private slateInterval(day: DaySlate): number {
    if (this.hasActive(day) || this.hasImminent(day)) return this.intervals.slateLive;
    return day.date < this.todayKey() ? this.intervals.slatePast : this.intervals.slateIdle;
  }

  /** Serverless deployments: whether a request should ask the provider for a league again. */
  private dueOnDemand(day: DaySlate, league: LeagueId): boolean {
    const slate = day.leagues[league];
    const since = slate.freshness.lastAttemptAt ? this.now() - Date.parse(slate.freshness.lastAttemptAt) : Infinity;
    return since >= (slate.failures ? ON_DEMAND_RETRY_MS.slate : this.slateInterval(day) - ON_DEMAND_EARLY_MS);
  }

  /** Milliseconds until a task should run again, or null when it is no longer needed. */
  intervalFor(key: string): number | null {
    const [kind, a, b] = key.split('|');
    if (kind === 'slate') {
      const date = b;
      if (!this.activeDates().has(date)) return null;
      const day = this.ensureDay(date);
      const failures = day.leagues[a as LeagueId].failures;
      const base = this.slateInterval(day);
      return failures ? Math.min(5 * 60_000, base * 2 ** Math.min(failures, 4)) : base;
    }
    const id = a;
    const level = this.detailInterest().get(id);
    if (!level) return null;
    const summary = this.findSummary(id);
    const entry = this.details.get(id);
    const status = summary?.status.kind ?? entry?.detail?.summary.status.kind ?? 'unknown';
    const coverage = summary?.coverage.level ?? entry?.detail?.summary.coverage.level;
    if (coverage === 'score-only' && entry?.detail) return null;
    const failures = entry?.failures ?? 0;
    let base: number;
    if (isOver(status) || status === 'postponed') base = level === 'background' ? Infinity : this.intervals.detailFinal;
    else if (status === 'scheduled') base = level === 'background' ? Infinity : this.intervals.detailScheduled;
    else base = level === 'focus' ? this.intervals.detailFocus : level === 'visible' ? this.intervals.detailVisible : this.intervals.detailBackground;
    if (!Number.isFinite(base)) return null;
    return failures ? Math.min(5 * 60_000, base * 2 ** Math.min(failures, 4)) : base;
  }
}

function normalizeInterest(i: ClientInterest): ClientInterest {
  const ids = (list: unknown) => (Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === 'string'))].slice(0, 64) : []);
  const allowed: Division[] = ['FBS', 'FCS', 'D2', 'D3'];
  const divisions = Array.isArray(i.divisions) ? i.divisions.filter((d): d is Division => allowed.includes(d)) : DEFAULT_DIVISIONS;
  return {
    date: i.date,
    divisions: divisions.length ? divisions : DEFAULT_DIVISIONS,
    focus: ids(i.focus).slice(0, 4),
    visible: ids(i.visible),
    monitored: ids(i.monitored),
    alertsAllGames: i.alertsAllGames === true,
  };
}

function summaryPrint(g: GameSummary): string {
  return fingerprint(JSON.stringify({ ...g, receivedAt: 0, source: undefined }));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
