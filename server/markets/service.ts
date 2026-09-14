/**
 * Prediction market prices for the games Gridiron is showing, read from Kalshi's
 * public market data and shared by every viewer.
 *
 * - Discovery: each league's open game events are listed at most every 10 minutes.
 *   A matched game's spread and total ladders are read and kept for 10 minutes.
 * - Prices: the chosen contracts are read in batches of 20. While any game is live
 *   or within an hour of kickoff, prices refresh every 15 seconds (Kalshi's own
 *   cache lifetime); otherwise every 5 minutes.
 * - Only games that are live, or scheduled to start within three days, are read.
 *   A game that ends loses its prices.
 * - Failure: the last prices stay, marked stale after 90 seconds without a
 *   successful read, and are dropped after 10 minutes.
 * - History: for a game someone follows, the home team's contract across time,
 *   hourly over the week before kickoff and minute by minute from an hour before.
 * The replay lab never uses this service; its replays carry prices captured earlier.
 */
import { pricePoints, type PriceCandle } from '../../shared/marketHistory.js';
import type { GameId, GameSummary, MarketHistory, MarketPrices } from '../../shared/model.js';
import { isLiveOrPaused } from '../../shared/model.js';
import { fingerprint } from '../../shared/util.js';
import type { FetchOutcome } from '../fetcher.js';
import { candlesFrom, contractsFor, contractTickers, findGameEvent, isKalshiEvent, KALSHI_API, KALSHI_NAME, KALSHI_SERIES, pricesFrom, type GameContracts, type KalshiEvent, type KalshiMarket } from './kalshi.js';

export interface JsonFetcher {
  getJson<T>(url: string): Promise<FetchOutcome<T>>;
}

/** What the service feeds: the engine, in the persistent server. */
export interface MarketTarget {
  marketGames(): GameSummary[];
  setMarketPrices(prices: Map<GameId, MarketPrices | null>): void;
}

export interface MarketServiceOptions {
  fetcher: JsonFetcher;
  base?: string;
  now?: () => number;
  log?: (message: string) => void;
  liveMs?: number;
  idleMs?: number;
  discoveryMs?: number;
  staleMs?: number;
  dropMs?: number;
}

export interface MarketStats {
  source: string;
  reads: number;
  failures: number;
  matchedGames: number;
  lastSuccessAt: string | null;
  lastError: string | null;
}

const HOUR = 3_600_000;
const BATCH = 20;

interface Held {
  prices: MarketPrices;
  print: string;
  readAt: number;
}

const pricePrint = (p: MarketPrices) => fingerprint(JSON.stringify([p.moneyline, p.spread, p.total]));

export class MarketService {
  private readonly base: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly liveMs: number;
  private readonly idleMs: number;
  private readonly discoveryMs: number;
  private readonly staleMs: number;
  private readonly dropMs: number;
  private readonly events = new Map<string, { at: number; list: KalshiEvent[] | null }>();
  private readonly ladders = new Map<string, { at: number; event: KalshiEvent | null }>();
  private readonly held = new Map<GameId, Held>();
  private readonly candleCache = new Map<string, { at: number; candles: PriceCandle[] }>();
  private readonly counters: MarketStats = { source: KALSHI_NAME, reads: 0, failures: 0, matchedGames: 0, lastSuccessAt: null, lastError: null };
  private target: MarketTarget | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly options: MarketServiceOptions) {
    this.base = options.base ?? KALSHI_API;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.liveMs = options.liveMs ?? 15_000;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.discoveryMs = options.discoveryMs ?? 10 * 60_000;
    this.staleMs = options.staleMs ?? 90_000;
    this.dropMs = options.dropMs ?? 10 * 60_000;
  }

  /** Reads prices on a schedule and hands them to `target` (the persistent server). */
  start(target: MarketTarget) {
    if (this.running) return;
    this.running = true;
    this.target = target;
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  stats(): MarketStats {
    return { ...this.counters };
  }

  private async tick() {
    let delay = this.idleMs;
    try {
      const games = this.target?.marketGames() ?? [];
      // Right after a start the engine has not read a slate yet, so look again shortly rather than in five minutes.
      if (!games.length) delay = Math.min(this.liveMs, 5_000);
      else if (games.some((g) => this.urgent(g))) delay = this.liveMs;
      const prices = await this.read(games);
      if (this.running) this.target?.setMarketPrices(prices);
    } catch (e) {
      this.log(`market prices failed: ${(e as Error).message}`);
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => void this.tick(), delay);
        (this.timer as { unref?: () => void }).unref?.();
      }
    }
  }

  /** Live, or scheduled to start within the hour. */
  private urgent(g: GameSummary): boolean {
    if (isLiveOrPaused(g.status.kind)) return true;
    const start = g.startTime ? Date.parse(g.startTime) : Number.NaN;
    return g.status.kind === 'scheduled' && Number.isFinite(start) && start - this.now() < HOUR;
  }

  /** Live, or scheduled to start within three days (and not long past its kickoff). */
  private eligible(g: GameSummary): boolean {
    if (isLiveOrPaused(g.status.kind)) return true;
    if (g.status.kind !== 'scheduled') return false;
    const start = g.startTime ? Date.parse(g.startTime) : Number.NaN;
    return Number.isFinite(start) && start - this.now() < 72 * HOUR && this.now() - start < 6 * HOUR;
  }

  /** Current prices for each game; null for a game that is not eligible, has no matching contracts, or has no usable price. */
  async read(games: GameSummary[]): Promise<Map<GameId, MarketPrices | null>> {
    const out = new Map<GameId, MarketPrices | null>();
    const plans = new Map<GameId, GameContracts>();
    for (const game of games) {
      const plan = this.eligible(game) ? await this.contracts(game) : null;
      if (plan) plans.set(game.id, plan);
      else {
        out.set(game.id, null);
        this.held.delete(game.id);
      }
    }
    this.counters.matchedGames = plans.size;

    const tickers = [...new Set([...plans.values()].flatMap(contractTickers))];
    const markets = new Map<string, KalshiMarket>();
    for (let i = 0; i < tickers.length; i += BATCH) {
      const chunk = tickers.slice(i, i + BATCH);
      const data = await this.get<{ markets?: unknown[] }>(`/markets?tickers=${chunk.map(encodeURIComponent).join(',')}&limit=${BATCH * 2}`);
      for (const m of data?.markets ?? []) {
        if (m && typeof m === 'object' && typeof (m as KalshiMarket).ticker === 'string') markets.set((m as KalshiMarket).ticker, m as KalshiMarket);
      }
    }

    const now = this.now();
    for (const [id, plan] of plans) {
      const before = this.held.get(id);
      if (!contractTickers(plan).some((t) => markets.has(t))) {
        // Nothing came back for this game: keep the last prices for a while, saying they may be old.
        if (before && now - before.readAt < this.dropMs) {
          const stale = now - before.readAt > this.staleMs;
          const prices = stale === before.prices.stale ? before.prices : { ...before.prices, stale };
          this.held.set(id, { ...before, prices });
          out.set(id, prices);
        } else {
          this.held.delete(id);
          out.set(id, null);
        }
        continue;
      }
      const fresh = pricesFrom(plan, markets, new Date(now).toISOString(), false);
      if (!fresh) {
        this.held.delete(id);
        out.set(id, null);
        continue;
      }
      const print = pricePrint(fresh);
      // Unchanged prices keep their object, so the engine sees no change and sends nothing.
      const prices = before && before.print === print ? (before.prices.stale ? { ...before.prices, stale: false } : before.prices) : fresh;
      this.held.set(id, { prices, print, readAt: now });
      out.set(id, prices);
    }
    return out;
  }

  /**
   * The home team's contract to win across time, for a game that is live or starts within three
   * days: hourly prices over the week before kickoff, then minute prices from an hour before it.
   * Minute prices are read at most every 45 seconds while the game is live, hourly prices every 10
   * minutes. Null when the game has no matching contract or fewer than two recorded prices.
   */
  async history(game: GameSummary): Promise<MarketHistory | null> {
    if (!this.eligible(game) || !game.startTime) return null;
    const plan = await this.contracts(game);
    if (!plan?.home) return null;
    const series = KALSHI_SERIES[game.league].game;
    const kickoff = Date.parse(game.startTime);
    const now = this.now();
    const minutesFrom = kickoff - HOUR;
    const hourly = await this.candles(series, plan.home, 60, kickoff - 7 * 24 * HOUR, Math.min(now, minutesFrom), 10 * 60_000);
    const minutes = now > minutesFrom ? await this.candles(series, plan.home, 1, minutesFrom, now, isLiveOrPaused(game.status.kind) ? 45_000 : 5 * 60_000) : [];
    const points = pricePoints([...hourly.filter((c) => c[0] * 1000 <= minutesFrom), ...minutes]);
    return points.length >= 2 ? { source: KALSHI_NAME, team: 'home', points, captured: false } : null;
  }

  private async candles(series: string, ticker: string, minutes: 1 | 60, from: number, to: number, maxAge: number): Promise<PriceCandle[]> {
    if (to <= from) return [];
    const key = `${ticker}|${minutes}`;
    const cached = this.candleCache.get(key);
    if (cached && this.now() - cached.at < maxAge) return cached.candles;
    const data = await this.get<{ candlesticks?: unknown }>(
      `/series/${series}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${Math.floor(from / 1000)}&end_ts=${Math.floor(to / 1000)}&period_interval=${minutes}`,
    );
    const candles = data ? candlesFrom(data.candlesticks) : (cached?.candles ?? []);
    if (this.candleCache.size >= 200) this.candleCache.clear();
    this.candleCache.set(key, { at: this.now(), candles });
    return candles;
  }

  private async contracts(game: GameSummary): Promise<GameContracts | null> {
    const series = KALSHI_SERIES[game.league];
    const events = await this.openEvents(series.game);
    const gameEvent = events ? findGameEvent(events, game) : null;
    if (!gameEvent) return null;
    const suffix = gameEvent.event_ticker.slice(gameEvent.event_ticker.indexOf('-') + 1);
    const spreadEvent = game.lines?.spread ? await this.ladder(`${series.spread}-${suffix}`) : null;
    const totalEvent = game.lines?.total ? await this.ladder(`${series.total}-${suffix}`) : null;
    return contractsFor(game, gameEvent, spreadEvent, totalEvent);
  }

  private async openEvents(seriesTicker: string): Promise<KalshiEvent[] | null> {
    const cached = this.events.get(seriesTicker);
    if (cached && this.now() - cached.at < (cached.list ? this.discoveryMs : 60_000)) return cached.list;
    const list: KalshiEvent[] = [];
    let cursor = '';
    let ok = true;
    for (let page = 0; page < 5; page++) {
      const data = await this.get<{ events?: unknown[]; cursor?: unknown }>(`/events?series_ticker=${seriesTicker}&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!data) {
        ok = false;
        break;
      }
      list.push(...(data.events ?? []).filter(isKalshiEvent));
      cursor = typeof data.cursor === 'string' ? data.cursor : '';
      if (!cursor) break;
    }
    const value = ok ? list : (cached?.list ?? null);
    this.events.set(seriesTicker, { at: this.now(), list: value });
    return value;
  }

  private async ladder(eventTicker: string): Promise<KalshiEvent | null> {
    const cached = this.ladders.get(eventTicker);
    if (cached && this.now() - cached.at < this.discoveryMs) return cached.event;
    const data = await this.get<{ event?: unknown; markets?: unknown[] }>(`/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`);
    const raw = data?.event;
    const event = isKalshiEvent(raw) ? { ...raw, markets: raw.markets ?? ((data?.markets ?? []) as KalshiMarket[]) } : null;
    const value = event ?? cached?.event ?? null;
    this.ladders.set(eventTicker, { at: this.now(), event: value });
    return value;
  }

  private async get<T>(path: string): Promise<T | null> {
    this.counters.reads++;
    const res = await this.options.fetcher.getJson<T>(`${this.base}${path}`);
    if (res.ok) {
      this.counters.lastSuccessAt = new Date(res.receivedAt).toISOString();
      this.counters.lastError = null;
      return res.data;
    }
    this.counters.failures++;
    this.counters.lastError = res.error;
    return null;
  }
}
