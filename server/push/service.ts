/**
 * Web Push alerts for favorite teams, from the same alert engine the app runs.
 *
 * - Watches only while someone is subscribed: a synthetic engine client for today's slate, and between midnight and
 *   6 AM US Eastern one for yesterday's, where late games still run. Its interest monitors just the live games of
 *   subscribed teams, so the engine polls play-by-play for those games and no others.
 * - Every notification is an AlertEngine moment from a real observed change. A game's first observation is only a
 *   baseline, so a restart never announces history, and a game that stops being watched is forgotten, so watching
 *   it again starts a fresh baseline. An update that ends a feed outage counts as following a gap, so what it
 *   brings is late news.
 * - A moment goes to each subscription that follows one of its teams and chose its kind. Late moments are skipped,
 *   except a final result. When a delivered moment is corrected or withdrawn, the notification is sent again under
 *   the same tag as a correction, only where an earlier version arrived.
 * - Replays say so, in the title and in the payload.
 * - Delivery runs at most four at a time and one at a time per subscription, with a cap per subscription. A
 *   retryable failure gets one retry. A subscription the push service calls gone is removed at once, and one it
 *   refuses five times in a row is removed too.
 * - Logs name an endpoint's host, never the endpoint or its keys.
 */
import { randomUUID } from 'node:crypto';
import { ALERT_KINDS, AlertEngine, DEFAULT_ALERT_RULES, type AlertChange, type AlertRules } from '../../shared/alerts.js';
import { scoreText } from '../../shared/format.js';
import type { Alert, AlertKind, Division, Freshness, GameDetail, GameId, GameSummary, LeagueId, TeamKey } from '../../shared/model.js';
import { isLiveOrPaused } from '../../shared/model.js';
import { PUSH_KINDS, type PushPayload } from '../../shared/push.js';
import { mergeSummaries } from '../../shared/situation.js';
import { shiftDateKey } from '../../shared/util.js';
import type { ClientInterest, EngineMessage, GridironEngine } from '../engine.js';
import type { PushRecord, PushStore, PushSubscriptionInput, UpsertResult } from './store.js';
import { MAX_PAYLOAD_BYTES, sendPush, type PushResult, type PushUrgency, type VapidKeys, type WebPushKeys } from './webpush.js';

export { DEFAULT_PUSH_KINDS, PUSH_KINDS, type PushPayload } from '../../shared/push.js';

/** The part of the engine push alerts use, so tests can stand in for it. */
export type PushEngine = Pick<GridironEngine, 'connect' | 'setInterest' | 'today' | 'clock' | 'peekDetail' | 'mode'>;

export interface PushServiceOptions {
  engine: PushEngine;
  store: PushStore;
  vapid: VapidKeys;
  subject: string;
  /** Exact host:port entries allowed besides the known push services (a local test service). */
  allowHosts?: string[];
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  /** Sends in flight at once (4). */
  concurrency?: number;
  /** Alerts one subscription may get per window (12 per 5 minutes). Extras are dropped and counted. */
  perSubscriptionLimit?: number;
  perSubscriptionWindowMs?: number;
  /** The shortest wait before the one retry of a retryable failure (30 seconds). */
  retryDelayMs?: number;
  /** Refusals in a row that remove a subscription (5). */
  maxFailures?: number;
  /** The shortest time between test notifications for one subscription (30 seconds). */
  testCooldownMs?: number;
  /** How often the watched days are checked (every minute). */
  checkIntervalMs?: number;
  /** Per push request (ten seconds by default). */
  timeoutMs?: number;
}

export type TestPushResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'gone' | 'refused'; error: string }
  | { ok: false; reason: 'cooldown'; error: string; retryAfterSeconds: number };

export interface PushStats {
  subscriptions: number;
  /** Live games the engine is monitoring for push alerts. */
  watchedGames: number;
  /** Messages push services accepted. */
  sent: number;
  /** Sends that did not arrive, including subscriptions found gone. */
  failed: number;
  /** Alerts not sent because a subscription reached its cap, or the queue was full. */
  dropped: number;
  lastSendAt: string | null;
}

const PUSH_RULES: AlertRules = {
  ...DEFAULT_ALERT_RULES,
  scope: 'favorites',
  enabled: Object.fromEntries(ALERT_KINDS.map((kind) => [kind, PUSH_KINDS.includes(kind)])) as Record<AlertKind, boolean>,
};
const WATCH_DIVISIONS: Division[] = ['FBS', 'FCS'];
/** The engine keeps at most this many monitored games per client. */
const MAX_MONITORED = 64;
/** Before this hour (US Eastern), yesterday's late games are watched too. */
const LATE_NIGHT_END_HOUR = 6;
const ALERT_TTL_SECONDS = 60 * 60;
const TEST_TTL_SECONDS = 10 * 60;
/** Moments are remembered this long for corrections. A correction to anything older is not sent. */
const MOMENT_MEMORY_MS = 3 * 60 * 60_000;
const MAX_MOMENTS = 2_000;
const MAX_QUEUED = 50_000;
/** A feed that fails for longer than this and comes back brings late news. */
const OUTAGE_GAP_MS = 2 * 60_000;
const MAX_TEAM_NAMES = 4_000;
const EASTERN_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });

interface Watch {
  date: string;
  clientId: string;
  disconnect: (() => void) | null;
  interestKey: string;
  monitored: GameId[];
}

interface Moment {
  alert: Alert;
  /** The game as observed with the alert's latest revision, for its score line. */
  game: GameSummary;
  /** Engine time of that observation. */
  at: number;
  replay: boolean;
  /** When this service first saw the moment, on its own clock. */
  since: number;
  /** The status each subscription (by id) was last sent. */
  delivered: Map<string, Alert['status']>;
  /** Subscriptions with a send of this moment in flight. */
  sending: Set<string>;
}

interface Job {
  subscriptionId: string;
  endpoint: string;
  alertId: string;
  correction: boolean;
  retried: boolean;
}

function easternHour(ms: number): number {
  const hour = Number(EASTERN_HOUR.formatToParts(new Date(ms)).find((part) => part.type === 'hour')?.value);
  return Number.isFinite(hour) ? hour : 12;
}

const parseTime = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const involves = (game: GameSummary, teams: ReadonlySet<TeamKey>) => teams.has(game.home.key) || teams.has(game.away.key);

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || 'an unknown host';
  } catch {
    return 'an unknown host';
  }
}

/** A push service's reason, with the endpoint taken out in case the service echoed it. */
function scrub(text: string, endpoint: string): string {
  let out = text.split(endpoint).join('<endpoint>');
  try {
    const { pathname } = new URL(endpoint);
    if (pathname.length > 1) out = out.split(pathname).join('<path>');
  } catch {
    // not a URL, so nothing more to take out
  }
  return out;
}

/** "BUF", "BUF and KC", "BUF, KC and 2 more teams". */
function listText(names: string[], more: number): string {
  const parts = more > 0 ? [...names, `${more} more ${more === 1 ? 'team' : 'teams'}`] : names;
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const fits = (payload: PushPayload) => Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES;

/** The longest cut of one text field, at a character boundary and ending in an ellipsis, that lets the payload fit. */
function shorten(payload: PushPayload, field: 'body' | 'title'): PushPayload {
  const chars = Array.from(payload[field]);
  const cut = (n: number): PushPayload => {
    const text = `${chars.slice(0, n).join('')}…`;
    return field === 'body' ? { ...payload, body: text } : { ...payload, title: text };
  };
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(cut(mid))) low = mid;
    else high = mid - 1;
  }
  return cut(Math.max(0, low));
}

/** The payload as JSON, with the body (and then, if need be, the title) cut short to fit one push message. */
export function encodePayload(payload: PushPayload): string {
  let fitted = payload;
  if (!fits(fitted)) fitted = shorten(fitted, 'body');
  if (!fits(fitted)) fitted = shorten(fitted, 'title');
  return JSON.stringify(fitted);
}

function momentPayload(moment: Moment, correction: boolean): PushPayload {
  const { alert, game } = moment;
  const score = scoreText(game);
  return {
    v: 1,
    title: `${moment.replay ? 'Replay: ' : ''}${correction ? 'Correction: ' : ''}${alert.title}`,
    // Some moments already carry the score line; it is not repeated.
    body: alert.detail.includes(score) ? alert.detail : [alert.detail, score].filter(Boolean).join(' · '),
    tag: alert.id,
    url: `/game/${encodeURIComponent(alert.gameId)}`,
    gameId: alert.gameId,
    kind: alert.kind,
    at: moment.at,
    replay: moment.replay,
  };
}

export class PushService {
  readonly publicKey: string;
  private readonly engine: PushEngine;
  private readonly store: PushStore;
  private readonly vapid: VapidKeys;
  private readonly subject: string;
  private readonly hosts: string[];
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly concurrency: number;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly retryDelayMs: number;
  private readonly maxFailures: number;
  private readonly testCooldownMs: number;
  private readonly checkIntervalMs: number;
  private readonly timeoutMs: number | undefined;
  private readonly alerts = new AlertEngine(PUSH_RULES);
  /** Watch client ids nobody can guess, so no browser stream can take a watch over by reusing its id. */
  private readonly instance = randomUUID();
  private running = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private syncAgain = false;
  private readonly watches = new Map<string, Watch>();
  /** The latest summary of each game on a watched day, and the days that list it. */
  private readonly games = new Map<GameId, GameSummary>();
  private readonly gameDates = new Map<GameId, Set<string>>();
  /** Games the alert engine holds memory for. */
  private readonly observed = new Set<GameId>();
  /** Live games of subscribed teams left out of the engine's monitored list by its limit. */
  private unmonitored = new Set<GameId>();
  /** Feeds that are failing, with their last success before the failures (NaN when there was none). */
  private readonly feedDown = new Map<string, number>();
  private readonly teamNames = new Map<TeamKey, string>();
  private readonly moments = new Map<string, Moment>();
  private readonly pending = new Map<string, Job[]>();
  private readonly ready: string[] = [];
  private readonly inFlight = new Set<string>();
  private queued = 0;
  private active = 0;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly recent = new Map<string, number[]>();
  private readonly tests = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];
  private sent = 0;
  private failed = 0;
  private dropped = 0;
  private lastSendAt: number | null = null;

  constructor(options: PushServiceOptions) {
    this.engine = options.engine;
    this.store = options.store;
    this.vapid = options.vapid;
    this.subject = options.subject;
    this.publicKey = options.vapid.publicKey;
    this.hosts = [...(options.allowHosts ?? [])];
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.limit = options.perSubscriptionLimit ?? 12;
    this.windowMs = options.perSubscriptionWindowMs ?? 5 * 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.maxFailures = options.maxFailures ?? 5;
    this.testCooldownMs = options.testCooldownMs ?? 30_000;
    this.checkIntervalMs = options.checkIntervalMs ?? 60_000;
    this.timeoutMs = options.timeoutMs;
  }

  /** Exact host:port entries allowed besides the known push services. */
  get allowHosts(): string[] {
    return [...this.hosts];
  }

  // ------------------------------------------------------------ lifecycle

  start() {
    if (this.running) return;
    this.running = true;
    this.checkTimer = setInterval(() => this.tick(), this.checkIntervalMs);
    (this.checkTimer as { unref?: () => void }).unref?.();
    this.refresh();
  }

  /** Stops watching and sending. Sends already in flight finish; nothing queued or scheduled goes out. */
  stop() {
    this.running = false;
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.pending.clear();
    this.ready.length = 0;
    this.queued = 0;
    this.refresh();
    this.settle();
  }

  /** Resolves once nothing is queued or being sent. Scheduled retries are not waited for. */
  idle(): Promise<void> {
    if (this.active === 0 && this.queued === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stats(): PushStats {
    const watched = new Set<GameId>();
    for (const watch of this.watches.values()) for (const id of watch.monitored) watched.add(id);
    return {
      subscriptions: this.store.size,
      watchedGames: watched.size,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      lastSendAt: this.lastSendAt === null ? null : new Date(this.lastSendAt).toISOString(),
    };
  }

  // ------------------------------------------------------------ subscriptions

  subscribe(input: PushSubscriptionInput): UpsertResult {
    const result = this.store.upsert(input);
    if (result.ok) this.refresh();
    return result;
  }

  unsubscribe(endpoint: string): boolean {
    const removed = typeof endpoint === 'string' && this.store.remove(endpoint);
    if (removed) this.refresh();
    return removed;
  }

  /** Moves teams and kinds from a replaced subscription to its successor. */
  resubscribe(oldEndpoint: string, next: { endpoint: string; keys: WebPushKeys }): UpsertResult {
    const result = this.store.transfer(oldEndpoint, next);
    if (result.ok) this.refresh();
    return result;
  }

  /** The "alerts are on" notification for one subscription, at most once per cooldown. */
  async sendTest(endpoint: string): Promise<TestPushResult> {
    const record = typeof endpoint === 'string' ? this.store.get(endpoint) : null;
    if (!record) return { ok: false, reason: 'unknown', error: 'This browser is not subscribed to push alerts' };
    const now = this.now();
    const last = this.tests.get(record.id);
    if (last !== undefined && last <= now && now - last < this.testCooldownMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((last + this.testCooldownMs - now) / 1000));
      return { ok: false, reason: 'cooldown', error: 'A test notification was just sent; try again shortly', retryAfterSeconds };
    }
    this.tests.set(record.id, now);
    const result = await this.attempt(record, encodePayload(this.testPayload(record)), TEST_TTL_SECONDS, 'high');
    if (result.ok) {
      this.succeeded(record);
      return { ok: true };
    }
    this.failedWith(record, result);
    if ('gone' in result) return { ok: false, reason: 'gone', error: 'The push service no longer accepts this subscription. Turn alerts off and on again' };
    const error = result.retryable
      ? 'The push service is not taking messages right now; try again shortly'
      : `The push service refused the test notification${result.status ? ` (HTTP ${result.status})` : ''}`;
    return { ok: false, reason: 'refused', error };
  }

  // ------------------------------------------------------------ watching

  /** Re-evaluates the watched days, what the engine monitors and which teams count as favorites. Safe inside engine callbacks. */
  refresh() {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      // Connecting or changing interest can deliver messages at once, and those can change what should be monitored.
      for (let pass = 0; pass < 5; pass++) {
        this.syncAgain = false;
        this.sync();
        if (!this.syncAgain) break;
      }
    } catch (e) {
      this.log(`push watch update failed: ${(e as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  private tick() {
    const now = this.now();
    for (const [id, times] of this.recent) if (!times.some((t) => t <= now && now - t < this.windowMs)) this.recent.delete(id);
    for (const [id, at] of this.tests) if (at > now || now - at >= this.testCooldownMs) this.tests.delete(id);
    this.refresh();
  }

  private sync() {
    const teams = new Set(this.store.teams());
    this.alerts.setContext({ favorites: [...teams], monitored: [], muted: [] });
    const dates = this.running && teams.size > 0 ? this.wantedDates() : [];
    for (const watch of [...this.watches.values()]) if (!dates.includes(watch.date)) this.unwatch(watch);
    // A game no subscribed team plays in is forgotten, so following it again starts from a fresh baseline.
    for (const id of [...this.observed]) {
      const game = this.games.get(id);
      if (!game || !involves(game, teams)) this.forget(id);
    }
    // A game a new subscription follows gets its baseline now, so its next change is news.
    for (const [id, game] of this.games) if (!this.observed.has(id) && involves(game, teams)) this.observe(game, this.detailFor(id), false);

    this.unmonitored = new Set();
    for (const date of dates) {
      const interest = this.interestFor(date, teams);
      const key = JSON.stringify(interest);
      const watch = this.watches.get(date);
      if (!watch) {
        const created: Watch = { date, clientId: `push-${this.instance}-${date}`, disconnect: null, interestKey: key, monitored: interest.monitored };
        this.watches.set(date, created);
        created.disconnect = this.engine.connect(created.clientId, interest, (message) => this.onMessage(created, message));
      } else if (key !== watch.interestKey) {
        watch.interestKey = key;
        watch.monitored = interest.monitored;
        if (!this.engine.setInterest(watch.clientId, interest)) {
          // The engine no longer knows the client: connect again on the next pass.
          this.unwatch(watch);
          this.syncAgain = true;
        }
      }
    }
  }

  private wantedDates(): string[] {
    const today = this.engine.today();
    return easternHour(this.engine.clock()) < LATE_NIGHT_END_HOUR ? [today, shiftDateKey(today, -1)] : [today];
  }

  private interestFor(date: string, teams: ReadonlySet<TeamKey>): ClientInterest {
    let live: GameId[] = [];
    for (const [id, dates] of this.gameDates) {
      const game = this.games.get(id);
      if (game && dates.has(date) && isLiveOrPaused(game.status.kind) && involves(game, teams)) live.push(id);
    }
    live.sort();
    if (live.length > MAX_MONITORED) {
      // Over the engine's limit, the games with the most followers are monitored first.
      const followers = new Map<TeamKey, number>();
      for (const record of this.store.list()) for (const team of record.teams) followers.set(team, (followers.get(team) ?? 0) + 1);
      const weight = (id: GameId) => {
        const game = this.games.get(id)!;
        return (followers.get(game.home.key) ?? 0) + (followers.get(game.away.key) ?? 0);
      };
      live.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
      for (const id of live.slice(MAX_MONITORED)) this.unmonitored.add(id);
      live = live.slice(0, MAX_MONITORED).sort();
    }
    return { date, divisions: [...WATCH_DIVISIONS], focus: [], visible: [], monitored: live, alertsAllGames: false };
  }

  private unwatch(watch: Watch) {
    this.watches.delete(watch.date);
    watch.disconnect?.();
    for (const id of [...this.gameDates.keys()]) this.dropFromDate(id, watch.date);
    for (const key of [...this.feedDown.keys()]) if (key.startsWith(`slate|${watch.date}|`)) this.feedDown.delete(key);
  }

  private dropFromDate(id: GameId, date: string) {
    const dates = this.gameDates.get(id);
    if (!dates || !dates.delete(date) || dates.size) return;
    this.gameDates.delete(id);
    this.games.delete(id);
    this.feedDown.delete(`detail|${id}`);
    this.forget(id);
  }

  private forget(id: GameId) {
    if (this.observed.delete(id)) this.alerts.forget(id);
  }

  private detailFor(id: GameId): GameDetail | null {
    return this.engine.peekDetail(id)?.detail ?? null;
  }

  private onMessage(watch: Watch, message: EngineMessage) {
    if (!this.running || this.watches.get(watch.date) !== watch) return;
    try {
      const teams = new Set(this.store.teams());
      switch (message.type) {
        case 'slate': {
          const gaps = this.slateGaps(watch.date, message.snapshot.freshness);
          const present = new Set(message.snapshot.games.map((game) => game.id));
          for (const [id, dates] of [...this.gameDates]) if (dates.has(watch.date) && !present.has(id)) this.dropFromDate(id, watch.date);
          for (const game of message.snapshot.games) this.update(watch.date, game, teams, gaps[game.league]);
          break;
        }
        case 'slate-delta': {
          const gaps = this.slateGaps(watch.date, message.freshness);
          for (const id of message.removed) this.dropFromDate(id, watch.date);
          for (const game of message.upserts) this.update(watch.date, game, teams, gaps[game.league]);
          break;
        }
        case 'detail':
        case 'detail-delta': {
          const gap = this.feedGap(`detail|${message.gameId}`, message.freshness);
          // The engine has already merged a delta into the detail it holds, so the whole detail is read from there.
          const detail = this.detailFor(message.gameId) ?? (message.type === 'detail' ? message.detail : null);
          if (detail) this.update(null, detail.summary, teams, gap, detail);
          break;
        }
        case 'detail-freshness':
          this.feedGap(`detail|${message.gameId}`, message.freshness);
          break;
      }
    } catch (e) {
      this.log(`could not use an engine update for push alerts: ${(e as Error).message}`);
    }
    this.refresh();
  }

  private slateGaps(date: string, freshness: Record<LeagueId, Freshness> | undefined): Record<LeagueId, boolean> {
    return { nfl: this.feedGap(`slate|${date}|nfl`, freshness?.nfl), cfb: this.feedGap(`slate|${date}|cfb`, freshness?.cfb) };
  }

  /** Whether this update ends a run of failures longer than OUTAGE_GAP_MS for its feed, so what it brings may be old news. */
  private feedGap(key: string, freshness: Freshness | undefined): boolean {
    if (!freshness) return false;
    if (freshness.consecutiveFailures > 0) {
      if (!this.feedDown.has(key)) this.feedDown.set(key, parseTime(freshness.lastSuccessAt));
      return false;
    }
    const since = this.feedDown.get(key);
    if (since === undefined) return false;
    this.feedDown.delete(key);
    return Number.isFinite(since) && parseTime(freshness.lastSuccessAt) - since > OUTAGE_GAP_MS;
  }

  /** Records a game on a watched day (or, with no day, detail for a game already on one) and observes it when a subscribed team plays. */
  private update(date: string | null, incoming: GameSummary, teams: ReadonlySet<TeamKey>, gap: boolean, detail?: GameDetail) {
    let dates = this.gameDates.get(incoming.id);
    if (!dates) {
      if (date === null) return;
      dates = new Set();
      this.gameDates.set(incoming.id, dates);
    }
    if (date !== null) dates.add(date);
    const previous = this.games.get(incoming.id);
    const game = previous ? mergeSummaries(previous, incoming) : incoming;
    this.games.set(game.id, game);
    if (this.teamNames.size > MAX_TEAM_NAMES) this.teamNames.clear();
    for (const team of [game.home, game.away]) if (team.abbreviation) this.teamNames.set(team.key, team.abbreviation);
    if (involves(game, teams)) this.observe(game, detail ?? this.detailFor(game.id), gap);
  }

  private observe(game: GameSummary, detail: GameDetail | null, gap: boolean) {
    // Play-by-play is on its way for a live full-coverage game the engine monitors, so a score change waits for its play.
    const detailExpected = detail !== null || (game.coverage.level !== 'score-only' && isLiveOrPaused(game.status.kind) && !this.unmonitored.has(game.id));
    const at = this.engine.clock();
    const changes = this.alerts.observe(game, detail, at, { gap, detailExpected });
    this.observed.add(game.id);
    for (const change of changes) this.onChange(change, game, at);
  }

  // ------------------------------------------------------------ fan-out

  private onChange(change: AlertChange, game: GameSummary, at: number) {
    const { alert } = change;
    if (!PUSH_KINDS.includes(alert.kind)) return;
    if (change.type === 'created') {
      if (alert.late && alert.kind !== 'final') return;
      const moment: Moment = { alert, game, at, replay: this.engine.mode === 'replay', since: this.now(), delivered: new Map(), sending: new Set() };
      this.remember(moment);
      for (const record of this.store.list()) {
        if (!record.kinds.includes(alert.kind) || !(record.teams.includes(game.home.key) || record.teams.includes(game.away.key))) continue;
        if (!this.takeSlot(record.id)) {
          this.dropped++;
          continue;
        }
        this.enqueue({ subscriptionId: record.id, endpoint: record.endpoint, alertId: alert.id, correction: false, retried: false });
      }
      return;
    }
    const moment = this.moments.get(alert.id);
    if (!moment) return;
    const newStatus = alert.status !== 'active' && alert.status !== moment.alert.status;
    moment.alert = alert;
    moment.game = game;
    moment.at = at;
    if (!newStatus) return;
    // An original still queued sends the latest version itself. A correction is owed only where a version arrived or is arriving.
    const owed = new Set([...moment.delivered.keys(), ...moment.sending]);
    if (!owed.size) return;
    for (const record of this.store.list()) {
      if (owed.has(record.id)) this.enqueue({ subscriptionId: record.id, endpoint: record.endpoint, alertId: alert.id, correction: true, retried: false });
    }
  }

  private remember(moment: Moment) {
    this.moments.delete(moment.alert.id);
    this.moments.set(moment.alert.id, moment);
    const now = this.now();
    for (const [id, old] of this.moments) {
      if (this.moments.size <= MAX_MOMENTS && now - old.since < MOMENT_MEMORY_MS) break;
      this.moments.delete(id);
    }
  }

  /** Counts one alert against a subscription's cap. False when the cap is reached. */
  private takeSlot(id: string): boolean {
    const now = this.now();
    const times = (this.recent.get(id) ?? []).filter((t) => t <= now && now - t < this.windowMs);
    const allowed = times.length < this.limit;
    if (allowed) times.push(now);
    this.recent.set(id, times);
    return allowed;
  }

  private testPayload(record: PushRecord): PushPayload {
    const names = record.teams.map((team) => this.teamNames.get(team)).filter((name): name is string => Boolean(name));
    const shown = names.slice(0, 6);
    return {
      v: 1,
      title: 'Gridiron alerts are on',
      body: shown.length ? `You will get alerts for ${listText(shown, record.teams.length - shown.length)}.` : 'You will get alerts for your favorite teams.',
      tag: 'gridiron-test',
      url: '/',
      gameId: null,
      kind: 'test',
      at: this.now(),
      replay: false,
    };
  }

  // ------------------------------------------------------------ delivery

  private enqueue(job: Job) {
    if (!this.running) return;
    if (this.queued >= MAX_QUEUED) {
      this.dropped++;
      return;
    }
    const list = this.pending.get(job.subscriptionId);
    if (list) list.push(job);
    else {
      this.pending.set(job.subscriptionId, [job]);
      if (!this.inFlight.has(job.subscriptionId)) this.ready.push(job.subscriptionId);
    }
    this.queued++;
    this.pump();
  }

  /** Starts sends up to the concurrency limit, taking subscriptions in turn and each one's jobs in order. */
  private pump() {
    while (this.active < this.concurrency && this.ready.length) {
      const id = this.ready.shift()!;
      const list = this.pending.get(id);
      const job = list?.shift();
      if (!list?.length) this.pending.delete(id);
      if (!job) continue;
      this.queued--;
      this.active++;
      this.inFlight.add(id);
      void this.run(job).finally(() => {
        this.active--;
        this.inFlight.delete(id);
        if (this.pending.has(id)) this.ready.push(id);
        this.pump();
        this.settle();
      });
    }
  }

  private settle() {
    if (this.active === 0 && this.queued === 0) for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async run(job: Job): Promise<void> {
    try {
      const moment = this.moments.get(job.alertId);
      const record = this.store.get(job.endpoint);
      if (!moment || !record || record.id !== job.subscriptionId) return;
      const { status, priority } = moment.alert;
      const seen = moment.delivered.get(record.id);
      // An original goes out once, as its latest version, unless it was withdrawn before it went. A correction goes only
      // where an earlier version arrived, and only with a status new there.
      if (job.correction ? seen === undefined || seen === status : seen !== undefined || status === 'withdrawn') return;
      const payload = encodePayload(momentPayload(moment, job.correction));
      moment.sending.add(record.id);
      let result: PushResult;
      try {
        result = await this.attempt(record, payload, ALERT_TTL_SECONDS, priority === 1 ? 'high' : 'normal');
      } finally {
        moment.sending.delete(record.id);
      }
      if (result.ok) {
        moment.delivered.set(record.id, status);
        this.succeeded(record);
        return;
      }
      if (result.retryable && !job.retried) {
        const waitMs = Math.max(('retryAfterSeconds' in result ? (result.retryAfterSeconds ?? 0) : 0) * 1000, this.retryDelayMs);
        // A retry after the message would have expired anyway is not worth making.
        if (waitMs < ALERT_TTL_SECONDS * 1000) {
          this.retryLater(job, waitMs);
          return;
        }
      }
      this.failedWith(record, result);
    } catch (e) {
      this.failed++;
      this.log(`push delivery failed unexpectedly: ${(e as Error).message}`);
    }
  }

  private retryLater(job: Job, waitMs: number) {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.enqueue({ ...job, retried: true });
    }, waitMs);
    (timer as { unref?: () => void }).unref?.();
    this.retryTimers.add(timer);
  }

  /** One POST to the push service. Inputs sendPush refuses outright come back as a rejection instead of an exception. */
  private async attempt(record: PushRecord, payload: string, ttlSeconds: number, urgency: PushUrgency): Promise<PushResult> {
    try {
      return await sendPush({ endpoint: record.endpoint, keys: record.keys }, payload, {
        vapid: this.vapid,
        subject: this.subject,
        ttlSeconds,
        urgency,
        fetch: this.fetchImpl,
        allowHosts: this.hosts,
        timeoutMs: this.timeoutMs,
      });
    } catch (e) {
      return { ok: false, status: 0, retryable: false, error: (e as Error).message };
    }
  }

  private succeeded(record: PushRecord) {
    this.sent++;
    this.lastSendAt = this.now();
    this.store.markSuccess(record.endpoint);
  }

  /** A send that did not arrive. Gone is removed at once; a refusal counts toward removal; failing to reach the service does not. */
  private failedWith(record: PushRecord, result: Exclude<PushResult, { ok: true }>) {
    this.failed++;
    const host = hostOf(record.endpoint);
    if ('gone' in result) {
      if (this.store.remove(record.endpoint)) this.log(`removed a push subscription at ${host}: the push service says it is gone (HTTP ${result.status})`);
      this.refresh();
      return;
    }
    const reason = 'error' in result ? scrub(result.error, record.endpoint) : `HTTP ${result.status}`;
    if (result.retryable) {
      this.log(`push to ${host} did not go through and was not retried again: ${reason}`);
      return;
    }
    const failures = this.store.markFailure(record.endpoint);
    if (failures >= this.maxFailures && this.store.remove(record.endpoint)) {
      this.log(`removed a push subscription at ${host} after ${failures} refusals in a row: ${reason}`);
      this.refresh();
      return;
    }
    this.log(`push to ${host} was refused: ${reason}`);
  }
}
