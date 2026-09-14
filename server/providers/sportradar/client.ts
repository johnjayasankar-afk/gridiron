/**
 * Sportradar HTTP client.
 *
 * The shared ProviderFetcher cannot be reused here: its getJson takes only a
 * URL, so it cannot send the x-api-key header Sportradar requires, and it
 * budgets requests per minute while Sportradar limits queries per second per
 * key. This client covers exactly that:
 *
 * - Request starts for one key are spaced at least 1000 / qps milliseconds apart,
 *   in call order. Trial plans allow 1 query per second.
 * - HTTP 429 (throttled, or the plan's quota is used up) backs the key off with
 *   exponential delay and jitter, capped. While backing off, requests fail at
 *   once with the reason instead of spending more queries.
 * - Identical in-flight requests for the same key share one query.
 * - Every attempt has a timeout. There are no automatic retries: the engine polls
 *   again on its own schedule, and a trial plan allows 1,000 requests per 30 days.
 * - The key travels only in the header. It never appears in a URL, an error or stats.
 */
import type { LeagueId } from '../../../shared/model.js';
import type { FetchOutcome } from '../../fetcher.js';
import type { ApiKey, SportradarAccessLevel } from './config.js';

// ---------------------------------------------------------------- feeds

const restBase = (league: LeagueId, level: SportradarAccessLevel) =>
  league === 'nfl' ? `https://api.sportradar.com/nfl/official/${level}/v7/en` : `https://api.sportradar.com/ncaafb/${level}/v7/en`;

export const seasonScheduleUrl = (league: LeagueId, level: SportradarAccessLevel) => `${restBase(league, level)}/games/current_season/schedule.json`;

export const boxscoreUrl = (league: LeagueId, level: SportradarAccessLevel, gameUuid: string) =>
  `${restBase(league, level)}/games/${encodeURIComponent(gameUuid)}/boxscore.json`;

export const playByPlayUrl = (league: LeagueId, level: SportradarAccessLevel, gameUuid: string) =>
  `${restBase(league, level)}/games/${encodeURIComponent(gameUuid)}/pbp.json`;

export const pushEventsUrl = (league: LeagueId, level: SportradarAccessLevel) =>
  league === 'nfl'
    ? `https://api.sportradar.com/nfl/official/${level}/stream/en/events/subscribe`
    : `https://api.sportradar.com/ncaafb/${level}/stream/en/events/subscribe`;

/** Plain meaning of the documented error statuses. */
export function describeStatus(status: number): string {
  if (status === 429) return "HTTP 429: Sportradar throttled the request, or the plan's request quota is used up";
  if (status === 403) return 'HTTP 403: the API key is not authorized for this feed or access level';
  return `HTTP ${status}`;
}

// ---------------------------------------------------------------- client

export interface SportradarClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  /** Queries per second allowed per key. Defaults to 1, the trial limit. */
  queriesPerSecond?: number;
  timeoutMs?: number;
  /** First back-off after a 429. It doubles with each consecutive 429, up to maxBackoffMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface SportradarClientStats {
  started: number;
  succeeded: number;
  failed: number;
  throttled: number;
  shared: number;
  refusedWhileBackingOff: number;
  backoffUntil: number;
}

interface Lane {
  key: ApiKey;
  nextStartAt: number;
  backoffUntil: number;
  consecutiveThrottles: number;
  tail: Promise<unknown>;
  inflight: Map<string, Promise<FetchOutcome<unknown>>>;
}

type Attempt = FetchOutcome<unknown> & { retryAfterMs?: number | null };

export class SportradarClient {
  private readonly lanes: Lane[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly spacingMs: number;
  private readonly timeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly counters = { started: 0, succeeded: 0, failed: 0, throttled: 0, shared: 0, refusedWhileBackingOff: 0 };

  constructor(options: SportradarClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    const qps = options.queriesPerSecond !== undefined && Number.isFinite(options.queriesPerSecond) && options.queriesPerSecond > 0 ? options.queriesPerSecond : 1;
    this.spacingMs = Math.ceil(1000 / qps);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  }

  /** GET a JSON feed with the key's header, inside the key's rate limit. */
  getJson<T = unknown>(url: string, key: ApiKey): Promise<FetchOutcome<T>> {
    const lane = this.laneFor(key);
    const existing = lane.inflight.get(url);
    if (existing) {
      this.counters.shared++;
      return existing as Promise<FetchOutcome<T>>;
    }
    const run = this.run(url, lane).finally(() => lane.inflight.delete(url));
    lane.inflight.set(url, run);
    return run as Promise<FetchOutcome<T>>;
  }

  /** Until when requests for this key are refused after a 429, or 0. */
  backoffUntil(key: ApiKey): number {
    const lane = this.lanes.find((l) => l.key.equals(key));
    return lane && lane.backoffUntil > this.now() ? lane.backoffUntil : 0;
  }

  stats(): SportradarClientStats {
    return { ...this.counters, backoffUntil: Math.max(0, ...this.lanes.map((l) => l.backoffUntil)) };
  }

  private laneFor(key: ApiKey): Lane {
    let lane = this.lanes.find((l) => l.key.equals(key));
    if (!lane) {
      lane = { key, nextStartAt: 0, backoffUntil: 0, consecutiveThrottles: 0, tail: Promise.resolve(), inflight: new Map() };
      this.lanes.push(lane);
    }
    return lane;
  }

  /** Wait for this key's next start slot. Resolves false when the key is backing off. */
  private reserve(lane: Lane): Promise<boolean> {
    const turn = lane.tail.then(async () => {
      if (this.now() < lane.backoffUntil) return false;
      const wait = lane.nextStartAt - this.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.now() < lane.backoffUntil) return false;
      lane.nextStartAt = this.now() + this.spacingMs;
      return true;
    });
    lane.tail = turn.catch(() => undefined);
    return turn;
  }

  private async run(url: string, lane: Lane): Promise<FetchOutcome<unknown>> {
    const go = await this.reserve(lane);
    if (!go) {
      this.counters.refusedWhileBackingOff++;
      return {
        ok: false,
        error: `Not requested: backing off after HTTP 429 until ${new Date(lane.backoffUntil).toISOString()}`,
        status: null,
        receivedAt: this.now(),
        retryable: true,
      };
    }
    this.counters.started++;
    const outcome = await this.attempt(url, lane.key);
    if (outcome.ok) {
      this.counters.succeeded++;
      lane.consecutiveThrottles = 0;
      return outcome;
    }
    this.counters.failed++;
    if (outcome.status === 429) {
      this.counters.throttled++;
      lane.consecutiveThrottles++;
      lane.backoffUntil = Math.max(lane.backoffUntil, this.now() + this.backoffDelay(lane.consecutiveThrottles, outcome.retryAfterMs ?? null));
    }
    return { ok: false, error: outcome.error, status: outcome.status, receivedAt: outcome.receivedAt, retryable: outcome.retryable };
  }

  /** Exponential in the number of consecutive 429s, with jitter in [half, full], never above the cap. */
  private backoffDelay(consecutive: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return Math.min(this.maxBackoffMs, retryAfterMs);
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, consecutive - 1));
    return Math.round(exp * (0.5 + this.random() * 0.5));
  }

  private async attempt(url: string, key: ApiKey): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { headers: { 'x-api-key': key.reveal() }, signal: controller.signal });
      const receivedAt = this.now();
      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
        void res.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          error: describeStatus(res.status),
          status: res.status,
          receivedAt,
          retryable: res.status === 429 || res.status >= 500,
          retryAfterMs: seconds !== null ? seconds * 1000 : null,
        };
      }
      const text = await res.text();
      try {
        return { ok: true, data: JSON.parse(text) as unknown, status: res.status, receivedAt, bytes: text.length };
      } catch {
        return { ok: false, error: 'Response was not valid JSON', status: res.status, receivedAt, retryable: false };
      }
    } catch (e) {
      return {
        ok: false,
        error: controller.signal.aborted ? `Timed out after ${this.timeoutMs}ms` : `Network error: ${(e as Error).message}`,
        status: null,
        receivedAt: this.now(),
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
