// server/index.ts
import { createServer } from "node:http";
import { dirname as dirname4, join as join6, resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";

// server/config.ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// server/fetcher.ts
var DEFAULT_FETCH_POLICY = {
  timeoutMs: 9e3,
  maxConcurrent: 6,
  budgetPerMinute: 150,
  maxRetries: 2,
  baseBackoffMs: 1e3,
  maxBackoffMs: 6e4
};
var CancelledError = class extends Error {
  constructor() {
    super("cancelled");
  }
};
var ProviderFetcher = class {
  constructor(policy = DEFAULT_FETCH_POLICY, fetchImpl = (...args) => fetch(...args), now = Date.now, random = Math.random) {
    this.policy = policy;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
  }
  policy;
  fetchImpl;
  now;
  random;
  inflight = /* @__PURE__ */ new Map();
  active = 0;
  waiters = [];
  starts = [];
  backoffUntil = 0;
  consecutiveThrottles = 0;
  timer = null;
  counters = { started: 0, deduplicated: 0, succeeded: 0, failed: 0, rateLimited: 0, retried: 0, cancelled: 0 };
  /** GET a JSON document. Concurrent calls for the same URL share one request. */
  getJson(url) {
    const existing = this.inflight.get(url);
    if (existing) {
      this.counters.deduplicated++;
      return existing;
    }
    const run = this.run(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, run);
    return run;
  }
  /** Cancel requests that are queued but not yet started. Returns how many were dropped. */
  cancelQueued(predicate) {
    const keep = [];
    let dropped = 0;
    for (const w of this.waiters) {
      if (predicate(w.key)) {
        dropped++;
        w.reject(new CancelledError());
      } else keep.push(w);
    }
    this.waiters = keep;
    this.counters.cancelled += dropped;
    return dropped;
  }
  stats() {
    this.prune();
    return {
      ...this.counters,
      active: this.active,
      queued: this.waiters.length,
      lastMinute: this.starts.length,
      backoffUntil: this.backoffUntil
    };
  }
  prune() {
    const cutoff = this.now() - 6e4;
    while (this.starts.length && this.starts[0] <= cutoff) this.starts.shift();
  }
  /** Wait for a concurrency slot, a budget slot and the end of any host back-off. */
  acquire(key) {
    return new Promise((resolve4, reject) => {
      this.waiters.push({ key, resolve: resolve4, reject });
      this.pump();
    });
  }
  pump() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.prune();
    const now = this.now();
    while (this.waiters.length && this.active < this.policy.maxConcurrent) {
      if (now < this.backoffUntil) {
        this.timer = setTimeout(() => this.pump(), this.backoffUntil - now);
        return;
      }
      if (this.starts.length >= this.policy.budgetPerMinute) {
        const wait = this.starts[0] + 6e4 - now + 5;
        this.timer = setTimeout(() => this.pump(), Math.max(5, wait));
        return;
      }
      const w = this.waiters.shift();
      this.active++;
      this.starts.push(now);
      w.resolve();
    }
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }
  backoffDelay(attempt, retryAfterMs) {
    if (retryAfterMs !== null) return Math.min(this.policy.maxBackoffMs, retryAfterMs);
    const exp = this.policy.baseBackoffMs * 2 ** attempt;
    const capped = Math.min(this.policy.maxBackoffMs, exp);
    return Math.round(capped * (0.75 + this.random() * 0.5));
  }
  async run(url) {
    let attempt = 0;
    for (; ; ) {
      try {
        await this.acquire(url);
      } catch (e) {
        return { ok: false, error: e instanceof CancelledError ? "cancelled" : String(e), status: null, receivedAt: this.now(), retryable: false };
      }
      this.counters.started++;
      let outcome;
      try {
        outcome = await this.attempt(url);
      } finally {
        this.release();
      }
      if (outcome.ok) {
        this.counters.succeeded++;
        this.consecutiveThrottles = 0;
        return outcome;
      }
      const throttled = outcome.status === 429;
      if (throttled) {
        this.counters.rateLimited++;
        this.consecutiveThrottles++;
      }
      if (throttled || outcome.status !== null && outcome.status >= 500) {
        const delay = this.backoffDelay(Math.max(attempt, this.consecutiveThrottles - 1), outcome.retryAfterMs ?? null);
        this.backoffUntil = Math.max(this.backoffUntil, this.now() + delay);
      }
      if (!outcome.retryable || attempt >= this.policy.maxRetries) {
        this.counters.failed++;
        return { ok: false, error: outcome.error, status: outcome.status, receivedAt: outcome.receivedAt, retryable: outcome.retryable };
      }
      attempt++;
      this.counters.retried++;
      if (!throttled && !(outcome.status !== null && outcome.status >= 500)) {
        const delay = this.backoffDelay(attempt - 1, null);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  async attempt(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.policy.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      const receivedAt = this.now();
      if (!res.ok) {
        const retryAfter = res.headers.get("retry-after");
        const seconds2 = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
        return {
          ok: false,
          error: `HTTP ${res.status}`,
          status: res.status,
          receivedAt,
          retryable: res.status === 429 || res.status >= 500,
          retryAfterMs: seconds2 !== null ? seconds2 * 1e3 : null
        };
      }
      const text2 = await res.text();
      let data;
      try {
        data = JSON.parse(text2);
      } catch {
        return { ok: false, error: "Response was not valid JSON", status: res.status, receivedAt, retryable: false };
      }
      return { ok: true, data, status: res.status, receivedAt, bytes: text2.length };
    } catch (e) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        error: aborted ? `Timed out after ${this.policy.timeoutMs}ms` : `Network error: ${e.message}`,
        status: null,
        receivedAt: this.now(),
        retryable: true
      };
    } finally {
      clearTimeout(timer);
    }
  }
};

// shared/model.ts
var LEAGUES = {
  nfl: { id: "nfl", name: "National Football League", shortName: "NFL" },
  cfb: { id: "cfb", name: "College Football", shortName: "College" }
};
var gameId = (league, providerEventId) => `${league}-${providerEventId}`;
var teamKey = (league, providerTeamId) => `${league}-${providerTeamId}`;
function parseGameId(id) {
  const m = /^(nfl|cfb)-([A-Za-z0-9_:.]{1,64})$/.exec(id);
  return m ? { league: m[1], providerEventId: m[2] } : null;
}
var isActiveStatus = (k) => k === "in_progress" || k === "halftime" || k === "end_of_period" || k === "delayed";
var isLiveOrPaused = (k) => isActiveStatus(k) || k === "suspended";
var isOver = (k) => k === "final" || k === "canceled";
var UNKNOWN_SPOT = {
  label: null,
  offense: null,
  progress: null,
  schematicYard: null,
  phase: "unknown",
  provenance: "unknown",
  lateral: null,
  sourceTime: null
};
var TOUCHDOWN_KINDS = /* @__PURE__ */ new Set(["touchdown_rush", "touchdown_pass", "touchdown_return"]);
var ADMIN_KINDS = /* @__PURE__ */ new Set([
  "timeout",
  "two_minute_warning",
  "end_period",
  "end_half",
  "end_regulation",
  "end_game",
  "coin_toss"
]);
var EMPTY_FRESHNESS = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastChangeAt: null,
  health: "idle",
  error: null,
  consecutiveFailures: 0
};

// shared/lineHistory.ts
var FIGURES = ["spreadHome", "spreadAway", "spreadOddsHome", "spreadOddsAway", "total", "totalOddsOver", "totalOddsUnder", "moneylineHome", "moneylineAway"];
var MAX_LINE_POINTS = 240;
function linePointFrom(lines, at2) {
  if (!lines) return null;
  const point = {
    at: at2,
    spreadHome: lines.spread?.home.latest?.line ?? null,
    spreadAway: lines.spread?.away.latest?.line ?? null,
    spreadOddsHome: lines.spread?.home.latest?.odds ?? null,
    spreadOddsAway: lines.spread?.away.latest?.odds ?? null,
    total: lines.total?.over.latest?.line ?? null,
    totalOddsOver: lines.total?.over.latest?.odds ?? null,
    totalOddsUnder: lines.total?.under.latest?.odds ?? null,
    moneylineHome: lines.moneyline?.home.latest ?? null,
    moneylineAway: lines.moneyline?.away.latest ?? null
  };
  const empty = FIGURES.every((k) => point[k] === null);
  return empty ? null : point;
}
function sameLine(a, b) {
  if (!a || !b) return a === b;
  return FIGURES.every((k) => a[k] === b[k]);
}
function recordLine(history, lines, at2) {
  const point = linePointFrom(lines, at2);
  if (!point) return history;
  const provider = lines.provider;
  if (!history) return { provider, points: [point], captured: false };
  const last = history.points[history.points.length - 1] ?? null;
  if (sameLine(last, point)) return history;
  const points = [...history.points, point];
  return { ...history, provider, points: points.length > MAX_LINE_POINTS ? points.slice(points.length - MAX_LINE_POINTS) : points };
}
function sameLineHistory(a, b) {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return a.provider === b.provider && a.points.length === b.points.length && sameLine(a.points[a.points.length - 1] ?? null, b.points[b.points.length - 1] ?? null);
}

// shared/odds.ts
var MINUS = "\u2212";
function parseAmerican(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && Math.abs(raw) >= 100 ? Math.round(raw) : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(MINUS, "-");
  if (/^even$/i.test(s)) return 100;
  if (!/^[+-]?\d{3,6}$/.test(s)) return null;
  return Number(s);
}
function parseDollars(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
function quotePrice(bid, ask, last) {
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid && ask - bid <= 0.05 + 1e-9) return Math.round((bid + ask) / 2 * 1e3) / 1e3;
  if (last !== null && last > 0 && last < 1) return last;
  return null;
}

// shared/marketHistory.ts
function pricePoints(candles) {
  const out = [];
  for (const [end, bid, ask, last] of [...candles].sort((a, b) => a[0] - b[0])) {
    const price = quotePrice(bid, ask, last);
    if (price === null || !Number.isFinite(end)) continue;
    const point = { at: new Date(end * 1e3).toISOString(), price };
    const n = out.length;
    if (n >= 2 && out[n - 1].price === price && out[n - 2].price === price) out[n - 1] = point;
    else out.push(point);
  }
  return out;
}
function sameHistory(a, b) {
  if (!a || !b) return !a && !b;
  if (a.source !== b.source || a.team !== b.team || a.captured !== b.captured || a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i++) if (a.points[i].at !== b.points[i].at || a.points[i].price !== b.points[i].price) return false;
  return true;
}

// shared/detailDelta.ts
function sameSeries(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].playId !== b[i].playId || a[i].home !== b[i].home || a[i].tie !== b[i].tie) return false;
  return true;
}
function computeDetailDelta(prev, next, baseVersion, version) {
  const before = new Map((prev?.plays ?? []).map((p) => [p.id, p]));
  const upserts = [];
  for (const p of next.plays) {
    const old = before.get(p.id);
    if (!old || old.revision !== p.revision || old.order !== p.order || old.driveId !== p.driveId || old.scoringTeam !== p.scoringTeam) upserts.push(p);
  }
  const nextIds = new Set(next.plays.map((p) => p.id));
  const removed = [...before.keys()].filter((id) => !nextIds.has(id));
  return {
    gameId: next.gameId,
    baseVersion,
    version,
    summary: next.summary,
    drives: next.drives,
    scoring: next.scoring,
    stats: next.stats,
    leaders: next.leaders,
    attendance: next.attendance,
    gaps: next.gaps,
    currentDriveId: next.currentDriveId,
    upserts,
    removed,
    order: next.plays.map((p) => p.id),
    ...sameSeries(prev?.winProbability, next.winProbability) ? {} : { winProbability: next.winProbability ?? [] },
    ...sameHistory(prev?.marketHistory, next.marketHistory) ? {} : { marketHistory: next.marketHistory ?? null },
    ...sameLineHistory(prev?.lineHistory, next.lineHistory) ? {} : { lineHistory: next.lineHistory ?? null }
  };
}

// shared/situation.ts
function situationFromPlays(plays, upToOrder = Number.POSITIVE_INFINITY) {
  for (let i = plays.length - 1; i >= 0; i--) {
    const p = plays[i];
    if (p.order > upToOrder || ADMIN_KINDS.has(p.kind) || !p.end) continue;
    const spot = p.end.spot;
    return {
      possession: spot.offense,
      down: p.end.down,
      distance: p.end.distance,
      goalToGo: p.end.goalToGo,
      downDistanceText: p.end.downDistanceText,
      spot,
      isRedZone: spot.progress === null ? null : spot.progress >= 80,
      timeouts: { home: null, away: null },
      lastPlay: { id: p.id, kind: p.kind, description: p.description, yards: p.yards, team: p.offense }
    };
  }
  return null;
}
function withDerivedSituation(detail) {
  if (detail.summary.situation || !isLiveOrPaused(detail.summary.status.kind)) return detail;
  const situation = situationFromPlays(detail.plays);
  return situation ? { ...detail, summary: { ...detail.summary, situation } } : detail;
}
function mergeTeam(prev, next) {
  if (prev.key !== next.key) return next;
  const same = next.logo === (next.logo ?? prev.logo) && next.logoDark === (next.logoDark ?? prev.logoDark) && next.color === (next.color ?? prev.color) && next.alternateColor === (next.alternateColor ?? prev.alternateColor) && next.location === (next.location ?? prev.location) && next.conferenceId === (next.conferenceId ?? prev.conferenceId);
  if (same) return next;
  return {
    ...next,
    logo: next.logo ?? prev.logo,
    logoDark: next.logoDark ?? prev.logoDark,
    color: next.color ?? prev.color,
    alternateColor: next.alternateColor ?? prev.alternateColor,
    location: next.location ?? prev.location,
    conferenceId: next.conferenceId ?? prev.conferenceId
  };
}
function mergeSummaries(prev, next) {
  const prevAt = prev.receivedAt ?? 0;
  const nextAt = next.receivedAt ?? 0;
  if (nextAt < prevAt) return prev;
  const keepSituation = next.situation === null && isLiveOrPaused(next.status.kind) && prev.situation !== null;
  const situation = keepSituation ? prev.situation : next.situation;
  const heldProbability = prev.winProbability;
  return {
    ...next,
    home: mergeTeam(prev.home, next.home),
    away: mergeTeam(prev.away, next.away),
    divisions: next.source === "summary" || next.divisions.length === 0 ? prev.divisions : next.divisions,
    situation,
    // Lines and the pre-game prediction change rarely, so a report without them does not erase them.
    lines: next.lines ?? prev.lines,
    predictor: next.predictor ?? prev.predictor,
    // A win probability belongs to a play: an older one is kept only while the newer report is still at that play.
    winProbability: next.winProbability ?? (heldProbability?.playId && heldProbability.playId === situation?.lastPlay?.id ? heldProbability : void 0),
    // Market prices come from the Gridiron server, not the provider, so a provider report never carries or erases them.
    market: next.market !== void 0 ? next.market : prev.market,
    broadcasts: next.broadcasts.length ? next.broadcasts : prev.broadcasts,
    notes: next.notes.length ? next.notes : prev.notes,
    links: { gamePage: next.links.gamePage ?? prev.links.gamePage },
    /*
     * A venue's own facts survive a report that left them out, the same rule the
     * teams' branding follows: the summary payload names a venue without its id,
     * its roof or its surface, and taking it wholesale would throw away what the
     * scoreboard and the venue document had already found.
     */
    venue: next.venue && prev.venue && next.venue.name === prev.venue.name ? { ...next.venue, id: next.venue.id ?? prev.venue.id, indoor: next.venue.indoor ?? prev.venue.indoor, grass: next.venue.grass ?? prev.venue.grass } : next.venue ?? prev.venue,
    weather: next.weather ?? prev.weather,
    coverage: next.source === "summary" && prev.coverage.level !== "unknown" && next.coverage.level === "unknown" ? prev.coverage : next.coverage
  };
}

// shared/util.ts
function fingerprint(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function clockToSeconds(clock) {
  const m = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec((clock ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function easternDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}
function shiftDateKey(key, days) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(4, 6));
  const d = Number(key.slice(6, 8));
  const t = new Date(Date.UTC(y, m - 1, d + days, 12));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
}
var isDateKey = (v) => typeof v === "string" && /^\d{8}$/.test(v);
function jitter(ms, spread = 0.15, rand = Math.random) {
  return Math.round(ms * (1 - spread + rand() * spread * 2));
}

// server/engine.ts
var FORGET_GAME_AFTER_MS = 2 * 60 * 6e4;
var DEFAULT_INTERVALS = {
  slateLive: 25e3,
  slateIdle: 5 * 6e4,
  slatePast: 30 * 6e4,
  detailFocus: 12e3,
  detailVisible: 25e3,
  detailBackground: 6e4,
  detailScheduled: 10 * 6e4,
  detailFinal: 20 * 6e4
};
var DEFAULT_DIVISIONS = ["FBS", "FCS"];
var LEVEL_RANK = { focus: 3, visible: 2, background: 1 };
var ON_DEMAND_RETRY_MS = { slate: 3e4, detail: 1e4 };
var ON_DEMAND_EARLY_MS = 3e3;
var iso = (ms) => new Date(ms).toISOString();
var newLeague = () => ({
  games: /* @__PURE__ */ new Map(),
  prints: /* @__PURE__ */ new Map(),
  freshness: { ...EMPTY_FRESHNESS },
  divisions: [],
  conferences: [],
  discovery: "",
  limitations: [],
  fetched: false,
  failures: 0,
  inflight: null,
  fetchedDivisions: []
});
var GridironEngine = class {
  mode;
  replayLabel;
  provider;
  now;
  random;
  intervals;
  todayKey;
  log;
  marketReader;
  days = /* @__PURE__ */ new Map();
  details = /* @__PURE__ */ new Map();
  clients = /* @__PURE__ */ new Map();
  tasks = /* @__PURE__ */ new Map();
  marketPrices = /* @__PURE__ */ new Map();
  /** Whether an exchange feeds prices here. Without one, summaries keep the prices their provider supplied (the replay lab's captured prices). */
  marketsAttached;
  historyReader;
  histories = /* @__PURE__ */ new Map();
  /*
   * Gridiron's own record of a sportsbook's line. The provider reports an
   * opening and a latest line with no times attached, which is two numbers and
   * not a history, so a game page could say what a prediction market traded at
   * during any play and could not say the same about the book. Every reading
   * that differs from the last one written down becomes a point, stamped with
   * when it was seen; nothing is ever written for a moment nobody looked at.
   */
  lines = /* @__PURE__ */ new Map();
  seq = 0;
  running = false;
  constructor(options) {
    this.provider = options.provider;
    this.mode = options.mode;
    this.replayLabel = options.replayLabel ?? null;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
    this.todayKey = options.today ?? (() => easternDateKey(new Date(this.now())));
    this.log = options.log ?? (() => {
    });
    this.marketReader = options.markets ?? null;
    this.marketsAttached = !!options.markets;
    this.historyReader = options.marketHistory ?? null;
  }
  // ------------------------------------------------------------ lifecycle
  /** The provider's push subscription while the engine runs, for providers that push. */
  unsubscribePush = null;
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
  clock() {
    return this.now();
  }
  /** The detail the engine already holds for a game, without asking the provider for more. */
  peekDetail(gameId2) {
    const entry = this.details.get(gameId2);
    return entry ? { version: entry.version, detail: entry.detail, freshness: entry.freshness } : null;
  }
  /** The summary the engine holds for a game on any day it has read, without asking the provider. */
  knownSummary(gameId2) {
    return this.findSummary(gameId2);
  }
  // ------------------------------------------------------------ market prices
  /** Every game on the days the engine is following: the candidates for market prices. */
  marketGames() {
    const games = /* @__PURE__ */ new Map();
    for (const date of this.activeDates()) {
      const day = this.days.get(date);
      if (!day) continue;
      for (const league of [day.leagues.nfl, day.leagues.cfb]) for (const g of league.games.values()) games.set(g.id, g);
    }
    return [...games.values()];
  }
  /** Stores market prices (null removes a game's prices) and sends the games whose summaries changed. */
  setMarketPrices(prices) {
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
      const upserts = [];
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
  withMarket(game) {
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
  onPush(event) {
    if (!this.running) return;
    try {
      if (event.kind === "detail" && event.detail) {
        const entry = this.details.get(event.gameId);
        if (entry) this.acceptDetail(event.gameId, entry, event.detail, event.receivedAt);
        else this.mergeIntoSlate({ ...event.detail.summary, receivedAt: event.receivedAt, source: "summary" });
      } else if (event.kind === "summary" && event.summary && event.summary.id === event.gameId) {
        this.mergeIntoSlate({ ...event.summary, receivedAt: event.receivedAt, source: "scoreboard" });
      }
    } catch (e) {
      this.log(`push event for ${event.gameId} could not be applied: ${e.message}`);
    }
  }
  stats() {
    return {
      clients: this.clients.size,
      tasks: [...this.tasks.values()].map((t) => ({ key: t.key, running: t.running, nextInMs: t.nextAt === null ? null : Math.max(0, t.nextAt - this.now()) })),
      days: [...this.days.keys()],
      details: this.details.size,
      marketGames: this.marketPrices.size
    };
  }
  // ------------------------------------------------------------ clients
  connect(clientId, interest, send2) {
    const existing = this.clients.get(clientId);
    const client = { id: clientId, interest: normalizeInterest(interest), send: send2, detailVersions: /* @__PURE__ */ new Map() };
    this.clients.set(clientId, client);
    if (existing) existing.send = () => {
    };
    this.onInterest(client, null);
    return () => {
      if (this.clients.get(clientId) === client) {
        this.clients.delete(clientId);
        this.reconcile();
      }
    };
  }
  setInterest(clientId, interest) {
    const client = this.clients.get(clientId);
    if (!client) return false;
    const previous = client.interest;
    client.interest = normalizeInterest(interest);
    this.onInterest(client, previous);
    return true;
  }
  onInterest(client, previous) {
    const i = client.interest;
    const day = this.ensureDay(i.date);
    day.lastRequested = this.now();
    if (!previous || previous.date !== i.date) client.send({ type: "slate", snapshot: this.snapshot(i.date) });
    const newDivisions = i.divisions.filter((d) => !day.leagues.cfb.fetchedDivisions.includes(d));
    if (newDivisions.length && day.leagues.cfb.fetched) void this.refreshLeague("cfb", i.date);
    const before = new Set(previous ? [...previous.focus, ...previous.visible, ...previous.monitored] : []);
    for (const id of [...i.focus, ...i.visible, ...i.monitored]) {
      const entry = this.details.get(id);
      if (entry?.detail && (!before.has(id) || client.detailVersions.get(id) !== entry.version)) {
        client.send({ type: "detail", gameId: id, version: entry.version, detail: entry.detail, freshness: entry.freshness });
        client.detailVersions.set(id, entry.version);
      }
    }
    this.reconcile();
  }
  // ------------------------------------------------------------ queries
  async getSlate(date, waitMs = 1e4) {
    const day = this.ensureDay(date);
    day.lastRequested = this.now();
    const unfetched = !day.leagues.nfl.fetched || !day.leagues.cfb.fetched;
    const due = unfetched ? ["nfl", "cfb"] : this.running ? [] : ["nfl", "cfb"].filter((league) => this.dueOnDemand(day, league));
    if (due.length) await withTimeout(Promise.all(due.map((league) => this.refreshLeague(league, date))), waitMs);
    if (this.marketReader) {
      const games = [...day.leagues.nfl.games.values(), ...day.leagues.cfb.games.values()];
      const prices = await withTimeout(
        this.marketReader.read(games).catch((e) => {
          this.log(`market prices failed: ${e.message}`);
          return void 0;
        }),
        3e3
      );
      if (prices) this.setMarketPrices(prices);
    }
    this.reconcile();
    return this.snapshot(date);
  }
  async getDetail(gameId2, waitMs = 1e4) {
    const entry = this.ensureDetail(gameId2);
    entry.lastRequested = this.now();
    const age = entry.freshness.lastSuccessAt ? this.now() - Date.parse(entry.freshness.lastSuccessAt) : Infinity;
    const sinceAttempt = entry.freshness.lastAttemptAt ? this.now() - Date.parse(entry.freshness.lastAttemptAt) : Infinity;
    const spaced = this.running || !entry.failures || sinceAttempt >= ON_DEMAND_RETRY_MS.detail;
    const stale = age > this.intervals.detailFocus - (this.running ? 0 : ON_DEMAND_EARLY_MS);
    if ((!entry.detail || stale) && spaced) await withTimeout(this.refreshDetail(gameId2), waitMs);
    if (this.historyReader && entry.detail) await withTimeout(this.refreshHistory(gameId2), 3e3);
    return { version: entry.version, detail: entry.detail, freshness: entry.freshness };
  }
  snapshot(date) {
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
      coverage: this.coverage(day)
    };
  }
  coverage(day) {
    const { nfl, cfb } = day.leagues;
    return {
      provider: this.provider.info.name,
      date: day.date,
      divisions: [...nfl.divisions, ...cfb.divisions],
      conferences: [...nfl.conferences, ...cfb.conferences],
      discovery: [nfl.discovery, cfb.discovery].filter(Boolean).join(" "),
      limitations: [...nfl.limitations, ...cfb.limitations]
    };
  }
  /** Re-poll everything now (used by the replay lab after it advances time). */
  async refreshAll() {
    const work = [];
    for (const key of this.tasks.keys()) {
      const [kind, a, b] = key.split("|");
      work.push(kind === "slate" ? this.refreshLeague(a, b) : this.refreshDetail(a));
    }
    await Promise.all(work);
  }
  // ------------------------------------------------------------ state
  ensureDay(date) {
    let day = this.days.get(date);
    if (!day) {
      day = { date, seq: 0, leagues: { nfl: newLeague(), cfb: newLeague() }, lastRequested: this.now() };
      this.days.set(date, day);
    }
    return day;
  }
  ensureDetail(id) {
    let entry = this.details.get(id);
    if (!entry) {
      entry = { detail: null, previous: null, version: 0, print: null, freshness: { ...EMPTY_FRESHNESS }, failures: 0, inflight: null, delta: null, lastRequested: 0 };
      this.details.set(id, entry);
    }
    return entry;
  }
  findSummary(id) {
    for (const day of this.days.values()) {
      const g = day.leagues.nfl.games.get(id) ?? day.leagues.cfb.games.get(id);
      if (g) return g;
    }
    return null;
  }
  divisionsFor(date) {
    const set = /* @__PURE__ */ new Set();
    for (const c of this.clients.values()) if (c.interest.date === date) c.interest.divisions.forEach((d) => set.add(d));
    if (!set.size) DEFAULT_DIVISIONS.forEach((d) => set.add(d));
    return [...set].filter((d) => d !== "NFL");
  }
  // ------------------------------------------------------------ polling
  refreshLeague(league, date) {
    const day = this.ensureDay(date);
    const slate = day.leagues[league];
    if (slate.inflight) return slate.inflight;
    const divisions = league === "nfl" ? ["NFL"] : this.divisionsFor(date);
    slate.freshness = { ...slate.freshness, lastAttemptAt: iso(this.now()), health: slate.fetched ? slate.freshness.health : "reconnecting" };
    slate.inflight = (async () => {
      try {
        const result = await this.provider.fetchSlate(league, date, { divisions });
        this.applySlate(day, league, result, divisions);
      } catch (e) {
        this.log(`slate ${league} ${date} crashed: ${e.message}`);
        slate.failures++;
        slate.fetched = true;
        slate.freshness = { ...slate.freshness, health: slate.games.size ? "stale" : "unavailable", error: e.message, consecutiveFailures: slate.failures };
        this.emitDay(day, [], []);
      }
    })().finally(() => {
      slate.inflight = null;
    });
    return slate.inflight;
  }
  applySlate(day, league, result, divisions) {
    const slate = day.leagues[league];
    slate.fetched = true;
    slate.discovery = result.discovery || slate.discovery;
    slate.limitations = result.limitations;
    if (result.conferences?.length) slate.conferences = result.conferences;
    const errorText = result.errors.map((e) => `${e.scope}: ${e.message}`).join("; ") || null;
    if (result.failed) {
      slate.failures++;
      slate.divisions = result.divisions.length ? result.divisions : slate.divisions.map((d) => ({ ...d, health: "unavailable" }));
      slate.freshness = { ...slate.freshness, health: slate.games.size ? "stale" : "unavailable", error: errorText ?? "Provider unavailable", consecutiveFailures: slate.failures };
      this.emitDay(day, [], []);
      return;
    }
    slate.failures = 0;
    slate.fetchedDivisions = divisions;
    slate.divisions = result.divisions;
    const failedDivisions = new Set(result.divisions.filter((d) => d.health === "unavailable").map((d) => d.division));
    const upserts = [];
    const removed = [];
    const seen = /* @__PURE__ */ new Set();
    for (const incoming of result.games) {
      const stamped = { ...incoming, receivedAt: result.receivedAt, source: "scoreboard" };
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
      const stillWanted = league === "nfl" || prev.divisions.some((d) => divisions.includes(d));
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
      health: result.errors.length ? "stale" : "connected",
      error: errorText,
      consecutiveFailures: 0
    };
    this.emitDay(day, upserts, removed);
  }
  refreshDetail(id) {
    const entry = this.ensureDetail(id);
    if (entry.inflight) return entry.inflight;
    entry.freshness = { ...entry.freshness, lastAttemptAt: iso(this.now()) };
    entry.inflight = (async () => {
      try {
        const summary = this.findSummary(id);
        const result = await this.provider.fetchDetail(id, summary?.divisions);
        if (!result.ok) {
          entry.failures++;
          entry.freshness = { ...entry.freshness, health: entry.detail ? "stale" : "unavailable", error: result.error.message, consecutiveFailures: entry.failures };
          this.emitDetailFreshness(id, entry);
          return;
        }
        this.acceptDetail(id, entry, result.detail, result.receivedAt, "poll");
      } catch (e) {
        entry.failures++;
        entry.freshness = { ...entry.freshness, health: entry.detail ? "stale" : "unavailable", error: e.message, consecutiveFailures: entry.failures };
        this.emitDetailFreshness(id, entry);
      }
    })().finally(() => {
      entry.inflight = null;
      this.reconcile();
    });
    return entry.inflight;
  }
  /** When each game's detail last arrived by push, so a slower poll cannot undo it. */
  lastPush = /* @__PURE__ */ new Map();
  /**
   * Stores a provider detail for a followed game when it changed, and tells
   * interested clients. Polls and pushes both come through here. Anything
   * received before the latest push is ignored; without pushes nothing is, so
   * the replay lab can seek backwards.
   */
  acceptDetail(id, entry, detail, receivedAt, via = "push") {
    const pushed = this.lastPush.get(id);
    if (pushed !== void 0 && receivedAt < pushed) return;
    if (via === "push") this.lastPush.set(id, receivedAt);
    const summary = this.findSummary(id);
    entry.failures = 0;
    const derived = withDerivedSituation({
      ...detail,
      summary: { ...detail.summary, receivedAt, source: "summary", divisions: summary?.divisions ?? detail.summary.divisions }
    });
    const withMarket = this.historyReader ? { ...derived, marketHistory: this.histories.get(id)?.history ?? null } : derived;
    this.recordLines(id, derived.summary, receivedAt, false);
    const stamped = this.mode === "replay" ? withMarket : { ...withMarket, lineHistory: this.lines.get(id) ?? null };
    const print = fingerprint(JSON.stringify({ ...stamped, summary: { ...stamped.summary, receivedAt: 0 } }));
    const changed = print !== entry.print;
    entry.freshness = {
      lastAttemptAt: entry.freshness.lastAttemptAt,
      lastSuccessAt: iso(receivedAt),
      lastChangeAt: changed ? iso(receivedAt) : entry.freshness.lastChangeAt,
      health: "connected",
      error: null,
      consecutiveFailures: 0
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
  mergeIntoSlate(summary) {
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
  refreshHistory(id) {
    const reader = this.historyReader;
    const entry = this.details.get(id);
    const game = entry?.detail?.summary;
    if (!reader || !entry?.detail || !game || game.status.kind === "final") return Promise.resolve();
    let held = this.histories.get(id);
    if (!held) {
      held = { history: null, at: 0, inflight: null };
      this.histories.set(id, held);
    }
    if (held.inflight) return held.inflight;
    const due = isLiveOrPaused(game.status.kind) ? 45e3 : 5 * 6e4;
    if (held.at && this.now() - held.at < due) return Promise.resolve();
    const slot = held;
    slot.inflight = reader(game).then((history) => {
      slot.history = history;
      slot.at = this.now();
      this.attachHistory(id);
    }).catch((e) => this.log(`market history failed: ${e.message}`)).finally(() => {
      slot.inflight = null;
    });
    return slot.inflight;
  }
  /** Writes down a sportsbook's line when it differs from the last reading taken. */
  recordLines(id, summary, receivedAt, attach = true) {
    if (this.mode === "replay") return;
    const held = this.lines.get(id) ?? null;
    const next = recordLine(held, summary.lines, iso(receivedAt));
    if (next === held || !next) return;
    this.lines.set(id, next);
    if (attach) this.attachLines(id);
  }
  /** Puts the recorded line on a game's detail when it differs, as a new detail version. */
  attachLines(id) {
    const entry = this.details.get(id);
    if (!entry?.detail) return;
    const history = this.lines.get(id) ?? null;
    if (sameLineHistory(entry.detail.lineHistory, history)) return;
    const next = { ...entry.detail, lineHistory: history };
    entry.previous = entry.detail;
    entry.detail = next;
    entry.print = fingerprint(JSON.stringify({ ...next, summary: { ...next.summary, receivedAt: 0 } }));
    entry.version++;
    entry.delta = computeDetailDelta(entry.previous, next, entry.version - 1, entry.version);
    this.emitDetail(id, entry);
  }
  /** Puts the held price history on a game's detail when it differs, as a new detail version. */
  attachHistory(id) {
    const entry = this.details.get(id);
    if (!entry?.detail) return;
    const history = this.histories.get(id)?.history ?? null;
    if (sameHistory(entry.detail.marketHistory, history)) return;
    const next = { ...entry.detail, marketHistory: history };
    entry.previous = entry.detail;
    entry.detail = next;
    entry.print = fingerprint(JSON.stringify({ ...next, summary: { ...next.summary, receivedAt: 0 } }));
    entry.version++;
    entry.delta = computeDetailDelta(entry.previous, next, entry.version - 1, entry.version);
    this.emitDetail(id, entry);
  }
  // ------------------------------------------------------------ messages
  emitDay(day, upserts, removed) {
    day.seq = ++this.seq;
    const message = {
      type: "slate-delta",
      date: day.date,
      seq: day.seq,
      generatedAt: iso(this.now()),
      upserts,
      removed,
      freshness: { nfl: day.leagues.nfl.freshness, cfb: day.leagues.cfb.freshness },
      coverage: this.coverage(day)
    };
    for (const c of this.clients.values()) if (c.interest.date === day.date) c.send(message);
  }
  interestedClients(id) {
    const out = [];
    for (const c of this.clients.values()) {
      const i = c.interest;
      if (i.focus.includes(id) || i.visible.includes(id) || i.monitored.includes(id)) out.push(c);
      else if (i.alertsAllGames && this.findSummary(id)) out.push(c);
    }
    return out;
  }
  emitDetail(id, entry) {
    if (!entry.detail) return;
    for (const c of this.interestedClients(id)) {
      const held = c.detailVersions.get(id);
      if (entry.delta && held === entry.delta.baseVersion) c.send({ type: "detail-delta", gameId: id, delta: entry.delta, freshness: entry.freshness });
      else c.send({ type: "detail", gameId: id, version: entry.version, detail: entry.detail, freshness: entry.freshness });
      c.detailVersions.set(id, entry.version);
    }
  }
  emitDetailFreshness(id, entry) {
    for (const c of this.interestedClients(id)) c.send({ type: "detail-freshness", gameId: id, version: entry.version, freshness: entry.freshness });
  }
  // ------------------------------------------------------------ scheduling
  activeDates() {
    const today = this.todayKey();
    const dates = /* @__PURE__ */ new Set([today]);
    const yesterday = shiftDateKey(today, -1);
    const y = this.days.get(yesterday);
    if (!y || !y.leagues.nfl.fetched || !y.leagues.cfb.fetched || this.hasActive(y)) dates.add(yesterday);
    for (const c of this.clients.values()) dates.add(c.interest.date);
    for (const [date, day] of this.days) if (this.now() - day.lastRequested < 2 * 6e4) dates.add(date);
    return dates;
  }
  hasActive(day) {
    for (const league of [day.leagues.nfl, day.leagues.cfb]) for (const g of league.games.values()) if (isLiveOrPaused(g.status.kind)) return true;
    return false;
  }
  hasImminent(day) {
    const now = this.now();
    for (const league of [day.leagues.nfl, day.leagues.cfb]) {
      for (const g of league.games.values()) {
        if (g.status.kind !== "scheduled" || !g.startTime) continue;
        const start = Date.parse(g.startTime);
        if (start - now < 45 * 6e4 && now - start < 3 * 60 * 6e4) return true;
      }
    }
    return false;
  }
  detailInterest() {
    const levels = /* @__PURE__ */ new Map();
    const raise = (id, level) => {
      const cur = levels.get(id);
      if (!cur || LEVEL_RANK[level] > LEVEL_RANK[cur]) levels.set(id, level);
    };
    for (const c of this.clients.values()) {
      c.interest.focus.forEach((id) => raise(id, "focus"));
      c.interest.visible.forEach((id) => raise(id, "visible"));
      c.interest.monitored.forEach((id) => raise(id, "visible"));
      if (c.interest.alertsAllGames) {
        const day = this.days.get(c.interest.date);
        if (day) {
          for (const league of [day.leagues.nfl, day.leagues.cfb]) {
            for (const g of league.games.values()) {
              if (isLiveOrPaused(g.status.kind) && g.coverage.level !== "score-only" && g.divisions.some((d) => d === "NFL" || c.interest.divisions.includes(d))) raise(g.id, "background");
            }
          }
        }
      }
    }
    const now = this.now();
    for (const [id, entry] of this.details) if (now - entry.lastRequested < 9e4) raise(id, "visible");
    return levels;
  }
  reconcile() {
    if (!this.running) return;
    const wanted = /* @__PURE__ */ new Map();
    for (const date of this.activeDates()) {
      wanted.set(`slate|nfl|${date}`, 0);
      wanted.set(`slate|cfb|${date}`, 0);
    }
    for (const id of this.detailInterest().keys()) wanted.set(`detail|${id}`, 0);
    for (const [key, delay] of wanted) {
      if (!this.tasks.has(key)) {
        const task = { key, timer: null, running: false, nextAt: null };
        this.tasks.set(key, task);
        this.schedule(task, key.startsWith("detail") && this.details.get(key.slice(7))?.detail ? this.intervalFor(key) ?? delay : delay);
      }
    }
    for (const [key, task] of this.tasks) {
      if (wanted.has(key)) continue;
      if (task.timer) clearTimeout(task.timer);
      this.tasks.delete(key);
    }
    const active = this.activeDates();
    for (const [date, day] of this.days) if (!active.has(date) && this.now() - day.lastRequested > 30 * 6e4) this.days.delete(date);
    this.forgetIdleGames();
  }
  /*
   * Forget a game nobody has asked about for a long time, along with everything
   * held for it.
   *
   * A day is forgotten when nobody looks at it, but the per game state was not:
   * the detail, the two previous versions kept for deltas, the exchange's price
   * history and the recorded sportsbook line all stayed for every game the
   * process had ever been asked for. A season is a few hundred NFL games and the
   * better part of a thousand college ones, and a detail is not small, so a
   * server left up from September to January was holding all of them. A game
   * still being polled has a task and is never forgotten however long ago
   * somebody last asked for it, which is what keeps a followed game safe.
   */
  forgetIdleGames() {
    const polled = /* @__PURE__ */ new Set();
    for (const key of this.tasks.keys()) {
      const [kind, id] = key.split("|");
      if (kind === "detail") polled.add(id);
    }
    for (const [id, entry] of this.details) {
      if (polled.has(id) || entry.inflight || this.now() - entry.lastRequested <= FORGET_GAME_AFTER_MS) continue;
      this.details.delete(id);
      this.histories.delete(id);
      this.lines.delete(id);
      this.lastPush.delete(id);
    }
  }
  schedule(task, delayMs) {
    if (task.timer) clearTimeout(task.timer);
    const delay = Math.max(0, delayMs);
    task.nextAt = this.now() + delay;
    task.timer = setTimeout(() => void this.run(task), delay);
    task.timer.unref?.();
  }
  async run(task) {
    if (task.running || this.tasks.get(task.key) !== task) return;
    task.running = true;
    task.timer = null;
    task.nextAt = null;
    try {
      const [kind, a, b] = task.key.split("|");
      if (kind === "slate") await this.refreshLeague(a, b);
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
  slateInterval(day) {
    if (this.hasActive(day) || this.hasImminent(day)) return this.intervals.slateLive;
    return day.date < this.todayKey() ? this.intervals.slatePast : this.intervals.slateIdle;
  }
  /** Serverless deployments: whether a request should ask the provider for a league again. */
  dueOnDemand(day, league) {
    const slate = day.leagues[league];
    const since = slate.freshness.lastAttemptAt ? this.now() - Date.parse(slate.freshness.lastAttemptAt) : Infinity;
    return since >= (slate.failures ? ON_DEMAND_RETRY_MS.slate : this.slateInterval(day) - ON_DEMAND_EARLY_MS);
  }
  /** Milliseconds until a task should run again, or null when it is no longer needed. */
  intervalFor(key) {
    const [kind, a, b] = key.split("|");
    if (kind === "slate") {
      const date = b;
      if (!this.activeDates().has(date)) return null;
      const day = this.ensureDay(date);
      const failures2 = day.leagues[a].failures;
      const base2 = this.slateInterval(day);
      return failures2 ? Math.min(5 * 6e4, base2 * 2 ** Math.min(failures2, 4)) : base2;
    }
    const id = a;
    const level = this.detailInterest().get(id);
    if (!level) return null;
    const summary = this.findSummary(id);
    const entry = this.details.get(id);
    const status = summary?.status.kind ?? entry?.detail?.summary.status.kind ?? "unknown";
    const coverage = summary?.coverage.level ?? entry?.detail?.summary.coverage.level;
    if (coverage === "score-only" && entry?.detail) return null;
    const failures = entry?.failures ?? 0;
    let base;
    if (isOver(status) || status === "postponed") base = level === "background" ? Infinity : this.intervals.detailFinal;
    else if (status === "scheduled") base = level === "background" ? Infinity : this.intervals.detailScheduled;
    else base = level === "focus" ? this.intervals.detailFocus : level === "visible" ? this.intervals.detailVisible : this.intervals.detailBackground;
    if (!Number.isFinite(base)) return null;
    return failures ? Math.min(5 * 6e4, base * 2 ** Math.min(failures, 4)) : base;
  }
};
function normalizeInterest(i) {
  const ids = (list) => Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === "string"))].slice(0, 64) : [];
  const allowed = ["FBS", "FCS", "D2", "D3"];
  const divisions = Array.isArray(i.divisions) ? i.divisions.filter((d) => allowed.includes(d)) : DEFAULT_DIVISIONS;
  return {
    date: i.date,
    divisions: divisions.length ? divisions : DEFAULT_DIVISIONS,
    focus: ids(i.focus).slice(0, 4),
    visible: ids(i.visible),
    monitored: ids(i.monitored),
    alertsAllGames: i.alertsAllGames === true
  };
}
function summaryPrint(g) {
  return fingerprint(JSON.stringify({ ...g, receivedAt: 0, source: void 0 }));
}
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve4) => {
    timer = setTimeout(() => resolve4(void 0), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// server/config.ts
var int = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== void 0 && v !== "" ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
var seconds = (v, fallbackMs, minS, maxS) => v === void 0 || v === "" ? fallbackMs : int(v, fallbackMs / 1e3, minS, maxS) * 1e3;
var PROVIDERS = ["espn", "sportradar", "replay"];
function loadConfig(env = process.env, root = process.cwd()) {
  const production = env.NODE_ENV === "production";
  const staticCandidate = resolve(root, env.GRIDIRON_STATIC_DIR ?? "dist");
  const provider = PROVIDERS.find((p) => p === env.GRIDIRON_PROVIDER) ?? "espn";
  return {
    port: int(env.PORT, 8787, 1, 65535),
    host: env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    production,
    provider,
    replayScenario: env.GRIDIRON_REPLAY_SCENARIO ?? "nfl-week1-sunday",
    staticDir: existsSync(staticCandidate) ? staticCandidate : null,
    cacheDir: env.GRIDIRON_CACHE_DIR === "off" ? null : resolve(root, env.GRIDIRON_CACHE_DIR ?? ".cache"),
    fetch: {
      ...DEFAULT_FETCH_POLICY,
      timeoutMs: int(env.GRIDIRON_FETCH_TIMEOUT_MS, DEFAULT_FETCH_POLICY.timeoutMs, 1e3, 6e4),
      maxConcurrent: int(env.GRIDIRON_FETCH_CONCURRENCY, DEFAULT_FETCH_POLICY.maxConcurrent, 1, 32),
      budgetPerMinute: int(env.GRIDIRON_FETCH_BUDGET, DEFAULT_FETCH_POLICY.budgetPerMinute, 10, 2e3)
    },
    intervals: {
      slateLive: seconds(env.GRIDIRON_POLL_SLATE_LIVE_S, DEFAULT_INTERVALS.slateLive, 10, 600),
      slateIdle: seconds(env.GRIDIRON_POLL_SLATE_IDLE_S, DEFAULT_INTERVALS.slateIdle, 60, 3600),
      slatePast: seconds(env.GRIDIRON_POLL_SLATE_PAST_S, DEFAULT_INTERVALS.slatePast, 60, 7200),
      detailFocus: seconds(env.GRIDIRON_POLL_FOCUS_S, DEFAULT_INTERVALS.detailFocus, 8, 300),
      detailVisible: seconds(env.GRIDIRON_POLL_VISIBLE_S, DEFAULT_INTERVALS.detailVisible, 10, 600),
      detailBackground: seconds(env.GRIDIRON_POLL_BACKGROUND_S, DEFAULT_INTERVALS.detailBackground, 20, 1800),
      detailScheduled: seconds(env.GRIDIRON_POLL_SCHEDULED_S, DEFAULT_INTERVALS.detailScheduled, 60, 7200),
      detailFinal: seconds(env.GRIDIRON_POLL_FINAL_S, DEFAULT_INTERVALS.detailFinal, 60, 7200)
    },
    maxStreams: int(env.GRIDIRON_MAX_STREAMS, 500, 1, 1e4),
    maxReplaySessions: int(env.GRIDIRON_MAX_REPLAY_SESSIONS, 25, 0, 500),
    trustProxy: env.GRIDIRON_TRUST_PROXY === "1" || env.GRIDIRON_TRUST_PROXY === "true"
  };
}

// server/http.ts
import { createReadStream, existsSync as existsSync2, statSync } from "node:fs";
import { extname, join, normalize, resolve as resolve2 } from "node:path";
import { randomUUID } from "node:crypto";

// shared/availability.ts
function feedUnknown(freshness) {
  return !!freshness && freshness.health === "unavailable" && !freshness.lastSuccessAt;
}
function anyFeedUnknown(freshness) {
  return Object.values(freshness ?? {}).some((f) => feedUnknown(f));
}

// shared/team.ts
var MAX_WEEK = 53;
function byeWeeksFrom(schedule) {
  const weeks = /* @__PURE__ */ new Set();
  for (const game of schedule) {
    const week = game.week.number;
    if (game.seasonType === 2 && week !== null && Number.isInteger(week) && week >= 0 && week <= MAX_WEEK) weeks.add(week);
  }
  if (weeks.size < 2) return [];
  const first = Math.min(...weeks);
  const last = Math.max(...weeks);
  const byes = [];
  for (let week = first + 1; week < last; week++) if (!weeks.has(week)) byes.push(week);
  return byes;
}
function teamPageAsOf(page, isoTime) {
  const cutoff = Date.parse(isoTime);
  if (!Number.isFinite(cutoff)) throw new Error(`teamPageAsOf needs an ISO time, got ${JSON.stringify(isoTime)}`);
  return {
    ...page,
    schedule: page.schedule.map((game) => {
      const kickoff = Date.parse(game.date);
      if (Number.isFinite(kickoff) && kickoff <= cutoff) return game;
      return {
        ...game,
        status: { state: "pre", completed: false, detail: null, shortDetail: null },
        score: null,
        result: null
      };
    })
  };
}
function withSummary(game, summary) {
  const kind = summary.status.kind;
  const state = kind === "scheduled" ? "pre" : kind === "final" || kind === "postponed" || kind === "canceled" ? "post" : kind === "unknown" ? "unknown" : "in";
  const completed = kind === "final";
  const { home, away } = summary.score;
  const atHome = game.homeAway === "home";
  const score = state !== "pre" && home !== null && away !== null ? { team: atHome ? home : away, opponent: atHome ? away : home } : null;
  return {
    ...game,
    status: { state, completed, detail: summary.status.detail, shortDetail: summary.status.detail },
    score,
    result: completed && score ? score.team > score.opponent ? "W" : score.team < score.opponent ? "L" : "T" : null
  };
}
var RESULT_WINDOW_MS = 6 * 60 * 6e4;
function teamPageAtReplay(page, atMs, known) {
  const asOf = teamPageAsOf(page, new Date(atMs).toISOString());
  return {
    ...asOf,
    schedule: asOf.schedule.map((game) => {
      const summary = known(game.gameId);
      if (summary) return withSummary(game, summary);
      const kickoff = Date.parse(game.date);
      if (Number.isFinite(kickoff) && kickoff <= atMs && atMs - kickoff < RESULT_WINDOW_MS) {
        return { ...game, status: { state: "unknown", completed: false, detail: "Result not known at the replay clock", shortDetail: "Result not known yet" }, score: null, result: null };
      }
      return game;
    })
  };
}

// server/respond.ts
import { gzip } from "node:zlib";
var SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "fullscreen=(self), geolocation=(), microphone=(), camera=()",
  "cross-origin-opener-policy": "same-origin"
};
var COMPRESS_MIN_BYTES = 1400;
var acceptEncoding = /* @__PURE__ */ new WeakMap();
function noteAcceptEncoding(req, res) {
  acceptEncoding.set(res, String(req.headers["accept-encoding"] ?? ""));
}
function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  const head = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers };
  if (Buffer.byteLength(json) < COMPRESS_MIN_BYTES) {
    res.writeHead(status, head);
    res.end(json);
    return;
  }
  head.vary = "accept-encoding";
  if (!/\bgzip\b/.test(acceptEncoding.get(res) ?? "")) {
    res.writeHead(status, head);
    res.end(json);
    return;
  }
  gzip(json, { level: 6 }, (error, compressed) => {
    if (res.headersSent || res.writableEnded) return;
    if (error) res.writeHead(status, head).end(json);
    else res.writeHead(status, { ...head, "content-encoding": "gzip" }).end(compressed);
  });
}
async function readBody(req, limit = 16384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [req.headers.host, req.headers["x-forwarded-host"]].flatMap((h) => String(h ?? "").split(",")).map((h) => h.trim()).filter(Boolean);
  return hosts.includes(host);
}

// server/http.ts
var CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://a.espncdn.com",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon"
};
var COMPRESSIBLE = /* @__PURE__ */ new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest", ".txt"]);
var STATIC_PREFIXES = ["/assets/", "/fonts/", "/icons/"];
var DIVISIONS = ["FBS", "FCS", "D2", "D3"];
function parseInterest(value, fallbackDate) {
  if (typeof value !== "object" || value === null) return null;
  const v = value;
  const ids = (x) => Array.isArray(x) ? x.filter((i) => typeof i === "string" && parseGameId(i) !== null).slice(0, 64) : [];
  return {
    date: isDateKey(v.date) ? v.date : fallbackDate,
    divisions: Array.isArray(v.divisions) ? v.divisions.filter((d) => DIVISIONS.includes(d)) : ["FBS", "FCS"],
    focus: ids(v.focus).slice(0, 4),
    visible: ids(v.visible),
    monitored: ids(v.monitored),
    alertsAllGames: v.alertsAllGames === true
  };
}
function seasonAt(ms) {
  const d = new Date(ms);
  return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}
function createApp(options) {
  let streams = 0;
  async function api(req, res, url, engine2, base, replaySession) {
    const path = url.pathname.slice(base.length) || "/";
    const pollCache = (seconds2, unknown = false) => options.transport === "poll" && !replaySession ? { "cache-control": unknown ? "public, max-age=0, s-maxage=2" : `public, max-age=0, s-maxage=${seconds2}, stale-while-revalidate=${seconds2 * 3}` } : {};
    if (options.transport === "poll" && (path === "/interest" || path === "/stream")) {
      return send(res, 404, { error: "This deployment is polled; the live stream is not available" });
    }
    if (req.method === "GET" && path === "/slate") {
      const date = url.searchParams.get("date");
      const key = isDateKey(date) ? date : engine2.today();
      const slate = await engine2.getSlate(key);
      return send(res, 200, slate, pollCache(10, anyFeedUnknown(slate.freshness)));
    }
    const game = /^\/game\/([^/]+)$/.exec(path);
    if (req.method === "GET" && game) {
      const id = decodeURIComponent(game[1]);
      if (!parseGameId(id)) return send(res, 400, { error: "Invalid game id" });
      const detail = await engine2.getDetail(id);
      return send(res, 200, detail, pollCache(8, !detail.detail && feedUnknown(detail.freshness)));
    }
    const team = /^\/team\/([^/]+)$/.exec(path);
    if (req.method === "GET" && team) {
      const match = /^(nfl|cfb)-(\d{1,10})$/.exec(decodeURIComponent(team[1]));
      if (!match) return send(res, 400, { error: "Invalid team id" });
      if (!options.teams) return send(res, 404, { error: "Team pages are not available on this server" });
      const replay = engine2.mode === "replay";
      const clock = engine2.clock();
      const result = await options.teams.get(match[1], match[2], replay ? { season: seasonAt(clock), saved: true } : {});
      if (!result.ok) return send(res, result.status, { error: result.error });
      const asOf = replay ? new Date(clock).toISOString() : null;
      const page = replay ? teamPageAtReplay(result.page, clock, (gameId2) => engine2.knownSummary(gameId2)) : result.page;
      return send(res, 200, { page, source: result.source, asOf }, pollCache(60));
    }
    if (req.method === "POST" && path === "/interest") {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      const b = body ?? {};
      const clientId = typeof b.clientId === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(b.clientId) ? b.clientId : null;
      const interest = parseInterest(b.interest, engine2.today());
      if (!clientId || !interest) return send(res, 400, { error: "clientId and interest are required" });
      const known = engine2.setInterest(clientId, interest);
      return known ? send(res, 200, { ok: true }) : send(res, 409, { error: "Unknown client; reconnect the stream" });
    }
    if (req.method === "GET" && path === "/stream") {
      if (streams >= options.maxStreams) return send(res, 503, { error: "Too many live connections" });
      const requested = url.searchParams.get("clientId");
      const clientId = requested && /^[a-zA-Z0-9-]{8,64}$/.test(requested) ? requested : randomUUID();
      const date = url.searchParams.get("date");
      const interest = parseInterest(
        {
          date,
          divisions: (url.searchParams.get("divisions") ?? "FBS,FCS").split(","),
          focus: (url.searchParams.get("focus") ?? "").split(",").filter(Boolean),
          visible: (url.searchParams.get("visible") ?? "").split(",").filter(Boolean),
          monitored: (url.searchParams.get("monitored") ?? "").split(",").filter(Boolean),
          alertsAllGames: url.searchParams.get("alertsAll") === "1"
        },
        engine2.today()
      );
      streams++;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...SECURITY_HEADERS
      });
      res.write("retry: 4000\n\n");
      const write = (event, data) => {
        if (!res.writableEnded) res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
      };
      write("hello", {
        clientId,
        mode: engine2.mode,
        replayLabel: engine2.replayLabel,
        replaySession,
        provider: engine2.providerInfo,
        today: engine2.today(),
        serverTime: (/* @__PURE__ */ new Date()).toISOString()
      });
      const disconnect = engine2.connect(clientId, interest, (message) => write(message.type, message));
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}

`);
      }, 15e3);
      const close = () => {
        clearInterval(heartbeat);
        disconnect();
        streams = Math.max(0, streams - 1);
      };
      req.on("close", close);
      return;
    }
    return send(res, 404, { error: "Not found" });
  }
  function serveStatic(req, res, url) {
    const dir = options.staticDir;
    if (!dir) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("Gridiron API server. Run the client with `npm run dev`, or build it with `npm run build`.");
      return;
    }
    const root = resolve2(dir);
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const exists = existsSync2(file) && !statSync(file).isDirectory();
    if (!exists && STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
      res.end("Not found");
      return;
    }
    if (!exists) file = join(root, "index.html");
    const ext = extname(file);
    const immutable = url.pathname.startsWith("/assets/");
    const compressible = COMPRESSIBLE.has(ext);
    const accept = String(req.headers["accept-encoding"] ?? "");
    const encoding = compressible && /\bbr\b/.test(accept) && existsSync2(`${file}.br`) ? "br" : compressible && /\bgzip\b/.test(accept) && existsSync2(`${file}.gz`) ? "gzip" : null;
    const served = encoding === "br" ? `${file}.br` : encoding === "gzip" ? `${file}.gz` : file;
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "content-length": String(statSync(served).size),
      ...compressible ? { vary: "accept-encoding" } : {},
      ...encoding ? { "content-encoding": encoding } : {},
      ...ext === ".html" ? { "content-security-policy": CSP } : {},
      ...SECURITY_HEADERS
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(served).pipe(res);
  }
  return async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    noteAcceptEncoding(req, res);
    try {
      if (url.pathname === "/api/health") {
        return send(res, 200, {
          ok: true,
          version: options.version,
          mode: options.engine.mode,
          transport: options.transport ?? "sse",
          provider: options.engine.providerInfo,
          today: options.engine.today(),
          serverTime: (/* @__PURE__ */ new Date()).toISOString(),
          startedAt: new Date(options.startedAt).toISOString(),
          replayAvailable: options.replay !== null,
          teamsAvailable: !!options.teams,
          fetcher: options.fetcherStats(),
          engine: options.engine.stats(),
          ...options.health?.()
        });
      }
      for (const route of options.routes ?? []) if (await route(req, res, url)) return;
      if (url.pathname === "/api/replay/scenarios" && req.method === "GET") {
        return send(res, 200, { scenarios: options.replay?.scenarios() ?? [] });
      }
      if (url.pathname === "/api/replay/sessions" && req.method === "POST") {
        if (!options.replay) return send(res, 404, { error: "Replay lab is not available on this server" });
        const body = await readBody(req).catch(() => null) ?? {};
        const progress = typeof body.progress === "number" && body.progress >= 0 && body.progress <= 1 ? body.progress : void 0;
        const speed = typeof body.speed === "number" && body.speed >= 1 && body.speed <= 600 ? body.speed : void 0;
        const playing = typeof body.playing === "boolean" ? body.playing : void 0;
        const created = options.replay.create(typeof body.scenario === "string" ? body.scenario : "", { progress, speed, playing });
        return "error" in created ? send(res, 400, created) : send(res, 201, created);
      }
      const session = /^\/api\/replay\/s\/([a-zA-Z0-9-]{8,64})(\/.*)?$/.exec(url.pathname);
      if (session && options.replay) {
        const id = session[1];
        const rest = session[2] ?? "/";
        if (rest === "/control" && req.method === "POST") {
          const body = await readBody(req).catch(() => null);
          if (!body || typeof body !== "object") return send(res, 400, { error: "Invalid command" });
          const result = options.replay.control(id, body);
          return "error" in result ? send(res, 400, result) : send(res, 200, result);
        }
        if (rest === "/status" && req.method === "GET") {
          const status = options.replay.status(id);
          return status ? send(res, 200, status) : send(res, 404, { error: "Unknown replay session" });
        }
        const engine2 = options.replay.engine(id);
        if (!engine2) return send(res, 404, { error: "Unknown or expired replay session" });
        return await api(req, res, url, engine2, `/api/replay/s/${id}`, id);
      }
      if (url.pathname.startsWith("/api/")) return await api(req, res, url, options.engine, "/api", null);
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url);
      return send(res, 405, { error: "Method not allowed" });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: "Server error", detail: e.message });
      else res.end();
    }
  };
}

// server/markets/kalshi.ts
var KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
var KALSHI_NAME = "Kalshi";
var KALSHI_SERIES = {
  nfl: { game: "KXNFLGAME", spread: "KXNFLSPREAD", total: "KXNFLTOTAL" },
  cfb: { game: "KXNCAAFGAME", spread: "KXNCAAFSPREAD", total: "KXNCAAFTOTAL" }
};
var NFL_CODES = { JAX: "JAC", WSH: "WAS" };
var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
var MAX_LINE_GAP = 3;
var isKalshiEvent = (v) => !!v && typeof v === "object" && typeof v.event_ticker === "string";
function dateFromTicker(token) {
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(token);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  return month < 0 ? null : `20${m[1]}${String(month + 1).padStart(2, "0")}${m[3]}`;
}
function parseEventTicker(ticker) {
  const m = /^([A-Z0-9]+)-(\d{2}[A-Z]{3}\d{2})([A-Z][A-Z0-9]*)$/.exec(ticker);
  if (!m) return null;
  const date = dateFromTicker(m[2]);
  return date ? { series: m[1], date, teams: m[3] } : null;
}
var lastSegment = (ticker) => ticker.slice(ticker.lastIndexOf("-") + 1);
function kalshiCode(team) {
  const abbreviation = team.abbreviation.toUpperCase();
  return team.league === "nfl" ? NFL_CODES[abbreviation] ?? abbreviation : abbreviation;
}
function findGameEvent(events, game) {
  const start = game.startTime ? Date.parse(game.startTime) : Number.NaN;
  if (!Number.isFinite(start)) return null;
  const date = easternDateKey(new Date(start));
  const away = kalshiCode(game.away);
  const home = kalshiCode(game.home);
  for (const e of events) {
    const t = parseEventTicker(e.event_ticker);
    if (!t || t.date !== date || t.teams !== `${away}${home}` && t.teams !== `${home}${away}`) continue;
    const codes = new Set((e.markets ?? []).map((m) => lastSegment(m.ticker)));
    if (codes.has(away) && codes.has(home)) return e;
  }
  return null;
}
function nearestStrike(markets2, line, code2) {
  let best = null;
  for (const m of markets2) {
    if (typeof m.floor_strike !== "number" || !Number.isFinite(m.floor_strike)) continue;
    if (code2 !== null && !new RegExp(`^${code2}\\d+$`).test(lastSegment(m.ticker))) continue;
    if (!best || Math.abs(m.floor_strike - line) < Math.abs(best.floor_strike - line)) best = m;
  }
  return best && Math.abs(best.floor_strike - line) <= MAX_LINE_GAP ? best : null;
}
function contractsFor(game, gameEvent, spreadEvent, totalEvent) {
  const markets2 = gameEvent.markets ?? [];
  const home = markets2.find((m) => lastSegment(m.ticker) === kalshiCode(game.home))?.ticker ?? null;
  const away = markets2.find((m) => lastSegment(m.ticker) === kalshiCode(game.away))?.ticker ?? null;
  if (!home && !away) return null;
  let spread = null;
  const favorite = game.lines?.favorite ?? null;
  const favoriteLine = favorite ? game.lines?.spread?.[favorite].latest?.line ?? null : null;
  if (spreadEvent && favorite && favoriteLine !== null && favoriteLine < 0) {
    const m = nearestStrike(spreadEvent.markets ?? [], -favoriteLine, kalshiCode(game[favorite]));
    if (m) spread = { team: favorite, line: m.floor_strike, ticker: m.ticker };
  }
  let total = null;
  const bookTotal = game.lines?.total?.over.latest?.line ?? null;
  if (totalEvent && bookTotal !== null) {
    const m = nearestStrike(totalEvent.markets ?? [], bookTotal, null);
    if (m) total = { line: m.floor_strike, ticker: m.ticker };
  }
  return { event: gameEvent.event_ticker, home, away, spread, total };
}
var contractTickers = (c) => [c.home, c.away, c.spread?.ticker ?? null, c.total?.ticker ?? null].filter((t) => t !== null);
function quoteOf(m) {
  if (!m || m.status !== void 0 && m.status !== "active" && m.status !== "open") return null;
  const bid = parseDollars(m.yes_bid_dollars);
  const ask = parseDollars(m.yes_ask_dollars);
  const last = parseDollars(m.last_price_dollars);
  const price = quotePrice(bid, ask, last);
  if (price === null) return null;
  return { price, bid: bid !== null && bid > 0 ? bid : null, ask: ask !== null && ask > 0 ? ask : null, last: last !== null && last > 0 ? last : null };
}
function candlesFrom(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry;
    if (typeof c.end_period_ts !== "number" || !Number.isFinite(c.end_period_ts)) continue;
    out.push([c.end_period_ts, parseDollars(c.yes_bid?.close_dollars), parseDollars(c.yes_ask?.close_dollars), parseDollars(c.price?.close_dollars)]);
  }
  return out;
}
function pricesFrom(contracts, markets2, changedAt, stale) {
  const quote = (ticker) => ticker ? quoteOf(markets2.get(ticker)) : null;
  const home = quote(contracts.home);
  const away = quote(contracts.away);
  const spreadQuote = contracts.spread ? quote(contracts.spread.ticker) : null;
  const totalQuote = contracts.total ? quote(contracts.total.ticker) : null;
  const moneyline = home || away ? { home, away } : null;
  const spread = contracts.spread && spreadQuote ? { team: contracts.spread.team, line: contracts.spread.line, quote: spreadQuote } : null;
  const total = contracts.total && totalQuote ? { line: contracts.total.line, over: totalQuote } : null;
  if (!moneyline && !spread && !total) return null;
  return { source: KALSHI_NAME, moneyline, spread, total, changedAt, stale };
}

// server/markets/service.ts
var HOUR = 36e5;
var BATCH = 20;
var pricePrint = (p) => fingerprint(JSON.stringify([p.moneyline, p.spread, p.total]));
var MarketService = class {
  constructor(options) {
    this.options = options;
    this.base = options.base ?? KALSHI_API;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => void 0);
    this.liveMs = options.liveMs ?? 15e3;
    this.idleMs = options.idleMs ?? 5 * 6e4;
    this.discoveryMs = options.discoveryMs ?? 10 * 6e4;
    this.staleMs = options.staleMs ?? 9e4;
    this.dropMs = options.dropMs ?? 10 * 6e4;
  }
  options;
  base;
  now;
  log;
  liveMs;
  idleMs;
  discoveryMs;
  staleMs;
  dropMs;
  events = /* @__PURE__ */ new Map();
  ladders = /* @__PURE__ */ new Map();
  held = /* @__PURE__ */ new Map();
  candleCache = /* @__PURE__ */ new Map();
  counters = { source: KALSHI_NAME, reads: 0, failures: 0, matchedGames: 0, lastSuccessAt: null, lastError: null };
  target = null;
  timer = null;
  running = false;
  /** Reads prices on a schedule and hands them to `target` (the persistent server). */
  start(target) {
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
  stats() {
    return { ...this.counters };
  }
  async tick() {
    let delay = this.idleMs;
    try {
      const games = this.target?.marketGames() ?? [];
      if (!games.length) delay = Math.min(this.liveMs, 5e3);
      else if (games.some((g) => this.urgent(g))) delay = this.liveMs;
      const prices = await this.read(games);
      if (this.running) this.target?.setMarketPrices(prices);
    } catch (e) {
      this.log(`market prices failed: ${e.message}`);
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => void this.tick(), delay);
        this.timer.unref?.();
      }
    }
  }
  /** Live, or scheduled to start within the hour. */
  urgent(g) {
    if (isLiveOrPaused(g.status.kind)) return true;
    const start = g.startTime ? Date.parse(g.startTime) : Number.NaN;
    return g.status.kind === "scheduled" && Number.isFinite(start) && start - this.now() < HOUR;
  }
  /** Live, or scheduled to start within three days (and not long past its kickoff). */
  eligible(g) {
    if (isLiveOrPaused(g.status.kind)) return true;
    if (g.status.kind !== "scheduled") return false;
    const start = g.startTime ? Date.parse(g.startTime) : Number.NaN;
    return Number.isFinite(start) && start - this.now() < 72 * HOUR && this.now() - start < 6 * HOUR;
  }
  /** Current prices for each game; null for a game that is not eligible, has no matching contracts, or has no usable price. */
  async read(games) {
    const out = /* @__PURE__ */ new Map();
    const plans = /* @__PURE__ */ new Map();
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
    const markets2 = /* @__PURE__ */ new Map();
    for (let i = 0; i < tickers.length; i += BATCH) {
      const chunk = tickers.slice(i, i + BATCH);
      const data = await this.get(`/markets?tickers=${chunk.map(encodeURIComponent).join(",")}&limit=${BATCH * 2}`);
      for (const m of data?.markets ?? []) {
        if (m && typeof m === "object" && typeof m.ticker === "string") markets2.set(m.ticker, m);
      }
    }
    const now = this.now();
    for (const [id, plan] of plans) {
      const before = this.held.get(id);
      if (!contractTickers(plan).some((t) => markets2.has(t))) {
        if (before && now - before.readAt < this.dropMs) {
          const stale = now - before.readAt > this.staleMs;
          const prices2 = stale === before.prices.stale ? before.prices : { ...before.prices, stale };
          this.held.set(id, { ...before, prices: prices2 });
          out.set(id, prices2);
        } else {
          this.held.delete(id);
          out.set(id, null);
        }
        continue;
      }
      const fresh = pricesFrom(plan, markets2, new Date(now).toISOString(), false);
      if (!fresh) {
        this.held.delete(id);
        out.set(id, null);
        continue;
      }
      const print = pricePrint(fresh);
      const prices = before && before.print === print ? before.prices.stale ? { ...before.prices, stale: false } : before.prices : fresh;
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
  async history(game) {
    if (!this.eligible(game) || !game.startTime) return null;
    const plan = await this.contracts(game);
    if (!plan?.home) return null;
    const series = KALSHI_SERIES[game.league].game;
    const kickoff = Date.parse(game.startTime);
    const now = this.now();
    const minutesFrom = kickoff - HOUR;
    const hourly = await this.candles(series, plan.home, 60, kickoff - 7 * 24 * HOUR, Math.min(now, minutesFrom), 10 * 6e4);
    const minutes = now > minutesFrom ? await this.candles(series, plan.home, 1, minutesFrom, now, isLiveOrPaused(game.status.kind) ? 45e3 : 5 * 6e4) : [];
    const points = pricePoints([...hourly.filter((c) => c[0] * 1e3 <= minutesFrom), ...minutes]);
    return points.length >= 2 ? { source: KALSHI_NAME, team: "home", points, captured: false } : null;
  }
  async candles(series, ticker, minutes, from, to, maxAge) {
    if (to <= from) return [];
    const key = `${ticker}|${minutes}`;
    const cached = this.candleCache.get(key);
    if (cached && this.now() - cached.at < maxAge) return cached.candles;
    const data = await this.get(
      `/series/${series}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${Math.floor(from / 1e3)}&end_ts=${Math.floor(to / 1e3)}&period_interval=${minutes}`
    );
    const candles = data ? candlesFrom(data.candlesticks) : cached?.candles ?? [];
    if (this.candleCache.size >= 200) this.candleCache.clear();
    this.candleCache.set(key, { at: this.now(), candles });
    return candles;
  }
  async contracts(game) {
    const series = KALSHI_SERIES[game.league];
    const events = await this.openEvents(series.game);
    const gameEvent = events ? findGameEvent(events, game) : null;
    if (!gameEvent) return null;
    const suffix = gameEvent.event_ticker.slice(gameEvent.event_ticker.indexOf("-") + 1);
    const spreadEvent = game.lines?.spread ? await this.ladder(`${series.spread}-${suffix}`) : null;
    const totalEvent = game.lines?.total ? await this.ladder(`${series.total}-${suffix}`) : null;
    return contractsFor(game, gameEvent, spreadEvent, totalEvent);
  }
  async openEvents(seriesTicker) {
    const cached = this.events.get(seriesTicker);
    if (cached && this.now() - cached.at < (cached.list ? this.discoveryMs : 6e4)) return cached.list;
    const list = [];
    let cursor = "";
    let ok = true;
    for (let page = 0; page < 5; page++) {
      const data = await this.get(`/events?series_ticker=${seriesTicker}&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!data) {
        ok = false;
        break;
      }
      list.push(...(data.events ?? []).filter(isKalshiEvent));
      cursor = typeof data.cursor === "string" ? data.cursor : "";
      if (!cursor) break;
    }
    const value = ok ? list : cached?.list ?? null;
    this.events.set(seriesTicker, { at: this.now(), list: value });
    return value;
  }
  async ladder(eventTicker) {
    const cached = this.ladders.get(eventTicker);
    if (cached && this.now() - cached.at < this.discoveryMs) return cached.event;
    const data = await this.get(`/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`);
    const raw = data?.event;
    const event = isKalshiEvent(raw) ? { ...raw, markets: raw.markets ?? (data?.markets ?? []) } : null;
    const value = event ?? cached?.event ?? null;
    this.ladders.set(eventTicker, { at: this.now(), event: value });
    return value;
  }
  async get(path) {
    this.counters.reads++;
    const res = await this.options.fetcher.getJson(`${this.base}${path}`);
    if (res.ok) {
      this.counters.lastSuccessAt = new Date(res.receivedAt).toISOString();
      this.counters.lastError = null;
      return res.data;
    }
    this.counters.failures++;
    this.counters.lastError = res.error;
    return null;
  }
};

// server/party.ts
import { randomBytes, randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";
var MAX_STATE_BYTES = 4096;
var MAX_FOCUS_GAMES = 4;
var MAX_DELAY_SECONDS = 300;
var RATE_WINDOW_MS = 1e3;
var STATE_KEYS = ["route", "focusGames", "source", "inspection", "delaySeconds", "date", "league"];
var ROUTE_NAMES = ["slate", "focus", "wall", "game", "team"];
var LEAGUE_FILTERS = ["all", "nfl", "cfb"];
var TEAM_ID = /^(nfl|cfb)-\d{1,6}$/;
var SESSION_ID = /^[a-zA-Z0-9-]{8,64}$/;
var PLAY_ID = /^[\w:.-]{1,64}$/;
var isGameId = (v) => typeof v === "string" && parseGameId(v) !== null;
function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return null;
  }
}
function readRoute(value) {
  if (!isRecord(value)) return { error: "route must be an object" };
  const name = value.name;
  if (!ROUTE_NAMES.includes(name)) return { error: "route.name must be slate, focus, wall, game or team" };
  const id = value.id;
  if (name === "game") return isGameId(id) ? { value: { name, id } } : { error: "route.id must be a game id for a game route" };
  if (name === "team") {
    return typeof id === "string" && TEAM_ID.test(id) ? { value: { name, id } } : { error: "route.id must be nfl- or cfb- followed by up to 6 digits for a team route" };
  }
  return id === null ? { value: { name, id } } : { error: `route.id must be null for a ${name} route` };
}
function readFocusGames(value) {
  if (!Array.isArray(value)) return { error: "focusGames must be an array" };
  const games = /* @__PURE__ */ new Set();
  for (const game of value) {
    if (!isGameId(game)) return { error: "focusGames must contain only game ids" };
    games.add(game);
  }
  return games.size <= MAX_FOCUS_GAMES ? { value: [...games] } : { error: `focusGames may hold at most ${MAX_FOCUS_GAMES} different games` };
}
function readSource(value) {
  if (!isRecord(value)) return { error: "source must be an object" };
  if (value.kind === "live") return { value: { kind: "live" } };
  if (value.kind !== "replay") return { error: "source.kind must be live or replay" };
  const sessionId = value.sessionId;
  return typeof sessionId === "string" && SESSION_ID.test(sessionId) ? { value: { kind: "replay", sessionId } } : { error: "source.sessionId must be 8 to 64 letters, digits or hyphens" };
}
function readInspection(value) {
  if (value === null) return { value: null };
  if (!isRecord(value)) return { error: "inspection must be null or an object" };
  const gameId2 = value.gameId;
  if (!isGameId(gameId2)) return { error: "inspection.gameId must be a game id" };
  const playId = value.playId;
  if (playId === null || typeof playId === "string" && PLAY_ID.test(playId)) return { value: { gameId: gameId2, playId } };
  return { error: "inspection.playId must be null or 1 to 64 letters, digits, underscores, colons, dots or hyphens" };
}
function readDelay(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DELAY_SECONDS ? { value } : { error: `delaySeconds must be a whole number from 0 to ${MAX_DELAY_SECONDS}` };
}
function readDate(value) {
  return value === null || isDateKey(value) ? { value } : { error: "date must be null or a YYYYMMDD date key" };
}
function readLeague(value) {
  const league = value;
  return LEAGUE_FILTERS.includes(league) ? { value: league } : { error: "league must be all, nfl or cfb" };
}
function validatePartyState(value) {
  if (!isRecord(value)) return { ok: false, error: "Party state must be an object" };
  const bytes = serializedBytes(value);
  if (bytes === null) return { ok: false, error: "Party state must be plain JSON" };
  if (bytes > MAX_STATE_BYTES) return { ok: false, error: `Party state must be at most ${MAX_STATE_BYTES} bytes as JSON` };
  const unknownKey = Object.keys(value).find((key) => !STATE_KEYS.includes(key));
  if (unknownKey !== void 0) return { ok: false, error: `Unknown party state key "${unknownKey.slice(0, 64)}"` };
  const route = readRoute(value.route);
  if ("error" in route) return { ok: false, error: route.error };
  const focusGames = readFocusGames(value.focusGames);
  if ("error" in focusGames) return { ok: false, error: focusGames.error };
  const source = readSource(value.source);
  if ("error" in source) return { ok: false, error: source.error };
  const inspection = readInspection(value.inspection);
  if ("error" in inspection) return { ok: false, error: inspection.error };
  const delay = readDelay(value.delaySeconds);
  if ("error" in delay) return { ok: false, error: delay.error };
  const date = readDate(value.date);
  if ("error" in date) return { ok: false, error: date.error };
  const league = readLeague(value.league);
  if ("error" in league) return { ok: false, error: league.error };
  return {
    ok: true,
    state: { route: route.value, focusGames: focusGames.value, source: source.value, inspection: inspection.value, delaySeconds: delay.value, date: date.value, league: league.value }
  };
}
var notFound = () => ({ ok: false, status: 404, error: "Unknown or ended watch party" });
var forbidden = () => ({ ok: false, status: 403, error: "Only the host can change this watch party" });
function tokenMatches(expected, given) {
  if (typeof given !== "string" || expected.length === 0) return false;
  const candidate = Buffer.from(given);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function deliver(member, event) {
  try {
    member.listener(event);
  } catch {
  }
}
var PartyHub = class {
  parties = /* @__PURE__ */ new Map();
  maxParties;
  maxMembers;
  idleMs;
  maxUpdatesPerSecond;
  now;
  randomId;
  randomToken;
  sweeper = null;
  constructor(options = {}) {
    this.maxParties = options.maxParties ?? 200;
    this.maxMembers = options.maxMembers ?? 50;
    this.idleMs = options.idleMs ?? 6 * 60 * 6e4;
    this.maxUpdatesPerSecond = options.maxUpdatesPerSecond ?? 8;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID2;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  }
  /** Starts a party. When the hub is full, idle parties are swept first; if it is still full the answer is 503. */
  create(state) {
    const checked = validatePartyState(state);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    if (this.parties.size >= this.maxParties) this.sweep();
    if (this.parties.size >= this.maxParties) return { ok: false, status: 503, error: "Too many watch parties are running; try again shortly" };
    const id = this.randomId();
    if (this.parties.has(id)) return { ok: false, status: 503, error: "Could not start a watch party; try again" };
    const hostToken = this.randomToken();
    const now = this.now();
    const party = { id, hostToken: Buffer.from(hostToken), state: checked.state, rev: 0, createdAt: now, updatedAt: now, lastActivity: now, recentUpdates: [], members: /* @__PURE__ */ new Set(), ended: false };
    this.parties.set(id, party);
    return { ok: true, value: { id, hostToken, view: this.toView(party) } };
  }
  view(id) {
    const party = this.find(id);
    return party ? { ok: true, value: this.toView(party) } : notFound();
  }
  /**
   * Replaces the host's view. Checks run in order: unknown party (404), wrong
   * token (403), invalid state (400), too many updates (429). Only accepted
   * updates count toward the rate, so nobody without the token can spend it.
   */
  update(id, hostToken, state) {
    const party = this.find(id);
    if (!party) return notFound();
    if (!tokenMatches(party.hostToken, hostToken)) return forbidden();
    const checked = validatePartyState(state);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    const now = this.now();
    if (!this.takeUpdateSlot(party, now)) return { ok: false, status: 429, error: "The host is changing the view too quickly; try again in a moment" };
    party.state = checked.state;
    party.rev += 1;
    party.updatedAt = now;
    party.lastActivity = now;
    this.broadcast(party, { type: "state", view: this.toView(party) });
    return { ok: true, value: this.toView(party) };
  }
  /** Sends the new listener the current view, then everyone the member count. The returned function leaves, once. */
  subscribe(id, listener) {
    const party = this.find(id);
    if (!party) return notFound();
    if (party.members.size >= this.maxMembers) return { ok: false, status: 429, error: "This watch party is full" };
    const member = { listener };
    party.members.add(member);
    deliver(member, { type: "state", view: this.toView(party) });
    this.broadcast(party, { type: "members", members: party.members.size });
    return { ok: true, value: () => this.leave(party, member) };
  }
  /** Tells every listener the party is over, then removes it. */
  end(id, hostToken) {
    const party = this.find(id);
    if (!party) return notFound();
    if (!tokenMatches(party.hostToken, hostToken)) return forbidden();
    party.ended = true;
    this.broadcast(party, { type: "ended" });
    party.members.clear();
    this.parties.delete(id);
    return { ok: true, value: true };
  }
  /** Removes parties nobody is watching whose last update or member departure is older than idleMs. Returns how many went. */
  sweep() {
    const now = this.now();
    let removed = 0;
    for (const [id, party] of this.parties) {
      if (party.members.size > 0 || now - party.lastActivity <= this.idleMs) continue;
      party.ended = true;
      this.parties.delete(id);
      removed++;
    }
    return removed;
  }
  /** Sweeps on a timer that never keeps the process alive. Starting again replaces the timer. */
  start(intervalMs = 6e4) {
    this.stop();
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref?.();
  }
  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
  stats() {
    let members = 0;
    for (const party of this.parties.values()) members += party.members.size;
    return { parties: this.parties.size, members };
  }
  /** Ended parties stay mapped only while their final event goes out, and are already gone to callers. */
  find(id) {
    const party = this.parties.get(id);
    return party && !party.ended ? party : null;
  }
  /** A copy, so no listener or caller can reach the stored state. */
  toView(party) {
    return { id: party.id, state: structuredClone(party.state), rev: party.rev, members: party.members.size, createdAt: party.createdAt, updatedAt: party.updatedAt };
  }
  /** Sliding one-second window. Entries from the future (a clock stepped back) are dropped so they cannot lock the host out. */
  takeUpdateSlot(party, now) {
    party.recentUpdates = party.recentUpdates.filter((at2) => at2 > now - RATE_WINDOW_MS && at2 <= now);
    if (party.recentUpdates.length >= this.maxUpdatesPerSecond) return false;
    party.recentUpdates.push(now);
    return true;
  }
  leave(party, member) {
    if (!party.members.delete(member) || party.ended) return;
    party.lastActivity = this.now();
    this.broadcast(party, { type: "members", members: party.members.size });
  }
  /** Walks a copy of the members: a listener may join or leave while hearing the event. */
  broadcast(party, event) {
    for (const member of [...party.members]) if (party.members.has(member)) deliver(member, event);
  }
};

// server/rateLimit.ts
var RateLimiter = class {
  constructor(limit, windowMs, now = Date.now, maxKeys = 1e4) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
  }
  limit;
  windowMs;
  now;
  maxKeys;
  windows = /* @__PURE__ */ new Map();
  /** Counts one request for `key`. Returns 0 when it is allowed, or the whole seconds to wait. */
  take(key) {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs || t < w.start) {
      if (w) this.windows.delete(key);
      else if (this.windows.size >= this.maxKeys) this.prune(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1e3));
    w.count++;
    return 0;
  }
  get size() {
    return this.windows.size;
  }
  prune(t) {
    for (const [key, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(key);
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys * 0.9) break;
      this.windows.delete(key);
    }
  }
};

// server/partyRoutes.ts
var PARTY_ID = /^[a-zA-Z0-9-]{8,64}$/;
var BODY_LIMIT = 8192;
function bearer(req) {
  return /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
}
async function stateFrom(req) {
  try {
    const body = await readBody(req, BODY_LIMIT);
    return { state: body && typeof body === "object" ? body.state : void 0 };
  } catch {
    return null;
  }
}
function createPartyRoutes(options) {
  const creates = new RateLimiter(12, 10 * 6e4, options.now);
  const writes = new RateLimiter(600, 6e4, options.now);
  const maxStreams = options.maxStreams ?? 1e3;
  let streams = 0;
  return async (req, res, url) => {
    if (url.pathname !== "/api/party" && !url.pathname.startsWith("/api/party/")) return false;
    const hub = options.hub;
    if (!hub) {
      send(res, 503, { error: options.reason ?? "Watch parties are not available on this server" });
      return true;
    }
    const address = clientAddress(req, options.trustProxy === true);
    const writing = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
    if (writing && !sameOrigin(req)) {
      send(res, 403, { error: "Cross-site requests are not allowed" });
      return true;
    }
    if (url.pathname === "/api/party") {
      if (req.method !== "POST") {
        send(res, 405, { error: "Method not allowed" });
        return true;
      }
      const wait = creates.take(address);
      if (wait) {
        send(res, 429, { error: "Too many watch parties started from here; try again later" }, { "retry-after": String(wait) });
        return true;
      }
      const body = await stateFrom(req);
      if (!body) {
        send(res, 400, { error: "Invalid JSON body" });
        return true;
      }
      const created = hub.create(body.state);
      if (created.ok) send(res, 201, created.value);
      else send(res, created.status, { error: created.error });
      return true;
    }
    const match = /^\/api\/party\/([^/]+)(\/stream)?$/.exec(url.pathname);
    if (!match || !PARTY_ID.test(match[1])) {
      send(res, 404, { error: "Unknown or ended watch party" });
      return true;
    }
    const id = match[1];
    if (match[2]) {
      if (req.method !== "GET") {
        send(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (streams >= maxStreams) {
        send(res, 503, { error: "Too many live connections" });
        return true;
      }
      let open2 = false;
      const pending = [];
      const write = (event) => {
        if (!open2) {
          pending.push(event);
          return;
        }
        if (res.writableEnded) return;
        res.write(`event: ${event.type}
data: ${JSON.stringify(event)}

`);
        if (event.type === "ended") res.end();
      };
      const joined = hub.subscribe(id, write);
      if (!joined.ok) {
        send(res, joined.status, { error: joined.error });
        return true;
      }
      streams++;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...SECURITY_HEADERS
      });
      res.write("retry: 4000\n\n");
      open2 = true;
      for (const event of pending.splice(0)) write(event);
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}

`);
      }, 15e3);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        joined.value();
        streams = Math.max(0, streams - 1);
      };
      req.on("close", close);
      res.on("close", close);
      return true;
    }
    if (req.method === "GET") {
      const view = hub.view(id);
      if (view.ok) send(res, 200, view.value);
      else send(res, view.status, { error: view.error });
      return true;
    }
    if (req.method === "PUT" || req.method === "DELETE") {
      const wait = writes.take(address);
      if (wait) {
        send(res, 429, { error: "Too many requests; try again shortly" }, { "retry-after": String(wait) });
        return true;
      }
      if (req.method === "DELETE") {
        const ended = hub.end(id, bearer(req));
        if (ended.ok) send(res, 200, { ok: true });
        else send(res, ended.status, { error: ended.error });
        return true;
      }
      const body = await stateFrom(req);
      if (!body) {
        send(res, 400, { error: "Invalid JSON body" });
        return true;
      }
      const updated = hub.update(id, bearer(req), body.state);
      if (updated.ok) send(res, 200, updated.value);
      else send(res, updated.status, { error: updated.error });
      return true;
    }
    send(res, 405, { error: "Method not allowed" });
    return true;
  };
}

// server/providers/espn/provider.ts
import { existsSync as existsSync3, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// server/providers/espn/raw.ts
var obj = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
var arr = (v) => Array.isArray(v) ? v : [];
var str = (v) => {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};
var num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
var bool = (v) => typeof v === "boolean" ? v : null;
function at(v, ...path) {
  let cur = v;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return void 0;
      cur = cur[key];
    } else {
      const o = obj(cur);
      if (!o) return void 0;
      cur = o[key];
    }
  }
  return cur;
}
var hexColor = (v) => {
  const s = str(v);
  return s && /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
};
var safeUrl = (v, hosts = /(^|\.)espncdn\.com$|(^|\.)espn\.com$/) => {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !hosts.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
};

// server/providers/espn/coverage.ts
var CORE_BASE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football";
function divisionFromGroupName(g) {
  const text2 = [g.name, g.abbreviation, g.shortName].filter(Boolean).join(" | ").toLowerCase();
  if (/\bfbs\b|division i-a\b|\bi-a\b/.test(text2)) return "FBS";
  if (/\bfcs\b|division i-aa\b|\bi-aa\b/.test(text2)) return "FCS";
  if (/division iii\b|\bd3\b/.test(text2)) return "D3";
  if (/division ii\b|\bd2\b/.test(text2)) return "D2";
  return null;
}
var LABEL = { NFL: "NFL", FBS: "FBS", FCS: "FCS", D2: "Division II", D3: "Division III" };
function coreRef(ref) {
  const s = str(ref);
  if (!s) return null;
  try {
    const u = new URL(s);
    u.protocol = "https:";
    if (u.hostname === "sports.core.api.espn.pvt") u.hostname = "sports.core.api.espn.com";
    if (u.hostname !== "sports.core.api.espn.com") return null;
    return u.toString();
  } catch {
    return null;
  }
}
async function discoverCollegeDivisions(fetcher2, season, seasonType, now = Date.now) {
  const listUrl = `${CORE_BASE}/seasons/${season}/types/${seasonType}/groups?limit=100`;
  const list = await fetcher2.getJson(listUrl);
  if (!list.ok) throw new Error(`College group list unavailable: ${list.error}`);
  const parents = arr(obj(list.data)?.items).map((it) => coreRef(obj(it)?.$ref)).filter((u) => !!u);
  if (!parents.length) throw new Error("College group list was empty");
  const groups = [];
  for (const parentUrl of parents) {
    const parent = await fetcher2.getJson(parentUrl);
    const p = parent.ok ? obj(parent.data) : null;
    const parentId = str(p?.id);
    const parentName = str(p?.name);
    const childrenUrl = `${parentUrl.split("?")[0]}/children?limit=100`;
    const children = await fetcher2.getJson(childrenUrl);
    if (!children.ok) continue;
    for (const item of arr(obj(children.data)?.items)) {
      const ref = coreRef(obj(item)?.$ref);
      if (!ref) continue;
      const child = await fetcher2.getJson(ref);
      const c = child.ok ? obj(child.data) : null;
      const id = str(c?.id);
      if (!c || !id) continue;
      const division = divisionFromGroupName({ name: str(c.name), abbreviation: str(c.abbreviation), shortName: str(c.shortName) });
      if (!division || groups.some((g) => g.division === division)) continue;
      groups.push({ division, label: LABEL[division], groupId: id, parentId, parentName });
    }
  }
  if (!groups.length) throw new Error("No recognisable college divisions in the provider group list");
  const order = ["FBS", "FCS", "D2", "D3"];
  groups.sort((a, b) => order.indexOf(a.division) - order.indexOf(b.division));
  return { season, seasonType, groups, discoveredAt: now(), source: listUrl };
}
function seasonForDate(scoreboard, dateKey) {
  const league = obj(arr(obj(scoreboard)?.leagues)[0]);
  if (!league) return null;
  const season = Number(str(obj(league.season)?.year));
  const noonEastern = Date.parse(`${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}T16:00:00Z`);
  for (const entry of arr(league.calendar)) {
    const e = obj(entry);
    const start = Date.parse(str(e?.startDate) ?? "");
    const end = Date.parse(str(e?.endDate) ?? "");
    const type = Number(str(e?.value));
    if (Number.isFinite(start) && Number.isFinite(end) && noonEastern >= start && noonEastern < end && Number.isFinite(type)) {
      return { season: Number.isFinite(season) ? season : new Date(noonEastern).getUTCFullYear(), seasonType: type };
    }
  }
  return null;
}

// shared/field.ts
var FIELD = {
  playing: 100,
  endZone: 10,
  total: 120,
  width: 160 / 3
  // 53 1/3 yards
};
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function labelFromProgress(progress, offense, teams2) {
  const p = Math.round(clamp(progress, 0, 100));
  if (p === 50) return "50";
  const offenseAbbr = teams2[offense].abbreviation;
  const defenseAbbr = teams2[offense === "home" ? "away" : "home"].abbreviation;
  if (p === 0) return `${offenseAbbr} goal line`;
  if (p === 100) return `${defenseAbbr} goal line`;
  return p < 50 ? `${offenseAbbr} ${p}` : `${defenseAbbr} ${100 - p}`;
}
function progressFromSchematicYard(yard, offense) {
  return offense === "away" ? yard : 100 - yard;
}
var HASH_LATERAL = {
  nfl: [70.75 / 160, 1 - 70.75 / 160],
  cfb: [60 / 160, 1 - 60 / 160]
};

// server/providers/espn/classify.ts
var RULES = [
  [/^passing touchdown$/i, "touchdown_pass"],
  [/^rushing touchdown$/i, "touchdown_rush"],
  [/return touchdown$/i, "touchdown_return"],
  // interception, fumble, punt, kickoff, missed field goal returns
  [/^blocked (punt|field goal) touchdown$/i, "touchdown_return"],
  [/^field goal good$/i, "field_goal_good"],
  [/^field goal missed$|^missed field goal return$/i, "field_goal_missed"],
  [/^blocked field goal$/i, "field_goal_blocked"],
  [/two.?point|2\s?pt\b|2-pt\b/i, "two_point"],
  [/^extra point|^pat\b/i, "extra_point"],
  [/^safety$/i, "safety"],
  [/^sack opp fumble recovery$/i, "fumble_lost"],
  [/^sack$/i, "sack"],
  [/^(pass )?interception( return)?$/i, "interception"],
  [/^fumble recovery \(opponent\)$|^muffed (punt|kick|kickoff) recovery \(opponent\)$/i, "fumble_lost"],
  [/^fumble recovery \(own\)$|^muffed (punt|kick|kickoff) recovery \(own\)$/i, "fumble_recovered_own"],
  [/^fumble$/i, "fumble"],
  [/^blocked punt$/i, "punt_blocked"],
  [/^punt return$/i, "punt_return"],
  [/^punt$/i, "punt"],
  [/^kickoff return/i, "kickoff_return"],
  [/^kickoff$/i, "kickoff"],
  [/^pass reception$|^pass completion$/i, "pass_complete"],
  [/^pass incompletion$/i, "pass_incomplete"],
  [/^rush$/i, "rush"],
  [/^penalty$/i, "penalty"],
  [/two.?minute warning/i, "two_minute_warning"],
  [/timeout/i, "timeout"],
  [/^end period$|^end of (1st|2nd|3rd|4th) quarter$/i, "end_period"],
  [/^end of half$/i, "end_half"],
  [/^end of regulation$/i, "end_regulation"],
  [/^end of game$/i, "end_game"],
  [/coin toss/i, "coin_toss"]
];
function classifyPlayType(typeText) {
  if (!typeText) return "other";
  const t = typeText.trim();
  for (const [re, kind] of RULES) if (re.test(t)) return kind;
  return "other";
}
var kickResult = (word) => {
  const w = word.toLowerCase();
  if (w === "good" || w === "succeeds") return "good";
  if (w === "blocked") return "blocked";
  if (w === "no good" || w === "failed" || w === "fails" || w === "aborted" || w === "missed") return "failed";
  return "unknown";
};
function parseConversion(text2) {
  if (!text2) return null;
  let m = /two-point conversion attempt[\s\S]{0,200}?attempt (succeeds|fails)/i.exec(text2);
  if (m) return { kind: "two-point", result: kickResult(m[1]) };
  m = /\b(?:two-point|2-pt|2pt)\b[^.]{0,120}?\b(good|failed|no good|succeeds|fails)\b/i.exec(text2);
  if (m) return { kind: "two-point", result: kickResult(m[1]) };
  m = /extra point is (good|no good|blocked|aborted)/i.exec(text2);
  if (m) return { kind: "kick", result: kickResult(m[1]) };
  m = /\bkick attempt (good|no good|failed|blocked|missed)/i.exec(text2);
  if (m) return { kind: "kick", result: kickResult(m[1]) };
  return null;
}
function parseReview(text2) {
  if (!text2) return null;
  const m = /(?:replay official reviewed|challenged)[\s\S]{0,200}?the play was (upheld|reversed|overturned)/i.exec(text2);
  if (m) return { outcome: m[1].toLowerCase() === "upheld" ? "upheld" : "reversed" };
  if (/ruling (?:on the field )?stands/i.test(text2)) return { outcome: "stands" };
  if (/replay official reviewed|challenged the/i.test(text2)) return { outcome: "unknown" };
  return null;
}

// server/providers/espn/odds.ts
var WIN_PROBABILITY_SOURCE = "ESPN";
function lineNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = str(raw)?.trim();
  if (!s) return null;
  if (/^(pk|pick|even)$/i.test(s)) return 0;
  const m = /^[ou]?\s*([+-]?\d+(?:\.\d+)?)$/i.exec(s);
  return m ? Number(m[1]) : null;
}
var oddsPair = (side) => ({ open: parseAmerican(at(side, "open", "odds")), latest: parseAmerican(at(side, "close", "odds")) });
function linePrice(raw) {
  const line = lineNumber(at(raw, "line"));
  return line === null ? null : { line, odds: parseAmerican(at(raw, "odds")) };
}
var linePair = (side) => ({ open: linePrice(at(side, "open")), latest: linePrice(at(side, "close")) });
var reported = (pair) => pair.open !== null || pair.latest !== null;
function normalizeLines(raw, homeProviderId, awayProviderId) {
  const entries = arr(raw).map(obj).filter((e2) => e2 !== null && obj(e2.provider) !== null);
  const e = entries.find((x) => num(at(x, "provider", "priority")) === 1) ?? entries[0];
  if (!e) return null;
  const provider = str(at(e, "provider", "displayName")) ?? str(at(e, "provider", "name"));
  if (!provider) return null;
  const homeId = str(at(e, "homeTeamOdds", "teamId")) ?? str(at(e, "homeTeamOdds", "team", "id"));
  const awayId = str(at(e, "awayTeamOdds", "teamId")) ?? str(at(e, "awayTeamOdds", "team", "id"));
  const swapped = homeId === awayProviderId && awayId === homeProviderId;
  if (!swapped && (homeId !== null && homeId !== homeProviderId || awayId !== null && awayId !== awayProviderId)) return null;
  const H = swapped ? "away" : "home";
  const A = swapped ? "home" : "away";
  let moneyline = obj(e.moneyline) ? { home: oddsPair(at(e, "moneyline", H)), away: oddsPair(at(e, "moneyline", A)) } : null;
  if (!moneyline || !reported(moneyline.home) && !reported(moneyline.away)) {
    const home = parseAmerican(at(e, `${H}TeamOdds`, "moneyLine"));
    const away = parseAmerican(at(e, `${A}TeamOdds`, "moneyLine"));
    moneyline = home !== null || away !== null ? { home: { open: null, latest: home }, away: { open: null, latest: away } } : null;
  }
  const spreadRaw = obj(e.pointSpread);
  const spreadPairs = spreadRaw ? { home: linePair(spreadRaw[H]), away: linePair(spreadRaw[A]) } : null;
  const spread = spreadPairs && (reported(spreadPairs.home) || reported(spreadPairs.away)) ? spreadPairs : null;
  const totalRaw = obj(e.total);
  let total = totalRaw ? { over: linePair(totalRaw.over), under: linePair(totalRaw.under) } : null;
  if (!total || !reported(total.over) && !reported(total.under)) {
    const line = num(e.overUnder);
    total = line !== null && line > 0 ? { over: { open: null, latest: { line, odds: parseAmerican(e.overOdds) } }, under: { open: null, latest: { line, odds: parseAmerican(e.underOdds) } } } : null;
  }
  if (!moneyline && !spread && !total) return null;
  const homeFavorite = bool(at(e, `${H}TeamOdds`, "favorite"));
  const awayFavorite = bool(at(e, `${A}TeamOdds`, "favorite"));
  const homeLine = spread?.home.latest?.line ?? null;
  const favorite = homeFavorite === true && awayFavorite !== true ? "home" : awayFavorite === true && homeFavorite !== true ? "away" : homeLine !== null && homeLine !== 0 ? homeLine < 0 ? "home" : "away" : null;
  return { provider, details: str(e.details), favorite, moneyline, spread, total };
}
function normalizeWinProbability(raw, gameId2) {
  const out = [];
  for (const item of arr(raw)) {
    const e = obj(item);
    const home = num(e?.homeWinPercentage);
    const playId = str(e?.playId);
    if (home === null || home < 0 || home > 1 || !playId) continue;
    const tie = num(e?.tiePercentage);
    out.push({ playId: `${gameId2}:${playId}`, home, tie: tie !== null && tie >= 0 && tie <= 1 ? tie : 0 });
  }
  return out;
}
function latestWinProbability(points) {
  const last = points[points.length - 1];
  return last ? { home: last.home, tie: last.tie, playId: last.playId, source: WIN_PROBABILITY_SOURCE } : null;
}
function lastPlayWinProbability(lastPlay, gameId2) {
  const p = obj(at(lastPlay, "probability"));
  const home = num(p?.homeWinPercentage);
  if (!p || home === null || home < 0 || home > 1) return null;
  const tie = num(p.tiePercentage);
  const id = str(at(lastPlay, "id"));
  return { home, tie: tie !== null && tie >= 0 && tie <= 1 ? tie : 0, playId: id ? `${gameId2}:${id}` : null, source: WIN_PROBABILITY_SOURCE };
}
function normalizePredictor(raw, homeProviderId, awayProviderId) {
  const p = obj(raw);
  if (!p) return null;
  const share = (side, teamId) => {
    const value = num(at(side, "gameProjection"));
    return str(at(side, "id")) === teamId && value !== null && value >= 0 && value <= 100 ? value / 100 : null;
  };
  const home = share(p.homeTeam, homeProviderId);
  const away = share(p.awayTeam, awayProviderId);
  return home !== null && away !== null ? { home, away, source: WIN_PROBABILITY_SOURCE } : null;
}
function coreTeamId(side) {
  const ref = str(at(side, "team", "$ref"));
  const m = ref ? /\/teams\/(\d+)(?:[/?]|$)/.exec(ref) : null;
  return m ? m[1] : str(at(side, "team", "id")) ?? null;
}
var coreLine = (raw) => lineNumber(at(raw, "american") ?? at(raw, "value"));
var corePrice = (raw) => parseAmerican(at(raw, "american") ?? at(raw, "alternateDisplayValue"));
var coreNow = (o) => obj(o.current) ?? obj(o.close);
function coreSpread(side) {
  const price = (from) => {
    const line = coreLine(at(from, "pointSpread"));
    return line === null ? null : { line, odds: corePrice(at(from, "spread")) };
  };
  const o = obj(side);
  return { open: price(o?.open), latest: price(o ? coreNow(o) : null) };
}
function coreMoneyline(side) {
  const o = obj(side);
  return { open: corePrice(at(o?.open, "moneyLine")), latest: corePrice(at(o ? coreNow(o) : null, "moneyLine")) };
}
function coreTotal(entry, which) {
  const price = (from) => {
    const line = coreLine(at(from, "total"));
    return line === null ? null : { line, odds: corePrice(at(from, which)) };
  };
  return { open: price(entry.open), latest: price(coreNow(entry)) };
}
function normalizeCoreOdds(raw, homeProviderId, awayProviderId) {
  const entries = arr(at(raw, "items") ?? raw).map(obj).filter((e2) => e2 !== null && obj(e2.provider) !== null);
  const e = entries.find((x) => num(at(x, "provider", "priority")) === 1) ?? entries[0];
  if (!e) return null;
  const provider = str(at(e, "provider", "displayName")) ?? str(at(e, "provider", "name"));
  if (!provider) return null;
  const homeId = coreTeamId(e.homeTeamOdds);
  const awayId = coreTeamId(e.awayTeamOdds);
  const swapped = homeId === awayProviderId && awayId === homeProviderId;
  if (!swapped && (homeId !== null && homeId !== homeProviderId || awayId !== null && awayId !== awayProviderId)) return null;
  const H = swapped ? "awayTeamOdds" : "homeTeamOdds";
  const A = swapped ? "homeTeamOdds" : "awayTeamOdds";
  const spreadPairs = { home: coreSpread(e[H]), away: coreSpread(e[A]) };
  const spread = reported(spreadPairs.home) || reported(spreadPairs.away) ? spreadPairs : null;
  const moneylinePairs = { home: coreMoneyline(e[H]), away: coreMoneyline(e[A]) };
  const moneyline = reported(moneylinePairs.home) || reported(moneylinePairs.away) ? moneylinePairs : null;
  const totalPairs = { over: coreTotal(e, "over"), under: coreTotal(e, "under") };
  const total = reported(totalPairs.over) || reported(totalPairs.under) ? totalPairs : null;
  if (!spread && !moneyline && !total) return null;
  const homeFavorite = bool(at(e, H, "favorite"));
  const awayFavorite = bool(at(e, A, "favorite"));
  const homeLine = spread?.home.latest?.line ?? null;
  const favorite = homeFavorite === true && awayFavorite !== true ? "home" : awayFavorite === true && homeFavorite !== true ? "away" : homeLine !== null && homeLine !== 0 ? homeLine < 0 ? "home" : "away" : null;
  return { provider, details: str(e.details), favorite, moneyline, spread, total };
}
function coreOddsUrl(league, providerEventId) {
  if (!/^\d{1,32}$/.test(providerEventId)) return null;
  const path = league === "nfl" ? "nfl" : "college-football";
  return `https://sports.core.api.espn.com/v2/sports/football/leagues/${path}/events/${providerEventId}/competitions/${providerEventId}/odds?limit=10`;
}
function preferLiveLines(fromSummary, fromCore) {
  if (!fromCore) return fromSummary;
  if (!fromSummary || fromSummary.provider !== fromCore.provider) return fromCore;
  const pair = (core, summary) => ({
    open: core.open ?? summary?.open ?? null,
    latest: core.latest ?? summary?.latest ?? null
  });
  return {
    ...fromCore,
    details: fromCore.details ?? fromSummary.details,
    favorite: fromCore.favorite ?? fromSummary.favorite,
    moneyline: fromCore.moneyline ? { home: pair(fromCore.moneyline.home, fromSummary.moneyline?.home), away: pair(fromCore.moneyline.away, fromSummary.moneyline?.away) } : fromSummary.moneyline,
    spread: fromCore.spread ? { home: pair(fromCore.spread.home, fromSummary.spread?.home), away: pair(fromCore.spread.away, fromSummary.spread?.away) } : fromSummary.spread,
    total: fromCore.total ? { over: pair(fromCore.total.over, fromSummary.total?.over), under: pair(fromCore.total.under, fromSummary.total?.under) } : fromSummary.total
  };
}
function normalizeWeather(raw) {
  const w = obj(raw);
  if (!w) return null;
  const conditionId = num(w.conditionId) ?? (str(w.conditionId) !== null ? Number(str(w.conditionId)) : null);
  const temperature = num(w.temperature) ?? num(w.highTemperature);
  const displayValue = str(w.displayValue);
  const id = conditionId !== null && Number.isFinite(conditionId) ? conditionId : null;
  if (id === null && temperature === null && !displayValue) return null;
  return { conditionId: id, temperature, displayValue };
}

// server/providers/espn/normalize.ts
var PROVIDER_NAME = "ESPN";
var SITE_BASE = "https://site.api.espn.com/apis/site/v2/sports/football";
var RESULT_LIMIT = 500;
var espnLeaguePath = (league) => league === "nfl" ? "nfl" : "college-football";
function scoreboardUrl(league, dateKey, groupId) {
  const q = new URLSearchParams({ dates: dateKey, limit: String(RESULT_LIMIT) });
  if (groupId) q.set("groups", groupId);
  return `${SITE_BASE}/${espnLeaguePath(league)}/scoreboard?${q.toString()}`;
}
var newDiagnostics = () => ({
  invalidEvents: 0,
  spotSignalConflicts: 0,
  ignoredStoppageTeams: 0,
  reorderedPlays: 0,
  duplicatePlays: 0
});
function parseScoreboard(json) {
  const root = obj(json);
  if (!root) return { ok: false, error: "Scoreboard response was not a JSON object" };
  if (!Array.isArray(root.events)) return { ok: false, error: "Scoreboard response had no events list" };
  return { ok: true, value: { events: root.events, root } };
}
function parseSummaryShape(json) {
  const root = obj(json);
  if (!root) return { ok: false, error: "Game summary was not a JSON object" };
  const competitors = arr(at(root, "header", "competitions", 0, "competitors"));
  if (competitors.length < 2) return { ok: false, error: "Game summary had no competitors" };
  return { ok: true, value: root };
}
function normalizeTeam(league, competitor) {
  const c = obj(competitor);
  const t = obj(c?.team);
  const providerId = str(t?.id);
  if (!c || !t || !providerId) return null;
  const abbreviation = str(t.abbreviation) ?? providerId;
  const logos = arr(t.logos).map(obj).filter((l) => l !== null);
  const pick = (want) => {
    const hit = logos.find((l) => {
      const rel = arr(l.rel).map((r) => str(r));
      return rel.includes("full") && rel.includes(want) && !rel.includes("scoreboard");
    });
    return hit ? safeUrl(hit.href) : null;
  };
  const rankRaw = num(at(c, "curatedRank", "current")) ?? num(c.rank);
  const records = [...arr(c.records), ...arr(c.record)].map(obj);
  const total = records.find((r) => str(r?.type) === "total" || str(r?.name) === "overall");
  return {
    key: teamKey(league, providerId),
    league,
    providerId,
    abbreviation,
    displayName: str(t.displayName) ?? str(t.name) ?? abbreviation,
    shortName: str(t.shortDisplayName) ?? str(t.name) ?? abbreviation,
    location: str(t.location),
    color: hexColor(t.color),
    alternateColor: hexColor(t.alternateColor),
    logo: safeUrl(t.logo) ?? pick("default"),
    logoDark: pick("dark"),
    rank: rankRaw !== null && rankRaw >= 1 && rankRaw <= 25 ? rankRaw : null,
    record: str(total?.summary) ?? str(total?.displayValue),
    conferenceId: str(t.conferenceId) ?? str(at(t, "groups", "id"))
  };
}
var STATUS_CODES = {
  STATUS_SCHEDULED: "scheduled",
  STATUS_TBD: "scheduled",
  STATUS_IN_PROGRESS: "in_progress",
  STATUS_FIRST_HALF: "in_progress",
  STATUS_SECOND_HALF: "in_progress",
  STATUS_OVERTIME: "in_progress",
  STATUS_HALFTIME: "halftime",
  STATUS_END_PERIOD: "end_of_period",
  STATUS_DELAYED: "delayed",
  STATUS_RAIN_DELAY: "delayed",
  STATUS_WEATHER_DELAY: "delayed",
  STATUS_SUSPENDED: "suspended",
  STATUS_FINAL: "final",
  STATUS_FINAL_OVERTIME: "final",
  STATUS_FORFEIT: "final",
  STATUS_POSTPONED: "postponed",
  STATUS_CANCELED: "canceled",
  STATUS_CANCELLED: "canceled",
  STATUS_ABANDONED: "canceled"
};
function normalizeStatus(raw, regulationPeriods = 4) {
  const s = obj(raw);
  const t = obj(s?.type);
  const code2 = str(t?.name);
  let kind = code2 && STATUS_CODES[code2] ? STATUS_CODES[code2] : "unknown";
  if (kind === "unknown") {
    const state = str(t?.state);
    if (state === "pre") kind = "scheduled";
    else if (state === "post" && bool(t?.completed) === true) kind = "final";
  }
  const period = num(s?.period);
  const detail = str(t?.shortDetail) ?? str(t?.detail) ?? str(t?.description);
  const clockRelevant = kind === "in_progress" || kind === "delayed" || kind === "suspended";
  let clock = clockRelevant ? str(s?.displayClock) : null;
  if (clock !== null && period !== null && period > regulationPeriods && clockToSeconds(clock) === 0 && detail !== null && !detail.includes(":")) clock = null;
  return {
    kind,
    period: kind === "scheduled" || period === null || period < 1 ? null : period,
    regulationPeriods,
    clock,
    clockSeconds: clockToSeconds(clock),
    detail,
    providerCode: code2
  };
}
function scoreValue(competitor, kind) {
  if (!competitor || kind === "scheduled" || kind === "postponed" || kind === "canceled") return null;
  const direct = num(competitor.score);
  if (direct !== null) return direct;
  return num(at(competitor, "score", "value"));
}
function mediumOf(typeName) {
  const t = (typeName ?? "").toLowerCase();
  if (t === "tv") return "tv";
  if (t === "streaming" || t === "web") return "streaming";
  if (t === "radio") return "radio";
  return "unknown";
}
function normalizeBroadcasts(comp) {
  const out = /* @__PURE__ */ new Map();
  const put = (b) => {
    const k = b.name.toLowerCase();
    const existing = out.get(k);
    if (!existing || existing.medium === "unknown" && b.medium !== "unknown") out.set(k, b);
  };
  for (const g of arr(comp.geoBroadcasts)) {
    const o = obj(g);
    const name = str(at(o, "media", "shortName"));
    if (!o || !name) continue;
    const market = str(at(o, "market", "type"));
    put({ name, medium: mediumOf(str(at(o, "type", "shortName"))), national: market ? market === "National" : null });
  }
  for (const b of arr(comp.broadcasts)) {
    const o = obj(b);
    if (!o) continue;
    const media = str(at(o, "media", "shortName"));
    if (media) {
      const market = str(at(o, "market", "type"));
      put({ name: media, medium: mediumOf(str(at(o, "type", "shortName"))), national: bool(o.isNational) ?? (market ? market === "National" : null) });
    }
    for (const n of arr(o.names)) {
      const name = str(n);
      if (name) put({ name, medium: "unknown", national: str(o.market) === "national" ? true : null });
    }
  }
  return [...out.values()];
}
function gamePageLink(links) {
  for (const l of arr(links)) {
    const o = obj(l);
    const rel = arr(o?.rel).map((r) => str(r));
    if (rel.includes("summary") && rel.includes("desktop")) return safeUrl(o?.href);
  }
  return null;
}
var sideOf = (ctx, teamId) => teamId === null ? null : teamId === ctx.home.providerId ? "home" : teamId === ctx.away.providerId ? "away" : null;
function schematicYardFromLabel(label, home, away) {
  if (!label) return null;
  const text2 = label.trim().toUpperCase();
  if (/^(?:MID(?:FIELD)?\s*)?50$/.test(text2)) return 50;
  const m = /^([A-Z0-9&.'-]{1,8})\s+(\d{1,2})$/.exec(text2);
  if (!m) return null;
  const yard = Number(m[2]);
  if (yard > 50) return null;
  if (yard === 50) return 50;
  if (m[1] === home.toUpperCase()) return 100 - yard;
  if (m[1] === away.toUpperCase()) return yard;
  return null;
}
function labelForSchematic(yard, ctx) {
  const y = Math.round(yard);
  if (y === 50) return "50";
  return y < 50 ? `${ctx.away.abbreviation} ${y}` : `${ctx.home.abbreviation} ${100 - y}`;
}
function resolveSpot(raw, ctx, opts) {
  const bothZero = raw.yardLine === 0 && raw.yardsToEndzone === 0;
  const zeroIsReal = bothZero && opts.scoring === true && raw.team === "away";
  const usable = (v) => v !== null && v >= 0 && v <= 100 && (!bothZero || zeroIsReal);
  const fromLabel = schematicYardFromLabel(raw.label, ctx.home.abbreviation, ctx.away.abbreviation);
  const fromYardLine = usable(raw.yardLine) ? 100 - raw.yardLine : null;
  let schematic = null;
  let provenance = "unknown";
  if (fromLabel !== null) {
    schematic = fromLabel;
    provenance = "label";
    if (fromYardLine !== null && Math.abs(fromYardLine - fromLabel) >= 0.5 && opts.diagnostics) opts.diagnostics.spotSignalConflicts++;
  } else if (fromYardLine !== null) {
    schematic = fromYardLine;
    provenance = "home-yardline";
  } else if (raw.team && usable(raw.yardsToEndzone)) {
    const yte = raw.yardsToEndzone;
    schematic = raw.team === "away" ? 100 - yte : yte;
    provenance = "yards-to-endzone";
  }
  if (schematic === null) {
    return { ...UNKNOWN_SPOT, label: raw.label, offense: raw.team, phase: opts.phase, sourceTime: opts.sourceTime };
  }
  const progress = raw.team ? progressFromSchematicYard(schematic, raw.team) : null;
  const label = raw.label ?? (raw.team && progress !== null ? labelFromProgress(progress, raw.team, { home: ctx.home, away: ctx.away }) : labelForSchematic(schematic, ctx));
  return { label, offense: raw.team, progress, schematicYard: schematic, phase: opts.phase, provenance, lateral: null, sourceTime: opts.sourceTime };
}
var validDown = (d) => d !== null && Number.isInteger(d) && d >= 1 && d <= 4 ? d : null;
var validDistance = (d, down) => down !== null && d !== null && d > 0 && d <= 99 ? d : null;
var goalFromText = (...texts) => {
  const joined = texts.filter(Boolean).join(" ");
  if (!joined) return null;
  return /&\s*goal/i.test(joined);
};
function normalizeSituation(raw, ctx, diagnostics) {
  const s = obj(raw);
  if (!s) return null;
  const possession = sideOf(ctx, str(s.possession) ?? str(at(s, "possession", "id")));
  const down = validDown(num(s.down));
  const ddText = str(s.downDistanceText);
  const shortText = str(s.shortDownDistanceText);
  const spot = resolveSpot(
    { label: str(s.possessionText), yardLine: num(s.yardLine), yardsToEndzone: num(s.yardsToEndzone), team: possession },
    ctx,
    { phase: "pre-snap", sourceTime: null, diagnostics }
  );
  const lp = obj(s.lastPlay);
  const lastPlay = lp ? {
    id: str(lp.id) ? `${ctx.gameId}:${str(lp.id)}` : null,
    kind: classifyPlayType(str(at(lp, "type", "text"))),
    description: str(lp.text) ?? "",
    yards: num(lp.statYardage),
    team: sideOf(ctx, str(at(lp, "team", "id")))
  } : null;
  const explicitRedZone = bool(s.isRedZone);
  return {
    possession,
    down,
    distance: validDistance(num(s.distance), down),
    goalToGo: down === null ? null : goalFromText(ddText, shortText),
    downDistanceText: ddText,
    spot,
    isRedZone: explicitRedZone ?? (spot.progress !== null ? spot.progress >= 80 : null),
    timeouts: { home: num(s.homeTimeouts), away: num(s.awayTimeouts) },
    lastPlay
  };
}
function normalizeScoreboardEvent(raw, league, divisions, diagnostics = newDiagnostics()) {
  const e = obj(raw);
  const comp = obj(at(e, "competitions", 0));
  const providerEventId = str(e?.id);
  if (!e || !comp || !providerEventId) {
    diagnostics.invalidEvents++;
    return null;
  }
  const competitors = arr(comp.competitors).map(obj);
  const homeRaw = competitors.find((c) => str(c?.homeAway) === "home") ?? null;
  const awayRaw = competitors.find((c) => str(c?.homeAway) === "away") ?? null;
  const home = normalizeTeam(league, homeRaw);
  const away = normalizeTeam(league, awayRaw);
  if (!home || !away) {
    diagnostics.invalidEvents++;
    return null;
  }
  const id = gameId(league, providerEventId);
  const ctx = { league, gameId: id, home, away };
  const regulation = num(at(comp, "format", "regulation", "periods")) ?? 4;
  const status = normalizeStatus(comp.status ?? e.status, regulation);
  const pbp = bool(comp.playByPlayAvailable);
  const situation = isLiveOrPaused(status.kind) ? normalizeSituation(comp.situation, ctx, diagnostics) : null;
  const venue = obj(comp.venue);
  const coverage = {
    // Before kickoff the feed marks play-by-play unavailable even for fully covered games, so that is not a coverage level yet.
    level: pbp === true ? "full" : pbp === false && status.kind !== "scheduled" ? "score-only" : "unknown",
    score: true,
    situation: situation !== null,
    playByPlay: pbp === true,
    drives: pbp === true,
    teamStats: pbp === true,
    provider: PROVIDER_NAME
  };
  const lines = normalizeLines(comp.odds, home.providerId, away.providerId);
  const winProbability = isLiveOrPaused(status.kind) ? lastPlayWinProbability(at(comp, "situation", "lastPlay"), id) : null;
  return {
    id,
    league,
    providerEventId,
    divisions,
    startTime: str(comp.date) ?? str(e.date),
    name: str(e.name) ?? `${away.displayName} at ${home.displayName}`,
    shortName: str(e.shortName) ?? `${away.abbreviation} @ ${home.abbreviation}`,
    home,
    away,
    score: { home: scoreValue(homeRaw, status.kind), away: scoreValue(awayRaw, status.kind) },
    status,
    situation,
    broadcasts: normalizeBroadcasts(comp),
    venue: venue ? { id: str(venue.id), name: str(venue.fullName), city: str(at(venue, "address", "city")), state: str(at(venue, "address", "state")), indoor: bool(venue.indoor), grass: bool(venue.grass) } : null,
    // The weather at the venue, as reported. A roofed venue has none, which is the roof saying so.
    weather: normalizeWeather(e.weather),
    neutralSite: bool(comp.neutralSite),
    conferenceGame: bool(comp.conferenceCompetition),
    links: { gamePage: gamePageLink(e.links) },
    season: { year: num(at(e, "season", "year")), type: num(at(e, "season", "type")), week: num(at(e, "week", "number")) },
    notes: arr(comp.notes).map((n) => str(obj(n)?.headline)).filter((n) => !!n),
    coverage,
    ...lines ? { lines } : {},
    ...winProbability ? { winProbability } : {}
  };
}
function normalizePlayState(raw, ctx, team, opts) {
  const s = obj(raw);
  if (!s) return null;
  const down = validDown(num(s.down));
  const ddText = str(s.downDistanceText);
  return {
    down,
    distance: validDistance(num(s.distance), down),
    goalToGo: down === null ? null : goalFromText(ddText, str(s.shortDownDistanceText)),
    downDistanceText: ddText,
    spot: resolveSpot(
      { label: str(s.possessionText), yardLine: num(s.yardLine), yardsToEndzone: num(s.yardsToEndzone), team },
      ctx,
      opts
    )
  };
}
function normalizePlay(raw, ctx, driveId, diagnostics) {
  const p = obj(raw);
  const providerId = str(p?.id);
  if (!p || !providerId) return null;
  const typeText = str(at(p, "type", "text"));
  const kind = classifyPlayType(typeText);
  const stoppage = ADMIN_KINDS.has(kind);
  const startTeam = sideOf(ctx, str(at(p, "start", "team", "id")));
  const endTeam = sideOf(ctx, str(at(p, "end", "team", "id")));
  if (stoppage && (startTeam || endTeam)) diagnostics.ignoredStoppageTeams++;
  const scoring = bool(p.scoringPlay);
  const wallclock = str(p.wallclock);
  const text2 = str(p.text);
  const awayScore = num(p.awayScore);
  const homeScore = num(p.homeScore);
  const period = num(at(p, "period", "number"));
  const clock = str(at(p, "clock", "displayValue"));
  const yards = num(p.statYardage);
  const turnover = bool(p.isTurnover);
  const penalty = bool(p.isPenalty);
  const offense = stoppage ? null : startTeam;
  const start = normalizePlayState(p.start, ctx, offense, { phase: "pre-snap", sourceTime: wallclock, scoring: false, diagnostics });
  const end = normalizePlayState(p.end, ctx, stoppage ? null : endTeam, {
    phase: "post-play",
    sourceTime: wallclock,
    scoring: scoring === true,
    diagnostics
  });
  const revision = fingerprint(
    JSON.stringify([
      typeText,
      text2,
      awayScore,
      homeScore,
      scoring,
      turnover,
      penalty,
      yards,
      period,
      clock,
      at(p, "start", "yardLine"),
      at(p, "start", "down"),
      at(p, "start", "distance"),
      str(at(p, "start", "team", "id")),
      at(p, "end", "yardLine"),
      at(p, "end", "down"),
      at(p, "end", "distance"),
      str(at(p, "end", "team", "id"))
    ])
  );
  return {
    id: `${ctx.gameId}:${providerId}`,
    providerId,
    gameId: ctx.gameId,
    driveId,
    sequence: num(p.sequenceNumber),
    order: 0,
    period,
    clock,
    description: text2 ?? typeText ?? "Play",
    providerType: { id: str(at(p, "type", "id")), text: typeText },
    kind,
    offense,
    start,
    end,
    yards,
    scoring,
    scoringTeam: null,
    turnover,
    penalty,
    possessionChanged: !stoppage && startTeam && endTeam ? startTeam !== endTeam : null,
    conversion: TOUCHDOWN_KINDS.has(kind) || kind === "extra_point" || kind === "two_point" ? parseConversion(text2) : null,
    review: parseReview(text2),
    scoreAfter: { home: homeScore, away: awayScore },
    modified: str(p.modified),
    wallclock,
    revision
  };
}
function normalizeDriveEdge(raw, ctx, offense) {
  const o = obj(raw);
  if (!o) return null;
  const label = str(o.text);
  return {
    period: num(at(o, "period", "number")),
    clock: str(at(o, "clock", "displayValue")),
    label,
    spot: resolveSpot({ label, yardLine: num(o.yardLine), yardsToEndzone: null, team: offense }, ctx, { phase: "pre-snap", sourceTime: null })
  };
}
function normalizeDrive(raw, ctx, isCurrent) {
  const d = obj(raw);
  const providerId = str(d?.id);
  if (!d || !providerId) return null;
  const offense = sideOf(ctx, str(at(d, "team", "id")));
  return {
    id: `${ctx.gameId}:drive:${providerId}`,
    providerId,
    gameId: ctx.gameId,
    offense,
    description: str(d.description),
    start: normalizeDriveEdge(d.start, ctx, offense),
    end: normalizeDriveEdge(d.end, ctx, offense),
    playIds: [],
    offensivePlays: num(d.offensivePlays),
    yards: num(d.yards),
    timeElapsed: str(at(d, "timeElapsed", "displayValue")),
    result: str(d.displayResult) ?? str(d.result),
    isScore: bool(d.isScore),
    isCurrent
  };
}
var MISPLACED_MS = 5 * 6e4;
function orderPlays(plays, diagnostics) {
  const time2 = (p) => {
    const t = p.wallclock ? Date.parse(p.wallclock) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const out = [];
  let latest = null;
  for (const p of plays) {
    const t = time2(p);
    if (t !== null && latest !== null && t < latest - MISPLACED_MS) {
      let at2 = out.length;
      while (at2 > 0) {
        const prev = out[at2 - 1];
        const pt = time2(prev);
        const prevPeriod = prev.period ?? 0;
        const period = p.period ?? prevPeriod;
        if (prevPeriod < period || prevPeriod === period && pt !== null && pt <= t) break;
        at2--;
      }
      out.splice(at2, 0, p);
      if (diagnostics) diagnostics.reorderedPlays++;
    } else {
      out.push(p);
    }
    if (t !== null) latest = latest === null ? t : Math.max(latest, t);
  }
  return out.map((p, i) => ({ ...p, order: i }));
}
var NO_CONTINUITY = /* @__PURE__ */ new Set([
  "touchdown_rush",
  "touchdown_pass",
  "touchdown_return",
  "field_goal_good",
  "field_goal_missed",
  "field_goal_blocked",
  "safety",
  "punt",
  "punt_return",
  "punt_blocked",
  "kickoff",
  "kickoff_return",
  "penalty",
  "interception",
  "fumble_lost",
  "fumble",
  "extra_point",
  "two_point",
  "other"
]);
function findGaps(plays) {
  const gaps = [];
  const snaps = plays.filter((p) => !ADMIN_KINDS.has(p.kind));
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const next = snaps[i];
    if (prev.period !== next.period) continue;
    if (NO_CONTINUITY.has(prev.kind) || NO_CONTINUITY.has(next.kind) || prev.penalty || next.penalty || prev.turnover) continue;
    const a = prev.end?.spot.schematicYard ?? null;
    const b = next.start?.spot.schematicYard ?? null;
    if (a === null || b === null) continue;
    if (Math.abs(a - b) >= 1) {
      gaps.push({ afterPlayId: prev.id, beforePlayId: next.id, reason: "The reported spots do not connect here; a play may be missing from the feed." });
    }
  }
  return gaps;
}
var STAT_ROWS = [
  ["totalYards", "Total yards"],
  ["netPassingYards", "Passing yards"],
  ["rushingYards", "Rushing yards"],
  ["firstDowns", "First downs"],
  ["thirdDownEff", "Third downs"],
  ["fourthDownEff", "Fourth downs"],
  ["turnovers", "Turnovers"],
  ["fumblesLost", "Fumbles lost"],
  ["interceptions", "Interceptions thrown"],
  ["completionAttempts", "Completions / attempts"],
  ["sacksYardsLost", "Sacks / yards lost"],
  ["redZoneAttempts", "Red zone scores / trips"],
  ["totalPenaltiesYards", "Penalties / yards"],
  ["possessionTime", "Time of possession"],
  ["yardsPerPlay", "Yards per play"]
];
function normalizeStats(root, ctx) {
  const bySide = { home: /* @__PURE__ */ new Map(), away: /* @__PURE__ */ new Map() };
  for (const t of arr(at(root, "boxscore", "teams"))) {
    const o = obj(t);
    const side = sideOf(ctx, str(at(o, "team", "id")));
    if (!o || !side) continue;
    for (const s of arr(o.statistics)) {
      const so = obj(s);
      const name = str(so?.name);
      const value = str(so?.displayValue);
      if (name && value !== null && !bySide[side].has(name)) bySide[side].set(name, value);
    }
  }
  return STAT_ROWS.filter(([key]) => bySide.home.has(key) || bySide.away.has(key)).map(([key, label]) => ({
    key,
    label,
    home: bySide.home.get(key) ?? null,
    away: bySide.away.get(key) ?? null
  }));
}
function scoreKind(typeText) {
  const t = typeText ?? "";
  if (/touchdown/i.test(t)) return "touchdown";
  if (/field goal good/i.test(t)) return "field_goal";
  if (/safety/i.test(t)) return "safety";
  if (/two.?point|extra point|conversion|\bpat\b/i.test(t)) return "conversion";
  return "unknown";
}
function normalizeSummary(json, league, divisions = league === "nfl" ? ["NFL"] : [], diagnostics = newDiagnostics()) {
  const parsed = parseSummaryShape(json);
  if (!parsed.ok) return null;
  const root = parsed.value;
  const header = obj(root.header);
  const comp = obj(at(header, "competitions", 0));
  const providerEventId = str(header?.id) ?? str(comp?.id);
  if (!header || !comp || !providerEventId) return null;
  const competitors = arr(comp.competitors).map(obj);
  const homeRaw = competitors.find((c) => str(c?.homeAway) === "home") ?? null;
  const awayRaw = competitors.find((c) => str(c?.homeAway) === "away") ?? null;
  const home = normalizeTeam(league, homeRaw);
  const away = normalizeTeam(league, awayRaw);
  if (!home || !away) return null;
  const id = gameId(league, providerEventId);
  const ctx = { league, gameId: id, home, away };
  const regulation = num(at(root, "format", "regulation", "periods")) ?? 4;
  const status = normalizeStatus(comp.status, regulation);
  const drives = /* @__PURE__ */ new Map();
  const entries = [];
  const rawDrives = arr(at(root, "drives", "previous")).map((raw) => ({ raw, current: false }));
  if (obj(at(root, "drives", "current"))) rawDrives.push({ raw: at(root, "drives", "current"), current: true });
  for (const { raw, current: current2 } of rawDrives) {
    const drive = normalizeDrive(raw, ctx, current2);
    if (!drive) continue;
    const existing = drives.get(drive.id);
    if (existing) {
      if (current2) Object.assign(existing, { ...drive, playIds: existing.playIds, isCurrent: true });
    } else {
      drives.set(drive.id, drive);
    }
    for (const rp of arr(obj(raw)?.plays)) {
      const play = normalizePlay(rp, ctx, drive.id, diagnostics);
      if (play) entries.push(play);
    }
  }
  const seen = /* @__PURE__ */ new Map();
  const deduped = [];
  for (const p of entries) {
    const at0 = seen.get(p.id);
    if (at0 === void 0) {
      seen.set(p.id, deduped.length);
      deduped.push(p);
      continue;
    }
    diagnostics.duplicatePlays++;
    const prev = deduped[at0];
    const newer = (p.modified ?? "") >= (prev.modified ?? "");
    if (newer) deduped[at0] = { ...p, driveId: p.driveId ?? prev.driveId };
  }
  const plays = orderPlays(deduped, diagnostics);
  const scoring = arr(root.scoringPlays).map(obj).filter((sp) => sp !== null).map((sp) => {
    const pid = str(sp.id);
    return {
      id: `${id}:score:${pid ?? fingerprint(JSON.stringify(sp))}`,
      gameId: id,
      playId: pid ? `${id}:${pid}` : null,
      period: num(at(sp, "period", "number")),
      clock: str(at(sp, "clock", "displayValue")),
      team: sideOf(ctx, str(at(sp, "team", "id"))),
      kind: scoreKind(str(at(sp, "type", "text"))),
      description: str(sp.text) ?? str(at(sp, "type", "text")) ?? "Score",
      scoreAfter: { home: num(sp.homeScore), away: num(sp.awayScore) }
    };
  });
  const scoringTeamByPlay = new Map(scoring.filter((s) => s.playId && s.team).map((s) => [s.playId, s.team]));
  let before = { home: 0, away: 0 };
  const playsWithTeams = plays.map((original) => {
    const zeroed = ADMIN_KINDS.has(original.kind) && original.scoreAfter.home === 0 && original.scoreAfter.away === 0 && ((before.home ?? 0) > 0 || (before.away ?? 0) > 0);
    const p = zeroed ? { ...original, scoreAfter: { ...before } } : original;
    let scoringTeam = scoringTeamByPlay.get(p.id) ?? null;
    if (!scoringTeam && p.scoring) {
      const dh = p.scoreAfter.home !== null && before.home !== null ? p.scoreAfter.home - before.home : 0;
      const da = p.scoreAfter.away !== null && before.away !== null ? p.scoreAfter.away - before.away : 0;
      if (dh > 0 && da <= 0) scoringTeam = "home";
      else if (da > 0 && dh <= 0) scoringTeam = "away";
    }
    if (p.scoreAfter.home !== null && p.scoreAfter.away !== null) before = p.scoreAfter;
    return scoringTeam ? { ...p, scoringTeam } : p;
  });
  for (const d of drives.values()) d.playIds = [];
  for (const p of playsWithTeams) if (p.driveId) drives.get(p.driveId)?.playIds.push(p.id);
  const driveList = [...drives.values()];
  const current = driveList.find((d) => d.isCurrent) ?? null;
  const pbpSource = str(comp.playByPlaySource);
  const boxSource = str(comp.boxscoreSource);
  const venue = obj(at(root, "gameInfo", "venue"));
  const situation = normalizeSituation(comp.situation, ctx, diagnostics);
  const possessionFlag = competitors.find((c) => bool(c?.possession) === true);
  const summary = {
    id,
    league,
    providerEventId,
    divisions,
    startTime: str(comp.date),
    name: `${away.displayName} at ${home.displayName}`,
    shortName: `${away.abbreviation} @ ${home.abbreviation}`,
    home,
    away,
    score: { home: scoreValue(homeRaw, status.kind), away: scoreValue(awayRaw, status.kind) },
    status,
    situation: situation ?? (isLiveOrPaused(status.kind) && possessionFlag ? {
      possession: str(possessionFlag.homeAway) === "home" ? "home" : "away",
      down: null,
      distance: null,
      goalToGo: null,
      downDistanceText: null,
      spot: UNKNOWN_SPOT,
      isRedZone: null,
      timeouts: { home: null, away: null },
      lastPlay: null
    } : null),
    broadcasts: normalizeBroadcasts(comp),
    venue: venue ? { id: str(venue.id), name: str(venue.fullName), city: str(at(venue, "address", "city")), state: str(at(venue, "address", "state")), indoor: bool(venue.indoor), grass: bool(venue.grass) } : null,
    weather: normalizeWeather(at(root, "header", "weather") ?? root.weather),
    neutralSite: bool(comp.neutralSite),
    conferenceGame: bool(comp.conferenceCompetition),
    links: { gamePage: gamePageLink(header.links) },
    season: { year: num(at(header, "season", "year")), type: num(at(header, "season", "type")), week: num(header.week) },
    notes: [],
    coverage: {
      // Before kickoff the summary marks play-by-play as unavailable even for fully covered games, so that is not a coverage level yet.
      level: pbpSource === "full" ? "full" : pbpSource === "none" && status.kind !== "scheduled" ? "score-only" : "unknown",
      score: true,
      situation: situation !== null,
      playByPlay: playsWithTeams.length > 0,
      drives: driveList.length > 0,
      teamStats: boxSource === "full",
      provider: PROVIDER_NAME
    }
  };
  const leaders = normalizeLeaders(root.leaders, ctx);
  const attendance = num(at(root, "gameInfo", "attendance"));
  const gaps = findGaps(playsWithTeams);
  if (pbpSource === "full" && playsWithTeams.length === 0 && status.kind !== "scheduled") {
    gaps.push({ afterPlayId: null, beforePlayId: null, reason: "The provider lists full play-by-play for this game but returned no plays yet." });
  }
  const lines = normalizeLines(root.pickcenter, home.providerId, away.providerId);
  const winProbability = normalizeWinProbability(root.winprobability, id);
  const latest = status.kind === "scheduled" ? null : latestWinProbability(winProbability);
  const predictor = normalizePredictor(root.predictor, home.providerId, away.providerId);
  const reported2 = { ...summary, ...lines ? { lines } : {}, ...latest ? { winProbability: latest } : {}, ...predictor ? { predictor } : {} };
  return {
    gameId: id,
    summary: reported2,
    drives: driveList,
    plays: playsWithTeams,
    scoring,
    stats: normalizeStats(root, ctx),
    leaders,
    attendance: attendance !== null && attendance > 0 ? Math.round(attendance) : null,
    currentDriveId: current?.id ?? null,
    gaps,
    ...winProbability.length ? { winProbability } : {}
  };
}
var LEADER_CATEGORY = { passingYards: "passing", rushingYards: "rushing", receivingYards: "receiving" };
var LEADER_ORDER = ["passing", "rushing", "receiving"];
var PROVIDER_IMAGE = /^https:\/\/a\.espncdn\.com\//;
function normalizeLeaders(raw, ctx) {
  const out = [];
  for (const entry of arr(raw)) {
    const e = obj(entry);
    const teamId = str(at(e, "team", "id"));
    const side = teamId && teamId === ctx.home.providerId ? "home" : teamId && teamId === ctx.away.providerId ? "away" : null;
    if (!e || !side || out.some((t) => t.side === side)) continue;
    const leaders = [];
    for (const item of arr(e.leaders)) {
      const c = obj(item);
      const category = LEADER_CATEGORY[str(c?.name) ?? ""];
      if (!c || !category || leaders.some((l) => l.category === category)) continue;
      const top = obj(arr(c.leaders)[0]);
      const athlete = obj(top?.athlete);
      const name = str(athlete?.displayName) ?? str(athlete?.shortName);
      const line = str(top?.displayValue);
      if (!name || !line) continue;
      const headshot = str(at(athlete, "headshot", "href"));
      leaders.push({
        category,
        label: str(c.displayName) ?? category,
        athlete: {
          name,
          shortName: str(athlete?.shortName),
          position: str(at(athlete, "position", "abbreviation")),
          jersey: str(athlete?.jersey),
          headshot: headshot && PROVIDER_IMAGE.test(headshot) ? headshot : null
        },
        line
      });
    }
    leaders.sort((a, b) => LEADER_ORDER.indexOf(a.category) - LEADER_ORDER.indexOf(b.category));
    if (leaders.length) out.push({ side, leaders });
  }
  return out.sort((a, b) => a.side === b.side ? 0 : a.side === "away" ? -1 : 1);
}

// server/providers/espn/provider.ts
var DISCOVERY_TTL_MS = 12 * 60 * 6e4;
var SEASON_TTL_MS = 6 * 60 * 6e4;
var CONFERENCE_TTL_MS = 24 * 60 * 6e4;
var EspnProvider = class {
  constructor(fetcher2, options = {}) {
    this.fetcher = fetcher2;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.loadCoverageCache();
  }
  fetcher;
  options;
  info = {
    id: "espn",
    name: "ESPN",
    description: "ESPN public site API. Undocumented and unlicensed: no guarantee of availability, latency or completeness. Polled, not pushed.",
    licensed: false,
    push: false,
    divisions: ["NFL", "FBS", "FCS", "D2", "D3"]
  };
  diagnostics = newDiagnostics();
  coverage = /* @__PURE__ */ new Map();
  conferences = /* @__PURE__ */ new Map();
  seasons = /* @__PURE__ */ new Map();
  /** A venue's roof and surface, asked for once per venue and kept for the life of the process. */
  venues = /* @__PURE__ */ new Map();
  venuesInFlight = /* @__PURE__ */ new Set();
  now;
  // ------------------------------------------------------------ slate
  async fetchSlate(league, dateKey, options) {
    return league === "nfl" ? this.fetchNflSlate(dateKey) : this.fetchCollegeSlate(dateKey, options.divisions);
  }
  async fetchNflSlate(dateKey) {
    const url = scoreboardUrl("nfl", dateKey);
    const res = await this.fetcher.getJson(url);
    const base = { league: "nfl", dateKey, receivedAt: res.receivedAt, discovery: "NFL scoreboard for the day", limitations: [] };
    if (!res.ok) {
      return { ...base, games: [], divisions: [{ division: "NFL", label: "NFL", providerGroupId: null, games: 0, health: "unavailable" }], errors: [{ scope: "NFL scoreboard", message: res.error, status: res.status }], failed: true };
    }
    const parsed = parseScoreboard(res.data);
    if (!parsed.ok) {
      return { ...base, games: [], divisions: [{ division: "NFL", label: "NFL", providerGroupId: null, games: 0, health: "unavailable" }], errors: [{ scope: "NFL scoreboard", message: parsed.error, status: res.status }], failed: true };
    }
    const games = parsed.value.events.map((e) => normalizeScoreboardEvent(e, "nfl", ["NFL"], this.diagnostics)).filter((g) => g !== null);
    if (parsed.value.events.length >= RESULT_LIMIT) base.limitations.push(`The NFL scoreboard returned ${RESULT_LIMIT} games, its request limit; some games may be missing.`);
    return { ...base, games, divisions: [{ division: "NFL", label: "NFL", providerGroupId: null, games: games.length, health: "connected" }], errors: [], failed: false };
  }
  async seasonFor(dateKey) {
    const cached = this.seasons.get(dateKey);
    if (cached && this.now() - cached.at < SEASON_TTL_MS) return cached.value;
    const res = await this.fetcher.getJson(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${dateKey}`);
    if (!res.ok) return cached?.value ?? null;
    let value = seasonForDate(res.data, dateKey);
    if (!value) {
      const year = num(at(res.data, "season", "year"));
      const type = num(at(res.data, "season", "type"));
      value = year !== null && type !== null ? { season: year, seasonType: type } : null;
    }
    this.seasons.set(dateKey, { value, at: this.now() });
    return value;
  }
  async divisionsFor(dateKey) {
    const season = await this.seasonFor(dateKey);
    if (!season) {
      const any = [...this.coverage.values()].sort((a, b) => b.discoveredAt - a.discoveredAt)[0] ?? null;
      return { coverage: any, note: any ? "Season could not be read; using the most recent division list." : "College season could not be read from the provider." };
    }
    const key = `${season.season}-${season.seasonType}`;
    const cached = this.coverage.get(key);
    if (cached && this.now() - cached.discoveredAt < DISCOVERY_TTL_MS) return { coverage: cached, note: null };
    try {
      const fresh = await discoverCollegeDivisions(this.fetcher, season.season, season.seasonType, this.now);
      this.coverage.set(key, fresh);
      this.saveCoverageCache();
      return { coverage: fresh, note: null };
    } catch (e) {
      if (cached) return { coverage: cached, note: `Division discovery failed (${e.message}); using the list discovered earlier.` };
      const any = [...this.coverage.values()].sort((a, b) => b.discoveredAt - a.discoveredAt)[0] ?? null;
      return { coverage: any, note: any ? `Division discovery failed (${e.message}); using the most recent division list.` : `Division discovery failed: ${e.message}` };
    }
  }
  async fetchCollegeSlate(dateKey, wanted) {
    const receivedAt = this.now();
    const { coverage, note } = await this.divisionsFor(dateKey);
    const limitations = [];
    if (note) limitations.push(note);
    if (!coverage) {
      return {
        league: "cfb",
        dateKey,
        games: [],
        divisions: [],
        receivedAt,
        failed: true,
        errors: [{ scope: "College divisions", message: note ?? "College divisions unavailable", status: null }],
        discovery: "College divisions could not be discovered",
        limitations
      };
    }
    const groups = coverage.groups.filter((g) => wanted.includes(g.division));
    const results = await Promise.all(
      groups.map(async (g) => ({ group: g, res: await this.fetcher.getJson(scoreboardUrl("cfb", dateKey, g.groupId)) }))
    );
    const merged = /* @__PURE__ */ new Map();
    const divisions = [];
    const errors = [];
    for (const { group, res } of results) {
      if (!res.ok) {
        errors.push({ scope: `${group.label} scoreboard`, message: res.error, status: res.status });
        divisions.push({ division: group.division, label: group.label, providerGroupId: group.groupId, games: 0, health: "unavailable" });
        continue;
      }
      const parsed = parseScoreboard(res.data);
      if (!parsed.ok) {
        errors.push({ scope: `${group.label} scoreboard`, message: parsed.error, status: res.status });
        divisions.push({ division: group.division, label: group.label, providerGroupId: group.groupId, games: 0, health: "unavailable" });
        continue;
      }
      if (parsed.value.events.length >= RESULT_LIMIT) limitations.push(`${group.label} returned ${RESULT_LIMIT} games, its request limit; some games may be missing.`);
      for (const ev of parsed.value.events) {
        const id = str(obj(ev)?.id);
        if (!id) continue;
        const entry = merged.get(id);
        if (entry) {
          if (!entry.divisions.includes(group.division)) entry.divisions.push(group.division);
        } else merged.set(id, { raw: ev, divisions: [group.division] });
      }
      divisions.push({ division: group.division, label: group.label, providerGroupId: group.groupId, games: parsed.value.events.length, health: "connected" });
    }
    const games = [...merged.values()].map(({ raw, divisions: d }) => normalizeScoreboardEvent(raw, "cfb", d, this.diagnostics)).filter((g) => g !== null);
    const conferenceIds = [...new Set(games.flatMap((g) => [g.home.conferenceId, g.away.conferenceId]).filter((id) => !!id))];
    return {
      league: "cfb",
      dateKey,
      games,
      divisions,
      conferences: await this.conferenceInfo(conferenceIds, coverage),
      errors,
      failed: groups.length > 0 && errors.length === groups.length,
      receivedAt,
      discovery: `Divisions discovered from ESPN's group list for season ${coverage.season}, type ${coverage.seasonType}: ${coverage.groups.map((g) => `${g.label} (group ${g.groupId})`).join(", ")}. Games in more than one division appear once.`,
      limitations
    };
  }
  /**
   * Conference names for the ids seen in a slate, from the provider's group
   * documents (for example group 8 is "Southeastern Conference", short name
   * "SEC"). Unknown ids are looked up once a day; a failed lookup is retried on a
   * later slate and the conference is simply left out of the filter meanwhile.
   */
  async conferenceInfo(ids, coverage) {
    const due = ids.filter((id) => /^\d{1,6}$/.test(id)).filter((id) => {
      const cached = this.conferences.get(id);
      return !cached || this.now() - cached.at > CONFERENCE_TTL_MS;
    }).slice(0, 40);
    await Promise.all(
      due.map(async (id) => {
        const res = await this.fetcher.getJson(`${CORE_BASE}/seasons/${coverage.season}/types/${coverage.seasonType}/groups/${id}`);
        if (!res.ok) {
          if (res.status === 404) this.conferences.set(id, { info: null, at: this.now() });
          return;
        }
        const g = obj(res.data);
        const name = str(g?.name);
        const shortName = str(g?.shortName) ?? str(g?.midsizeName) ?? str(g?.abbreviation)?.toUpperCase() ?? null;
        this.conferences.set(id, { info: name ? { id, name, shortName: shortName ?? name } : null, at: this.now() });
      })
    );
    return ids.map((id) => this.conferences.get(id)?.info ?? null).filter((c) => c !== null).sort((a, b) => a.shortName.localeCompare(b.shortName));
  }
  // ------------------------------------------------------------ detail
  async fetchDetail(id, knownDivisions) {
    const parsedId = parseGameId(id);
    if (!parsedId) return { ok: false, error: { scope: "Game detail", message: `Unknown game id ${id}`, status: null }, receivedAt: this.now() };
    const league = parsedId.league;
    const path = league === "nfl" ? "nfl" : "college-football";
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/${path}/summary?event=${encodeURIComponent(parsedId.providerEventId)}`;
    const oddsUrl = coreOddsUrl(league, parsedId.providerEventId);
    const [res, odds] = await Promise.all([this.fetcher.getJson(url), oddsUrl ? this.fetcher.getJson(oddsUrl) : Promise.resolve(null)]);
    if (!res.ok) return { ok: false, error: { scope: "Game detail", message: res.error, status: res.status }, receivedAt: res.receivedAt };
    const detail = normalizeSummary(res.data, league, knownDivisions ?? (league === "nfl" ? ["NFL"] : []), this.diagnostics);
    if (!detail) return { ok: false, error: { scope: "Game detail", message: "Game summary did not have the expected shape", status: res.status }, receivedAt: res.receivedAt };
    const live = odds?.ok ? normalizeCoreOdds(odds.data, detail.summary.home.providerId, detail.summary.away.providerId) : null;
    const lines = preferLiveLines(detail.summary.lines ?? null, live);
    const summary = { ...detail.summary, lines, venue: this.venueWith(league, detail.summary.venue) };
    return { ok: true, detail: { ...detail, summary }, receivedAt: res.receivedAt };
  }
  /**
   * A venue's roof and playing surface, asked for once and then remembered.
   *
   * A stadium does not change its surface between polls, so this is fetched the
   * first time a game there is followed and never again. It is deliberately not
   * fetched for a whole scoreboard: a college Saturday is sixty venues, and the
   * surface only matters for a field somebody is actually looking at.
   *
   * Nothing waits for it. A detail that had to wait on a second round trip the
   * first time anybody opened a game would hold the whole game page behind a
   * fact about the grass, so the first poll goes out with the surface unknown
   * and the poll twelve seconds later carries it. Unknown is already a state the
   * field draws correctly, which is what makes that safe.
   */
  venueWith(league, venue) {
    if (!venue?.id || !/^\d{1,32}$/.test(venue.id)) return venue;
    const known = this.venues.get(venue.id);
    if (!known) {
      void this.lookUpVenue(league, venue.id);
      return venue;
    }
    if (known.indoor === null && known.grass === null) return venue;
    return { ...venue, indoor: venue.indoor ?? known.indoor, grass: venue.grass ?? known.grass };
  }
  /** Reads a venue once, in the background, and remembers the answer even when it is nothing. */
  async lookUpVenue(league, id) {
    if (this.venuesInFlight.has(id)) return;
    this.venuesInFlight.add(id);
    try {
      const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/${league === "nfl" ? "nfl" : "college-football"}/venues/${id}`;
      const res = await this.fetcher.getJson(url);
      const doc = res.ok ? obj(res.data) : null;
      this.venues.set(id, { indoor: doc ? bool(doc.indoor) : null, grass: doc ? bool(doc.grass) : null });
    } catch {
      this.venues.set(id, { indoor: null, grass: null });
    } finally {
      this.venuesInFlight.delete(id);
    }
  }
  // ------------------------------------------------------------ cache
  loadCoverageCache() {
    const file = this.options.coverageCacheFile;
    if (!file || !existsSync3(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const item of arr(data)) {
        const c = obj(item);
        const season = num(c?.season);
        const seasonType = num(c?.seasonType);
        const groups = arr(c?.groups).map(obj).filter((g) => !!g && !!str(g.groupId) && !!str(g.division));
        if (season === null || seasonType === null || !groups.length) continue;
        this.coverage.set(`${season}-${seasonType}`, {
          season,
          seasonType,
          discoveredAt: num(c?.discoveredAt) ?? 0,
          source: str(c?.source) ?? "cache",
          groups: groups.map((g) => ({
            division: str(g.division),
            label: str(g.label) ?? String(g.division),
            groupId: str(g.groupId),
            parentId: str(g.parentId),
            parentName: str(g.parentName)
          }))
        });
      }
    } catch {
    }
  }
  saveCoverageCache() {
    const file = this.options.coverageCacheFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify([...this.coverage.values()], null, 2));
    } catch {
    }
  }
};

// server/providers/sportradar/config.ts
import { inspect } from "node:util";
var SPORTRADAR_ENV = {
  nflKey: "SPORTRADAR_NFL_API_KEY",
  ncaafbKey: "SPORTRADAR_NCAAFB_API_KEY",
  accessLevel: "SPORTRADAR_ACCESS_LEVEL",
  push: "SPORTRADAR_PUSH"
};
var TRIAL_LIMITS = { queriesPerSecond: 1, requestsPer30Days: 1e3 };
var REDACTED = "[redacted]";
var ApiKey = class {
  #value;
  constructor(value) {
    this.#value = value;
  }
  /** The raw key, for the x-api-key request header only. */
  reveal() {
    return this.#value;
  }
  equals(other) {
    return this.#value === other.#value;
  }
  toString() {
    return REDACTED;
  }
  toJSON() {
    return REDACTED;
  }
  [inspect.custom]() {
    return `ApiKey(${REDACTED})`;
  }
};
var SportradarConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SportradarConfigError";
  }
};
function readKey(env, name) {
  const raw = env[name];
  if (raw === void 0) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (/[^\x21-\x7e]/.test(value)) {
    throw new SportradarConfigError(`${name} contains spaces, control characters or non-ASCII characters. Check the value; it is not shown here.`);
  }
  return new ApiKey(value);
}
function readAccessLevel(env) {
  const raw = env[SPORTRADAR_ENV.accessLevel]?.trim().toLowerCase();
  if (!raw) return "trial";
  if (raw === "trial" || raw === "production") return raw;
  throw new SportradarConfigError(`${SPORTRADAR_ENV.accessLevel} must be "trial" or "production".`);
}
function readPush(env) {
  const raw = env[SPORTRADAR_ENV.push]?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === "on" || raw === "true" || raw === "1") return true;
  if (raw === "off" || raw === "false" || raw === "0") return false;
  throw new SportradarConfigError(`${SPORTRADAR_ENV.push} must be "on" or "off".`);
}
function loadSportradarConfig(env) {
  const nfl = readKey(env, SPORTRADAR_ENV.nflKey);
  let cfb = readKey(env, SPORTRADAR_ENV.ncaafbKey);
  if (!nfl && !cfb) {
    throw new SportradarConfigError(
      `Sportradar has no API key. Set ${SPORTRADAR_ENV.nflKey} for the NFL, ${SPORTRADAR_ENV.ncaafbKey} for college football, or both.`
    );
  }
  if (nfl && cfb && nfl.equals(cfb)) cfb = nfl;
  const accessLevel = readAccessLevel(env);
  const pushRequested = readPush(env);
  const warnings = [];
  if (pushRequested && accessLevel !== "production") {
    warnings.push(`${SPORTRADAR_ENV.push}=on is ignored: Sportradar push feeds are available on production plans only, and the access level is trial.`);
  }
  return { keys: { nfl, cfb }, accessLevel, push: pushRequested && accessLevel === "production", warnings };
}
function missingKeyMessage(league) {
  return league === "nfl" ? `No Sportradar NFL key is configured. Set ${SPORTRADAR_ENV.nflKey} to read NFL games.` : `No Sportradar NCAA football key is configured. Set ${SPORTRADAR_ENV.ncaafbKey} to read college games.`;
}

// server/providers/sportradar/client.ts
var restBase = (league, level) => league === "nfl" ? `https://api.sportradar.com/nfl/official/${level}/v7/en` : `https://api.sportradar.com/ncaafb/${level}/v7/en`;
var seasonScheduleUrl = (league, level) => `${restBase(league, level)}/games/current_season/schedule.json`;
var boxscoreUrl = (league, level, gameUuid) => `${restBase(league, level)}/games/${encodeURIComponent(gameUuid)}/boxscore.json`;
var playByPlayUrl = (league, level, gameUuid) => `${restBase(league, level)}/games/${encodeURIComponent(gameUuid)}/pbp.json`;
var pushEventsUrl = (league, level) => league === "nfl" ? `https://api.sportradar.com/nfl/official/${level}/stream/en/events/subscribe` : `https://api.sportradar.com/ncaafb/${level}/stream/en/events/subscribe`;
function describeStatus(status) {
  if (status === 429) return "HTTP 429: Sportradar throttled the request, or the plan's request quota is used up";
  if (status === 403) return "HTTP 403: the API key is not authorized for this feed or access level";
  return `HTTP ${status}`;
}
var SportradarClient = class {
  lanes = [];
  fetchImpl;
  now;
  random;
  spacingMs;
  timeoutMs;
  baseBackoffMs;
  maxBackoffMs;
  counters = { started: 0, succeeded: 0, failed: 0, throttled: 0, shared: 0, refusedWhileBackingOff: 0 };
  constructor(options = {}) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    const qps = options.queriesPerSecond !== void 0 && Number.isFinite(options.queriesPerSecond) && options.queriesPerSecond > 0 ? options.queriesPerSecond : 1;
    this.spacingMs = Math.ceil(1e3 / qps);
    this.timeoutMs = options.timeoutMs ?? 1e4;
    this.baseBackoffMs = options.baseBackoffMs ?? 2e3;
    this.maxBackoffMs = options.maxBackoffMs ?? 5 * 6e4;
  }
  /** GET a JSON feed with the key's header, inside the key's rate limit. */
  getJson(url, key) {
    const lane = this.laneFor(key);
    const existing = lane.inflight.get(url);
    if (existing) {
      this.counters.shared++;
      return existing;
    }
    const run = this.run(url, lane).finally(() => lane.inflight.delete(url));
    lane.inflight.set(url, run);
    return run;
  }
  /** Until when requests for this key are refused after a 429, or 0. */
  backoffUntil(key) {
    const lane = this.lanes.find((l) => l.key.equals(key));
    return lane && lane.backoffUntil > this.now() ? lane.backoffUntil : 0;
  }
  stats() {
    return { ...this.counters, backoffUntil: Math.max(0, ...this.lanes.map((l) => l.backoffUntil)) };
  }
  laneFor(key) {
    let lane = this.lanes.find((l) => l.key.equals(key));
    if (!lane) {
      lane = { key, nextStartAt: 0, backoffUntil: 0, consecutiveThrottles: 0, tail: Promise.resolve(), inflight: /* @__PURE__ */ new Map() };
      this.lanes.push(lane);
    }
    return lane;
  }
  /** Wait for this key's next start slot. Resolves false when the key is backing off. */
  reserve(lane) {
    const turn = lane.tail.then(async () => {
      if (this.now() < lane.backoffUntil) return false;
      const wait = lane.nextStartAt - this.now();
      if (wait > 0) await new Promise((resolve4) => setTimeout(resolve4, wait));
      if (this.now() < lane.backoffUntil) return false;
      lane.nextStartAt = this.now() + this.spacingMs;
      return true;
    });
    lane.tail = turn.catch(() => void 0);
    return turn;
  }
  async run(url, lane) {
    const go = await this.reserve(lane);
    if (!go) {
      this.counters.refusedWhileBackingOff++;
      return {
        ok: false,
        error: `Not requested: backing off after HTTP 429 until ${new Date(lane.backoffUntil).toISOString()}`,
        status: null,
        receivedAt: this.now(),
        retryable: true
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
  backoffDelay(consecutive, retryAfterMs) {
    if (retryAfterMs !== null) return Math.min(this.maxBackoffMs, retryAfterMs);
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, consecutive - 1));
    return Math.round(exp * (0.5 + this.random() * 0.5));
  }
  async attempt(url, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { headers: { "x-api-key": key.reveal() }, signal: controller.signal });
      const receivedAt = this.now();
      if (!res.ok) {
        const retryAfter = res.headers.get("retry-after");
        const seconds2 = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
        void res.body?.cancel().catch(() => void 0);
        return {
          ok: false,
          error: describeStatus(res.status),
          status: res.status,
          receivedAt,
          retryable: res.status === 429 || res.status >= 500,
          retryAfterMs: seconds2 !== null ? seconds2 * 1e3 : null
        };
      }
      const text2 = await res.text();
      try {
        return { ok: true, data: JSON.parse(text2), status: res.status, receivedAt, bytes: text2.length };
      } catch {
        return { ok: false, error: "Response was not valid JSON", status: res.status, receivedAt, retryable: false };
      }
    } catch (e) {
      return {
        ok: false,
        error: controller.signal.aborted ? `Timed out after ${this.timeoutMs}ms` : `Network error: ${e.message}`,
        status: null,
        receivedAt: this.now(),
        retryable: true
      };
    } finally {
      clearTimeout(timer);
    }
  }
};

// server/providers/sportradar/normalize.ts
var PROVIDER_ID = "sportradar";
var PROVIDER_NAME2 = "Sportradar";
var SportradarShapeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SportradarShapeError";
  }
};
var newSportradarDiagnostics = () => ({ invalidGames: 0, itemsWithoutId: 0, unknownItems: 0, unattributedPushEvents: 0 });
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var NAMESPACE = "sr:";
var isSportradarUuid = (v) => typeof v === "string" && UUID.test(v);
var encodeId = (providerId) => `${NAMESPACE}${providerId.replace(/-/g, "_")}`;
var sportradarGameId = (league, uuid) => gameId(league, encodeId(uuid));
var sportradarTeamKey = (league, providerTeamId) => teamKey(league, encodeId(providerTeamId));
function parseSportradarGameId(id) {
  const parsed = parseGameId(id);
  if (!parsed || !parsed.providerEventId.startsWith(NAMESPACE)) return null;
  const uuid = parsed.providerEventId.slice(NAMESPACE.length).replace(/_/g, "-");
  return UUID.test(uuid) ? { league: parsed.league, uuid } : null;
}
var STATUS_KIND = {
  scheduled: "scheduled",
  created: "scheduled",
  "time-tbd": "scheduled",
  "flex-schedule": "scheduled",
  "if necessary": "scheduled",
  inprogress: "in_progress",
  halftime: "halftime",
  delayed: "delayed",
  suspended: "suspended",
  complete: "final",
  closed: "final",
  postponed: "postponed",
  cancelled: "canceled",
  unnecessary: "canceled"
};
var STATUS_DETAIL = {
  "time-tbd": "Kickoff time to be determined",
  "flex-schedule": "Flexible scheduling: kickoff time may change",
  "if necessary": "Played only if necessary",
  unnecessary: "Not needed; will not be played",
  complete: "Final score; stats still being verified"
};
function normalizeStatus2(status, quarter, clock, regulationPeriods = 4) {
  const code2 = status === null ? null : status.trim().toLowerCase();
  const kind = code2 !== null && STATUS_KIND[code2] ? STATUS_KIND[code2] : "unknown";
  const clockRelevant = kind === "in_progress" || kind === "delayed" || kind === "suspended";
  const shownClock = clockRelevant ? clock : null;
  return {
    kind,
    period: kind === "scheduled" || quarter === null || !Number.isInteger(quarter) || quarter < 1 ? null : quarter,
    regulationPeriods,
    clock: shownClock,
    clockSeconds: clockToSeconds(shownClock),
    detail: code2 === null ? null : STATUS_DETAIL[code2] ?? (kind === "unknown" ? status : null),
    providerCode: status
  };
}
var scoreHidden = (kind) => kind === "scheduled" || kind === "postponed" || kind === "canceled";
function normalizeTeam2(raw, league, where) {
  const t = obj(raw);
  const providerId = str(t?.id);
  if (!t || !providerId) throw new SportradarShapeError(`${where} has no team id`);
  const alias = str(t.alias);
  const name = str(t.name);
  const market = str(t.market);
  const abbreviation = alias ?? name ?? providerId;
  return {
    key: sportradarTeamKey(league, providerId),
    league,
    providerId,
    abbreviation,
    displayName: market && name ? `${market} ${name}` : name ?? market ?? abbreviation,
    shortName: name ?? abbreviation,
    location: market,
    color: null,
    alternateColor: null,
    logo: null,
    logoDark: null,
    rank: null,
    record: null,
    conferenceId: null
  };
}
function sideOfRef(raw, ctx) {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id);
  if (id !== null) return id === ctx.home.providerId ? "home" : id === ctx.away.providerId ? "away" : null;
  const alias = str(r.alias)?.toUpperCase() ?? null;
  if (alias === null || ctx.home.abbreviation.toUpperCase() === ctx.away.abbreviation.toUpperCase()) return null;
  return alias === ctx.home.abbreviation.toUpperCase() ? "home" : alias === ctx.away.abbreviation.toUpperCase() ? "away" : null;
}
var validIso = (v) => {
  const s = str(v);
  return s !== null && Number.isFinite(Date.parse(s)) ? s : null;
};
function easternDayOf(scheduled) {
  if (scheduled === null) return null;
  const t = Date.parse(scheduled);
  return Number.isFinite(t) ? easternDateKey(new Date(t)) : null;
}
function spotFromLocation(location, offense, ctx, phase, sourceTime) {
  const loc = obj(location);
  const yard = num(loc?.yardline);
  const team = sideOfRef(loc, ctx);
  if (!loc || yard === null || yard < 0 || yard > 50 || team === null && yard !== 50) {
    return { ...UNKNOWN_SPOT, offense, phase, sourceTime };
  }
  const schematicYard = yard === 50 ? 50 : team === "home" ? 100 - yard : yard;
  const abbreviation = team === null ? "" : ctx[team].abbreviation;
  return {
    label: yard === 50 ? "50" : yard === 0 ? `${abbreviation} goal line` : `${abbreviation} ${yard}`,
    offense,
    progress: offense === null ? null : progressFromSchematicYard(schematicYard, offense),
    schematicYard,
    phase,
    provenance: "label",
    lateral: null,
    sourceTime
  };
}
var validDown2 = (d) => d !== null && Number.isInteger(d) && d >= 1 && d <= 4 ? d : null;
var validDistance2 = (d, down) => down !== null && d !== null && d > 0 && d <= 99 ? d : null;
var goalToGo = (distance, progress) => distance === null || progress === null ? null : progress + distance >= 100;
function playState(raw, ctx, phase, sourceTime) {
  const s = obj(raw);
  if (!s) return null;
  const possession = sideOfRef(s.possession, ctx);
  const down = validDown2(num(s.down));
  const distance = validDistance2(num(s.yfd), down);
  const spot = spotFromLocation(s.location, possession, ctx, phase, sourceTime);
  return { state: { down, distance, goalToGo: down === null ? null : goalToGo(distance, spot.progress), downDistanceText: null, spot }, possession };
}
function normalizeSituation2(raw, ctx, timeouts) {
  const read = playState(raw, ctx, "pre-snap", null);
  if (!read) return null;
  const { state, possession } = read;
  return {
    possession,
    down: state.down,
    distance: state.distance,
    goalToGo: state.goalToGo,
    downDistanceText: null,
    spot: state.spot,
    isRedZone: state.spot.progress === null ? null : state.spot.progress >= 80,
    timeouts: { home: timeouts.home, away: timeouts.away },
    lastPlay: null
  };
}
function coverageFor(league, coverage, situation, plays, drives) {
  const level = league === "cfb" && coverage === "full" ? "full" : league === "cfb" && coverage === "extended_boxscore" ? "score-only" : "unknown";
  return { level, score: true, situation, playByPlay: plays > 0, drives: drives > 0, teamStats: false, provider: PROVIDER_NAME2 };
}
function baseSummary(league, uuid, home, away, divisions) {
  return {
    id: sportradarGameId(league, uuid),
    league,
    providerEventId: encodeId(uuid),
    divisions,
    name: `${away.displayName} at ${home.displayName}`,
    shortName: `${away.abbreviation} @ ${home.abbreviation}`,
    home,
    away,
    broadcasts: [],
    venue: null,
    neutralSite: null,
    conferenceGame: null,
    links: { gamePage: null },
    season: { year: null, type: null, week: null },
    notes: []
  };
}
var defaultDivisions = (league) => league === "nfl" ? ["NFL"] : [];
function summaryFromGameRoot(json, league, where, divisions = defaultDivisions(league)) {
  const root = obj(json);
  if (!root) throw new SportradarShapeError(`${where} was not a JSON object`);
  const uuid = str(root.id);
  if (!isSportradarUuid(uuid)) throw new SportradarShapeError(`${where} has no game id (expected a UUID in "id")`);
  const teams2 = obj(root.summary);
  if (!teams2) throw new SportradarShapeError(`${where} has no summary with home and away teams`);
  const home = normalizeTeam2(teams2.home, league, `${where} summary.home`);
  const away = normalizeTeam2(teams2.away, league, `${where} summary.away`);
  const ctx = { league, uuid, gameId: sportradarGameId(league, uuid), home, away };
  const rawStatus = str(root.status);
  const status = normalizeStatus2(rawStatus, num(root.quarter), str(root.clock));
  const homeRaw = obj(teams2.home);
  const awayRaw = obj(teams2.away);
  const timeouts = { home: num(homeRaw?.remaining_timeouts), away: num(awayRaw?.remaining_timeouts) };
  const situation = isLiveOrPaused(status.kind) ? normalizeSituation2(root.situation, ctx, timeouts) : null;
  const summary = {
    ...baseSummary(league, uuid, home, away, divisions),
    startTime: rawStatus?.toLowerCase() === "time-tbd" ? null : validIso(root.scheduled),
    score: scoreHidden(status.kind) ? { home: null, away: null } : { home: num(homeRaw?.points), away: num(awayRaw?.points) },
    status,
    situation,
    coverage: coverageFor(league, str(root.coverage), situation !== null, 0, 0)
  };
  return { summary, ctx, root };
}
var normalizeBoxscore = (json, league, divisions) => summaryFromGameRoot(json, league, `Sportradar ${league === "nfl" ? "NFL" : "NCAA football"} boxscore`, divisions).summary;
function gameLists(value, depth = 0, out = []) {
  if (depth > 4) return out;
  if (Array.isArray(value)) {
    for (const item of value) gameLists(item, depth + 1, out);
    return out;
  }
  const o = obj(value);
  if (!o) return out;
  for (const [key, child] of Object.entries(o)) {
    if (key === "games" && Array.isArray(child)) out.push(child);
    else if (typeof child === "object" && child !== null) gameLists(child, depth + 1, out);
  }
  return out;
}
function parseSchedule(json, diagnostics = newSportradarDiagnostics()) {
  const root = obj(json);
  if (!root) throw new SportradarShapeError("Sportradar schedule was not a JSON object");
  const lists = gameLists(root);
  if (!lists.length) throw new SportradarShapeError("Sportradar schedule had no games list");
  const seen = /* @__PURE__ */ new Map();
  for (const item of lists.flat()) {
    const g = obj(item);
    const uuid = str(g?.id);
    if (!g || !isSportradarUuid(uuid) || !str(obj(g.home)?.id) || !str(obj(g.away)?.id)) {
      diagnostics.invalidGames++;
      continue;
    }
    const scheduled = validIso(g.scheduled);
    seen.set(uuid, { uuid, status: str(g.status), scheduled, dateKey: easternDayOf(scheduled), raw: g });
  }
  return [...seen.values()];
}
function summaryFromSchedule(entry, league, divisions = defaultDivisions(league)) {
  const g = entry.raw;
  const home = normalizeTeam2(g.home, league, "Sportradar schedule game home");
  const away = normalizeTeam2(g.away, league, "Sportradar schedule game away");
  const status = normalizeStatus2(entry.status, num(g.quarter), str(g.clock));
  const scoring = obj(g.scoring);
  return {
    ...baseSummary(league, entry.uuid, home, away, divisions),
    startTime: entry.status?.toLowerCase() === "time-tbd" ? null : entry.scheduled,
    score: scoreHidden(status.kind) ? { home: null, away: null } : { home: num(scoring?.home_points), away: num(scoring?.away_points) },
    status,
    situation: null,
    coverage: coverageFor(league, str(g.coverage), false, 0, 0)
  };
}
var EVENT_KIND = {
  timeout: "timeout",
  tv_timeout: "timeout",
  two_minute_warning: "two_minute_warning",
  period_end: "end_period",
  game_over: "end_game"
};
var EVENT_LABEL = {
  setup: "Game setup",
  timeout: "Timeout",
  tv_timeout: "TV timeout",
  two_minute_warning: "Two-minute warning",
  comment: "Comment",
  period_end: "End of period",
  game_over: "End of game"
};
var detailResults = (raw) => arr(raw.details).map((d) => str(obj(d)?.result)?.toLowerCase() ?? null).filter((r) => r !== null);
function classifyPlay(raw, offense, scorer) {
  const type = str(raw.play_type)?.toLowerCase() ?? null;
  const results = detailResults(raw);
  const scoring = bool(raw.scoring_play);
  const touchdown = scoring === true && results.includes("touchdown") && scorer !== null && offense !== null;
  switch (type) {
    case "pass":
      if (touchdown) return scorer === offense ? "touchdown_pass" : "touchdown_return";
      return "other";
    case "rush":
      if (touchdown) return scorer === offense ? "touchdown_rush" : "touchdown_return";
      return "rush";
    case "punt":
      if (touchdown && scorer !== offense) return "touchdown_return";
      return scoring === true ? "other" : "punt";
    case "field_goal":
      if (touchdown && scorer !== offense) return "touchdown_return";
      if (results.includes("good") && scoring !== false) return "field_goal_good";
      return "other";
    case "extra_point":
      return "extra_point";
    case "conversion":
      return "two_point";
    case "kickoff":
      return scoring === true ? "other" : "kickoff";
    case "penalty":
      return "penalty";
    default:
      return "other";
  }
}
function conversionFor(kind, raw) {
  if (kind !== "extra_point" && kind !== "two_point") return null;
  const result = detailResults(raw).includes("good") ? "good" : "unknown";
  return { kind: kind === "extra_point" ? "kick" : "two-point", result };
}
function orderBySequence(items) {
  let carried = Number.NEGATIVE_INFINITY;
  const keyed = items.map((item) => {
    if (item.sequence !== null) carried = item.sequence;
    return { item, key: item.sequence ?? carried };
  });
  return keyed.sort((a, b) => a.key - b.key || a.item.index - b.item.index).map((k) => k.item);
}
function scoreKindOf(kind, raw) {
  if (detailResults(raw).includes("touchdown") && (kind === "touchdown_pass" || kind === "touchdown_rush" || kind === "touchdown_return" || kind === "other")) return "touchdown";
  if (kind === "field_goal_good") return "field_goal";
  if (kind === "extra_point" || kind === "two_point") return "conversion";
  return "unknown";
}
function normalizePlayByPlay(json, league, divisions = defaultDivisions(league), diagnostics = newSportradarDiagnostics()) {
  const where = `Sportradar ${league === "nfl" ? "NFL" : "NCAA football"} play-by-play`;
  const { summary, ctx, root } = summaryFromGameRoot(json, league, where, divisions);
  if (!Array.isArray(root.periods)) throw new SportradarShapeError(`${where} has no periods list`);
  const items = [];
  const drives = [];
  let index = 0;
  for (const p of root.periods) {
    const period = obj(p);
    if (!period) throw new SportradarShapeError(`${where} has a period that is not an object`);
    if (period.pbp !== void 0 && !Array.isArray(period.pbp)) throw new SportradarShapeError(`${where} has a period whose pbp is not a list`);
    const number = num(period.number);
    for (const entry of arr(period.pbp)) {
      const o = obj(entry);
      const type = str(o?.type);
      if (!o || type !== "drive" && type !== "play" && type !== "event") {
        diagnostics.unknownItems++;
        continue;
      }
      if (type !== "drive") {
        items.push({ raw: o, isEvent: type === "event", period: number, driveId: null, sequence: num(o.sequence), index: index++ });
        continue;
      }
      const providerId = str(o.id);
      if (!providerId) {
        diagnostics.itemsWithoutId++;
        continue;
      }
      const driveId = `${ctx.gameId}:drive:${providerId}`;
      if (!drives.some((d) => d.drive.id === driveId)) {
        drives.push({
          sequence: num(o.sequence),
          index: index++,
          drive: {
            id: driveId,
            providerId,
            gameId: ctx.gameId,
            offense: sideOfRef(o.offensive_team, ctx),
            description: null,
            start: null,
            end: null,
            playIds: [],
            offensivePlays: num(o.play_count),
            yards: num(o.net_yards),
            timeElapsed: str(o.duration),
            result: str(o.end_reason),
            isScore: null,
            isCurrent: false
          }
        });
      }
      for (const ev of arr(o.events)) {
        const e = obj(ev);
        const evType = str(e?.type);
        if (!e || evType !== "play" && evType !== "event") {
          diagnostics.unknownItems++;
          continue;
        }
        items.push({ raw: e, isEvent: evType === "event", period: number, driveId, sequence: num(e.sequence), index: index++ });
      }
    }
  }
  const plays = [];
  const scoring = [];
  const seen = /* @__PURE__ */ new Set();
  let before = { home: 0, away: 0 };
  for (const item of orderBySequence(items)) {
    const p = item.raw;
    const providerId = str(p.id);
    if (!providerId) {
      diagnostics.itemsWithoutId++;
      continue;
    }
    const id = `${ctx.gameId}:${providerId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const wallclock = validIso(p.wall_clock);
    const eventType = item.isEvent ? str(p.event_type)?.toLowerCase() ?? null : null;
    const start = item.isEvent ? null : playState(p.start_situation, ctx, "pre-snap", wallclock);
    const end = item.isEvent ? null : playState(p.end_situation, ctx, "post-play", wallclock);
    const offense = start?.possession ?? null;
    const reported2 = { home: num(p.home_points), away: num(p.away_points) };
    const scoringFlag = item.isEvent ? null : bool(p.scoring_play);
    let scorer = null;
    if (scoringFlag === true && reported2.home !== null && reported2.away !== null && before.home !== null && before.away !== null) {
      const dh = reported2.home - before.home;
      const da = reported2.away - before.away;
      if (dh > 0 && da <= 0) scorer = "home";
      else if (da > 0 && dh <= 0) scorer = "away";
    }
    const kind = item.isEvent ? EVENT_KIND[eventType ?? ""] ?? "other" : classifyPlay(p, offense, scorer);
    const scoreAfter = item.isEvent && ADMIN_KINDS.has(kind) && reported2.home === null && reported2.away === null ? { ...before } : reported2;
    const playType = item.isEvent ? eventType : str(p.play_type)?.toLowerCase() ?? null;
    const clock = str(p.clock);
    const description = str(p.description) ?? (item.isEvent ? EVENT_LABEL[eventType ?? ""] ?? eventType ?? "Event" : playType ?? "Play");
    const play = {
      id,
      providerId,
      gameId: ctx.gameId,
      driveId: item.driveId,
      sequence: item.sequence,
      order: plays.length,
      period: item.period,
      clock,
      description,
      providerType: { id: null, text: playType },
      kind,
      offense,
      start: start?.state ?? null,
      end: end?.state ?? null,
      yards: null,
      scoring: scoringFlag,
      scoringTeam: scorer,
      turnover: null,
      penalty: playType === "penalty" ? true : null,
      possessionChanged: start?.possession && end?.possession ? start.possession !== end.possession : null,
      conversion: conversionFor(kind, p),
      review: null,
      scoreAfter,
      modified: null,
      wallclock,
      revision: fingerprint(
        JSON.stringify([
          playType,
          description,
          clock,
          item.sequence,
          item.period,
          item.driveId,
          p.home_points,
          p.away_points,
          p.scoring_play,
          p.official,
          p.start_situation ?? null,
          p.end_situation ?? null,
          p.details ?? null
        ])
      )
    };
    plays.push(play);
    if (scoringFlag === true) {
      scoring.push({
        id: `${ctx.gameId}:score:${providerId}`,
        gameId: ctx.gameId,
        playId: id,
        period: item.period,
        clock,
        team: scorer,
        kind: scoreKindOf(kind, p),
        description,
        scoreAfter
      });
    }
    if (scoreAfter.home !== null && scoreAfter.away !== null) before = scoreAfter;
  }
  const orderedDrives = orderBySequence(drives.map((d) => ({ ...d }))).map((d) => d.drive);
  for (const play of plays) if (play.driveId) orderedDrives.find((d) => d.id === play.driveId)?.playIds.push(play.id);
  const last = orderedDrives[orderedDrives.length - 1];
  if (last && isLiveOrPaused(summary.status.kind) && last.result === null) last.isCurrent = true;
  const gaps = findGaps(plays);
  if (summary.coverage.level === "full" && plays.length === 0 && summary.status.kind !== "scheduled") {
    gaps.push({ afterPlayId: null, beforePlayId: null, reason: "The provider lists full play-by-play for this game but returned no plays yet." });
  }
  return {
    gameId: ctx.gameId,
    summary: { ...summary, coverage: coverageFor(league, str(root.coverage), summary.situation !== null, plays.length, orderedDrives.length) },
    drives: orderedDrives,
    plays,
    scoring,
    stats: [],
    leaders: [],
    attendance: null,
    currentDriveId: last?.isCurrent ? last.id : null,
    gaps
  };
}
function summaryFromPush(game, event, league, known) {
  const { summary, ctx } = summaryFromGameRoot(game, league, "Sportradar push payload.game", known?.divisions);
  const sameTeams = known !== null && known.home.providerId === summary.home.providerId && known.away.providerId === summary.away.providerId;
  const e = obj(event);
  const end = e && isLiveOrPaused(summary.status.kind) ? playState(e.end_situation, ctx, "post-play", validIso(e.wall_clock)) : null;
  const situation = end ? {
    possession: end.possession,
    down: end.state.down,
    distance: end.state.distance,
    goalToGo: end.state.goalToGo,
    downDistanceText: null,
    spot: end.state.spot,
    isRedZone: end.state.spot.progress === null ? null : end.state.spot.progress >= 80,
    timeouts: { home: null, away: null },
    lastPlay: null
  } : null;
  return {
    ...summary,
    home: sameTeams ? { ...known.home, ...pickReported(summary.home) } : summary.home,
    away: sameTeams ? { ...known.away, ...pickReported(summary.away) } : summary.away,
    startTime: summary.startTime ?? (sameTeams ? known.startTime : null),
    situation,
    coverage: sameTeams && summary.coverage.level === "unknown" ? known.coverage : summary.coverage
  };
}
function pickReported(team) {
  return team.abbreviation === team.providerId ? {} : { abbreviation: team.abbreviation, displayName: team.displayName, shortName: team.shortName, location: team.location ?? void 0 };
}

// server/providers/sportradar/push.ts
var systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};
var obj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
var text = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
function parsePushMessage(value) {
  const root = obj2(value);
  if (!root) return { type: "unrecognized" };
  const heartbeat = obj2(root.heartbeat);
  if (heartbeat) {
    const interval = heartbeat.interval;
    return { type: "heartbeat", interval: typeof interval === "number" && Number.isFinite(interval) ? interval : null };
  }
  const payload = obj2(root.payload);
  const meta = obj2(root.metadata);
  if (!payload && !meta) return { type: "unrecognized" };
  return {
    type: "event",
    game: obj2(payload?.game),
    event: obj2(payload?.event),
    metadata: {
      league: text(meta?.league),
      match: text(meta?.match),
      status: text(meta?.status),
      eventType: text(meta?.event_type),
      operation: text(meta?.operation),
      version: text(meta?.version)
    }
  };
}
var LineSplitter = class {
  constructor(maxLineChars = 4e6) {
    this.maxLineChars = maxLineChars;
  }
  maxLineChars;
  decoder = new TextDecoder();
  buffer = "";
  /** Complete lines found so far. Throws when a line grows past the limit. */
  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    if (this.buffer.length > this.maxLineChars) throw new Error(`A push line exceeded ${this.maxLineChars} characters`);
    return parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
  }
  /** Whatever remains when the stream ends. */
  flush() {
    const rest = (this.buffer + this.decoder.decode()).replace(/\r$/, "");
    this.buffer = "";
    return rest.trim() === "" ? [] : [rest];
  }
};
var SportradarPushStream = class {
  constructor(options) {
    this.options = options;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.silenceMs = options.silenceMs ?? 2e4;
    this.baseBackoffMs = options.baseBackoffMs ?? 1e3;
    this.maxBackoffMs = options.maxBackoffMs ?? 6e4;
    this.maxLineChars = options.maxLineChars ?? 4e6;
  }
  options;
  listeners = /* @__PURE__ */ new Set();
  fetchImpl;
  clock;
  random;
  silenceMs;
  baseBackoffMs;
  maxBackoffMs;
  maxLineChars;
  currentState = "idle";
  controller = null;
  retryTimer = null;
  silenceTimer = null;
  loop = null;
  attempts = 0;
  failures = 0;
  silent = false;
  get state() {
    return this.currentState;
  }
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start() {
    if (this.currentState !== "idle") return;
    this.connect();
  }
  /** Close the connection, cancel any pending reconnect and wait for the reader to finish. */
  async stop() {
    if (this.currentState === "stopped") return;
    this.currentState = "stopped";
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearSilence();
    this.controller?.abort(new Error("stopped"));
    const loop = this.loop;
    if (loop) await loop;
    this.emit({ type: "stopped", at: this.clock.now() });
  }
  /** Delay before reconnect attempt n (1-based): exponential, capped, with jitter in [half, full]. */
  backoffDelay(failures) {
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, failures - 1));
    return Math.round(exp * (0.5 + this.random() * 0.5));
  }
  emit(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  connect() {
    this.retryTimer = null;
    this.attempts++;
    this.currentState = "connecting";
    this.emit({ type: "connecting", attempt: this.attempts, at: this.clock.now() });
    this.loop = this.read(this.attempts);
  }
  armSilence(controller) {
    this.clearSilence();
    this.silenceTimer = this.clock.setTimeout(() => {
      this.silent = true;
      controller.abort(new Error("silence"));
    }, this.silenceMs);
  }
  clearSilence() {
    if (this.silenceTimer !== null) this.clock.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }
  async read(attempt) {
    const controller = new AbortController();
    this.controller = controller;
    this.silent = false;
    let status = null;
    let reason = "The stream ended";
    let delivered = false;
    this.armSilence(controller);
    try {
      const res = await this.fetchImpl(this.options.url, {
        headers: { "x-api-key": this.options.apiKey.reveal() },
        redirect: "follow",
        signal: controller.signal
      });
      status = res.status;
      if (!res.ok || !res.body) {
        void res.body?.cancel().catch(() => void 0);
        reason = res.ok ? "The response had no body" : `HTTP ${res.status}`;
      } else {
        this.currentState = "open";
        this.emit({ type: "open", attempt, at: this.clock.now() });
        const splitter = new LineSplitter(this.maxLineChars);
        const reader = res.body.getReader();
        try {
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            this.armSilence(controller);
            for (const line of splitter.push(value)) if (this.handleLine(line)) delivered = true;
          }
          for (const line of splitter.flush()) if (this.handleLine(line)) delivered = true;
        } finally {
          void reader.cancel().catch(() => void 0);
        }
      }
    } catch (e) {
      reason = this.silent ? `No data for ${this.silenceMs}ms` : `Network error: ${e.message}`;
    } finally {
      this.clearSilence();
      if (this.controller === controller) this.controller = null;
    }
    if (this.currentState === "stopped") return;
    if (delivered) this.failures = 0;
    this.failures++;
    const retryInMs = this.backoffDelay(this.failures);
    this.currentState = "waiting";
    this.emit({ type: "disconnected", reason, status, retryInMs, at: this.clock.now() });
    this.retryTimer = this.clock.setTimeout(() => {
      if (this.currentState === "waiting") this.connect();
    }, retryInMs);
  }
  /** True when the line was a valid heartbeat or event. */
  handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit({ type: "invalid-line", error: "A push line was not valid JSON", at: this.clock.now() });
      return false;
    }
    const message = parsePushMessage(parsed);
    this.emit({ type: "message", message, at: this.clock.now() });
    return message.type !== "unrecognized";
  }
};

// server/providers/sportradar/provider.ts
var LEAGUE_LABEL = { nfl: "NFL", cfb: "NCAA football" };
var SCHEDULE_TTL_MS = 6 * 60 * 6e4;
var LIVE_REFRESH_MS = 3e3;
var COMPLETE_REFRESH_MS = 5 * 6e4;
var MAX_DOCUMENTS = 400;
var PUSH_BACKFILL_DELAY_MS = 3e3;
function maxAgeFor(data) {
  const status = str(obj(data)?.status)?.toLowerCase();
  if (status === "closed") return Number.POSITIVE_INFINITY;
  if (status === "complete") return COMPLETE_REFRESH_MS;
  return LIVE_REFRESH_MS;
}
var SportradarProvider = class {
  constructor(config2, options = {}) {
    this.config = config2;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.client = options.client ?? new SportradarClient({ now: this.now, queriesPerSecond: options.queriesPerSecond ?? TRIAL_LIMITS.queriesPerSecond });
    this.scheduleTtlMs = options.scheduleTtlMs ?? SCHEDULE_TTL_MS;
    const leagues = ["nfl", "cfb"].filter((l) => config2.keys[l]).map((l) => LEAGUE_LABEL[l]);
    const push2 = config2.push && config2.accessLevel === "production";
    this.info = {
      id: PROVIDER_ID,
      name: PROVIDER_NAME2,
      description: `Sportradar NFL and NCAA Football v7 APIs on ${config2.accessLevel} access, for ${leagues.join(" and ")}. Licensed. Requests are queued per key within the queries-per-second limit. ${push2 ? "Push events are streamed, with play-by-play re-read after each event." : "Polled, not pushed."}`,
      licensed: true,
      push: push2,
      // College divisions are not named in the documented schedule and game fields, so none are claimed.
      divisions: config2.keys.nfl ? ["NFL"] : []
    };
    if (push2) this.subscribe = (onEvent) => this.addPushListener(onEvent);
  }
  config;
  options;
  info;
  diagnostics = newSportradarDiagnostics();
  subscribe;
  client;
  now;
  scheduleTtlMs;
  schedules = /* @__PURE__ */ new Map();
  documents = /* @__PURE__ */ new Map();
  summaries = /* @__PURE__ */ new Map();
  pushListeners = /* @__PURE__ */ new Set();
  backfills = /* @__PURE__ */ new Map();
  streams = [];
  // ------------------------------------------------------------ slate
  async fetchSlate(league, dateKey, _options) {
    const label = LEAGUE_LABEL[league];
    const key = this.config.keys[league];
    const unavailable = (error, limitations2 = []) => ({
      league,
      dateKey,
      games: [],
      divisions: league === "nfl" ? [{ division: "NFL", label: "NFL", providerGroupId: null, games: 0, health: "unavailable" }] : [],
      errors: [error],
      failed: true,
      receivedAt: this.now(),
      discovery: `${label} games come from Sportradar's current season schedule.`,
      limitations: limitations2
    });
    if (!key) return unavailable({ scope: `${label} schedule`, message: missingKeyMessage(league), status: null });
    const schedule = await this.schedule(league, key);
    if (!schedule.value) return unavailable(schedule.error ?? { scope: `${label} schedule`, message: "Schedule unavailable", status: null });
    const errors = schedule.error ? [schedule.error] : [];
    const limitations = this.limitations(league);
    if (schedule.error) {
      limitations.push(`The ${label} season schedule could not be refreshed; games that have not reached kickoff use the copy read at ${new Date(schedule.value.receivedAt).toISOString()}.`);
    }
    const day = schedule.value.entries.filter((e) => e.dateKey === dateKey);
    const divisions = league === "nfl" ? ["NFL"] : [];
    const results = await Promise.all(day.map((entry) => this.summaryFor(entry, league, key, divisions)));
    const games = [];
    let unreadable = 0;
    for (const r of results) {
      if (r.ok) {
        games.push(r.summary);
        this.remember(r.summary);
      } else {
        unreadable++;
        errors.push(r.error);
      }
    }
    games.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.id.localeCompare(b.id));
    if (games.some((g) => g.status.providerCode?.toLowerCase() === "complete")) {
      limitations.push("Some final scores are marked complete: the score is final but Sportradar is still verifying the statistics.");
    }
    const coverage = league === "nfl" ? [{
      division: "NFL",
      label: unreadable ? `NFL (${unreadable} of ${day.length} games could not be read)` : "NFL",
      providerGroupId: null,
      games: games.length,
      // "unavailable" tells the engine to keep the games it already has instead of dropping them.
      health: unreadable ? "unavailable" : "connected"
    }] : [];
    return {
      league,
      dateKey,
      games,
      divisions: coverage,
      errors,
      failed: false,
      receivedAt: this.now(),
      discovery: `${label} games for ${dateKey} from Sportradar's current season schedule, filtered by the US Eastern date of each scheduled time. Live and final games are read from their boxscores.`,
      limitations
    };
  }
  limitations(league) {
    const out = [];
    if (this.config.accessLevel === "trial") {
      out.push(`Sportradar trial access allows ${TRIAL_LIMITS.queriesPerSecond} query per second and ${TRIAL_LIMITS.requestsPer30Days.toLocaleString("en-US")} requests per 30 days, so games are read slowly and the quota runs out quickly while games are live.`);
    }
    if (league === "cfb") {
      out.push("Sportradar's documented schedule and game fields do not name a college game's division, so college games are not sorted into FBS, FCS, Division II or Division III, and the division filter cannot narrow them.");
    }
    out.push("Only the current season schedule is read, so days outside the current season have no games.");
    return out;
  }
  async schedule(league, key) {
    const cached = this.schedules.get(league) ?? null;
    if (cached && this.now() - cached.receivedAt < this.scheduleTtlMs) return { value: cached, error: null };
    const scope = `${LEAGUE_LABEL[league]} schedule`;
    const res = await this.client.getJson(seasonScheduleUrl(league, this.config.accessLevel), key);
    if (!res.ok) return { value: cached, error: { scope, message: res.error, status: res.status } };
    try {
      const value = { entries: parseSchedule(res.data, this.diagnostics), receivedAt: res.receivedAt };
      this.schedules.set(league, value);
      return { value, error: null };
    } catch (e) {
      return { value: cached, error: { scope, message: e.message, status: res.status } };
    }
  }
  async summaryFor(entry, league, key, divisions) {
    const scope = `${LEAGUE_LABEL[league]} game ${entry.uuid}`;
    const cachedBox = this.documents.get(boxscoreUrl(league, this.config.accessLevel, entry.uuid));
    const kind = normalizeStatus2(str(obj(cachedBox?.data)?.status) ?? entry.status, null, null).kind;
    const start = entry.scheduled ? Date.parse(entry.scheduled) : NaN;
    const started = Number.isFinite(start) && this.now() >= start;
    const needsBoxscore = kind === "final" || isLiveOrPaused(kind) || (kind === "scheduled" || kind === "unknown") && started;
    try {
      if (!needsBoxscore) return { ok: true, summary: summaryFromSchedule(entry, league, divisions) };
      const doc = await this.document(boxscoreUrl(league, this.config.accessLevel, entry.uuid), key);
      if (!doc.ok) return { ok: false, error: { scope: `${scope} boxscore`, message: doc.error, status: doc.status } };
      return { ok: true, summary: normalizeBoxscore(doc.data, league, divisions) };
    } catch (e) {
      this.diagnostics.invalidGames++;
      return { ok: false, error: { scope, message: e.message, status: null } };
    }
  }
  /** A boxscore or play-by-play document, reused while younger than its status allows. */
  async document(url, key) {
    const cached = this.documents.get(url);
    if (cached && this.now() - cached.receivedAt < maxAgeFor(cached.data)) return { ok: true, data: cached.data, receivedAt: cached.receivedAt };
    const res = await this.client.getJson(url, key);
    if (!res.ok) return { ok: false, error: res.error, status: res.status, receivedAt: res.receivedAt };
    this.documents.delete(url);
    this.documents.set(url, { data: res.data, receivedAt: res.receivedAt });
    while (this.documents.size > MAX_DOCUMENTS) this.documents.delete(this.documents.keys().next().value);
    return { ok: true, data: res.data, receivedAt: res.receivedAt };
  }
  remember(summary) {
    this.summaries.delete(summary.id);
    this.summaries.set(summary.id, summary);
    while (this.summaries.size > MAX_DOCUMENTS) this.summaries.delete(this.summaries.keys().next().value);
  }
  // ------------------------------------------------------------ detail
  async fetchDetail(id, knownDivisions) {
    const scope = "Game detail";
    const parsed = parseSportradarGameId(id);
    if (!parsed) return { ok: false, error: { scope, message: `Not a Sportradar game id: ${id}`, status: null }, receivedAt: this.now() };
    const key = this.config.keys[parsed.league];
    if (!key) return { ok: false, error: { scope, message: missingKeyMessage(parsed.league), status: null }, receivedAt: this.now() };
    const doc = await this.document(playByPlayUrl(parsed.league, this.config.accessLevel, parsed.uuid), key);
    if (!doc.ok) return { ok: false, error: { scope, message: doc.error, status: doc.status }, receivedAt: doc.receivedAt };
    let detail;
    try {
      detail = normalizePlayByPlay(doc.data, parsed.league, knownDivisions ?? (parsed.league === "nfl" ? ["NFL"] : []), this.diagnostics);
    } catch (e) {
      return { ok: false, error: { scope, message: e.message, status: null }, receivedAt: doc.receivedAt };
    }
    if (detail.gameId !== id) {
      return { ok: false, error: { scope, message: `Play-by-play for ${id} described a different game`, status: null }, receivedAt: doc.receivedAt };
    }
    this.remember(detail.summary);
    return { ok: true, detail, receivedAt: doc.receivedAt };
  }
  // ------------------------------------------------------------ push
  addPushListener(onEvent) {
    this.pushListeners.add(onEvent);
    if (!this.streams.length) {
      for (const league of ["nfl", "cfb"]) {
        const key = this.config.keys[league];
        if (!key) continue;
        const url = pushEventsUrl(league, this.config.accessLevel);
        const stream = this.options.pushStream ? this.options.pushStream(league, url, key) : new SportradarPushStream({ url, apiKey: key });
        stream.on((event) => this.onPush(league, event));
        stream.start();
        this.streams.push(stream);
      }
    }
    return () => {
      this.pushListeners.delete(onEvent);
      if (this.pushListeners.size) return;
      for (const timer of this.backfills.values()) clearTimeout(timer);
      this.backfills.clear();
      const streams = this.streams;
      this.streams = [];
      for (const s of streams) void s.stop();
    };
  }
  emitPush(event) {
    for (const listener of [...this.pushListeners]) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  onPush(league, event) {
    if (event.type === "open" && event.attempt > 1) {
      for (const s of this.summaries.values()) if (s.league === league && isLiveOrPaused(s.status.kind)) this.backfill(s.id);
      return;
    }
    if (event.type !== "message" || event.message.type !== "event") return;
    const { game, event: play } = event.message;
    const uuid = str(game?.id);
    if (!isSportradarUuid(uuid)) {
      this.diagnostics.unattributedPushEvents++;
      return;
    }
    const id = sportradarGameId(league, uuid);
    let summary;
    try {
      summary = summaryFromPush(game, play, league, this.summaries.get(id) ?? null);
    } catch {
      this.diagnostics.unattributedPushEvents++;
      return;
    }
    this.remember(summary);
    this.emitPush({ gameId: id, kind: "summary", summary, receivedAt: event.at });
    if (play) this.backfill(id);
  }
  /** Re-read one game's play-by-play shortly after push activity, once per burst. */
  backfill(id) {
    if (this.backfills.has(id)) return;
    const timer = setTimeout(() => {
      this.backfills.delete(id);
      void this.fetchDetail(id, this.summaries.get(id)?.divisions).then((res) => {
        if (res.ok && this.pushListeners.size) this.emitPush({ gameId: id, kind: "detail", detail: res.detail, receivedAt: res.receivedAt });
      });
    }, PUSH_BACKFILL_DELAY_MS);
    timer.unref?.();
    this.backfills.set(id, timer);
  }
};

// shared/push.ts
var PUSH_KINDS = [
  "touchdown",
  "field_goal",
  "safety",
  "turnover",
  "red_zone",
  "fourth_down_attempt",
  "big_play",
  "lead_change",
  "tied",
  "close_late",
  "overtime",
  "final",
  "kickoff",
  "score_change"
];
var DEFAULT_PUSH_KINDS = ["touchdown", "field_goal", "turnover", "lead_change", "close_late", "overtime", "final", "kickoff"];

// server/push/store.ts
import { createHash, ECDH, randomBytes as randomBytes3 } from "node:crypto";
import { readFileSync as readFileSync2 } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";

// shared/format.ts
var SPOT_UNAVAILABLE = "Ball spot unavailable";
function teamFor(game, side) {
  return side === "home" ? game.home : side === "away" ? game.away : null;
}
function downDistance(s) {
  if (!s || s.down === null) return null;
  if (s.goalToGo) return `${ordinal(s.down)} & Goal`;
  if (s.distance === null) return ordinal(s.down);
  return `${ordinal(s.down)} & ${s.distance}`;
}
function spotLabel(spot, game) {
  if (!spot || spot.schematicYard === null) return SPOT_UNAVAILABLE;
  if (spot.offense && spot.progress !== null) return labelFromProgress(spot.progress, spot.offense, { home: game.home, away: game.away });
  return spot.label ?? SPOT_UNAVAILABLE;
}
function scoreText(game) {
  const a = game.score.away;
  const h = game.score.home;
  if (a === null || h === null) return `${game.away.abbreviation} at ${game.home.abbreviation}`;
  return `${game.away.abbreviation} ${a}, ${game.home.abbreviation} ${h}`;
}
function leader(game) {
  const { home, away } = game.score;
  if (home === null || away === null) return null;
  return home === away ? "tied" : home > away ? "home" : "away";
}

// shared/alerts.ts
var ALERT_KINDS = [
  "touchdown",
  "field_goal",
  "safety",
  "turnover",
  "red_zone",
  "fourth_down_attempt",
  "fourth_down",
  "big_play",
  "lead_change",
  "tied",
  "close_late",
  "overtime",
  "final",
  "kickoff",
  "review",
  "score_change"
];
var DEFAULT_ALERT_RULES = {
  scope: "all",
  enabled: {
    touchdown: true,
    field_goal: true,
    safety: true,
    turnover: true,
    red_zone: false,
    fourth_down_attempt: true,
    fourth_down: false,
    big_play: true,
    lead_change: true,
    tied: true,
    close_late: true,
    overtime: true,
    final: true,
    kickoff: true,
    review: false,
    score_change: true
  },
  bigPlayYards: 30,
  closeMargin: 8,
  lateSeconds: 300
};
var ALERT_PRIORITY = {
  touchdown: 1,
  turnover: 1,
  lead_change: 1,
  overtime: 1,
  close_late: 1,
  safety: 1,
  field_goal: 2,
  fourth_down_attempt: 2,
  red_zone: 2,
  big_play: 2,
  tied: 2,
  final: 2,
  kickoff: 2,
  fourth_down: 3,
  review: 3,
  score_change: 2
};
var SCORE_GRACE_MS = 9e4;
var BURST_PLAYS = 3;
var TURNOVER_KINDS = /* @__PURE__ */ new Set(["interception", "fumble_lost"]);
var GAIN_KINDS = /* @__PURE__ */ new Set(["rush", "pass_complete", "touchdown_rush", "touchdown_pass", "punt_return", "kickoff_return"]);
var SNAP_KINDS = /* @__PURE__ */ new Set(["rush", "pass_complete", "pass_incomplete", "sack", "touchdown_rush", "touchdown_pass", "interception", "fumble_lost", "fumble", "fumble_recovered_own"]);
var AlertEngine = class {
  constructor(rules = DEFAULT_ALERT_RULES, context = { favorites: [], monitored: [], muted: [] }) {
    this.rules = rules;
    this.context = context;
  }
  rules;
  context;
  memory = /* @__PURE__ */ new Map();
  setRules(rules) {
    this.rules = rules;
  }
  setContext(context) {
    this.context = context;
  }
  /** Forget everything; the next observations become a fresh baseline (after a delay change or a mode switch). */
  reset() {
    this.memory.clear();
  }
  forget(gameId2) {
    this.memory.delete(gameId2);
  }
  observe(game, detail, at2, options = false) {
    const opts = typeof options === "boolean" ? { gap: options } : options;
    const gap = opts.gap === true;
    const detailExpected = opts.detailExpected ?? detail !== null;
    const out = [];
    let mem = this.memory.get(game.id);
    if (!mem) {
      this.memory.set(game.id, this.baseline(game, detail));
      return out;
    }
    const emit = (kind, key, fill) => {
      const id = `${game.id}:${key}`;
      if (mem.alerts.has(id)) return;
      const alert = { id, revision: 1, kind, gameId: game.id, receivedAt: at2, status: "active", priority: ALERT_PRIORITY[kind], ...fill, late: gap || fill.late === true };
      mem.alerts.set(id, alert);
      if (this.allowed(game, kind)) out.push({ type: "created", alert });
    };
    const update = (id, patch) => {
      const existing = mem.alerts.get(id);
      if (!existing) return;
      const next = { ...existing, ...patch, revision: existing.revision + 1 };
      mem.alerts.set(id, next);
      if (this.allowed(game, next.kind)) out.push({ type: "updated", alert: next });
    };
    const st = game.status;
    const base = { team: null, period: st.period, clock: st.clock, sourceTime: null, playId: null };
    if (mem.status === "scheduled" && isLiveOrPaused(st.kind)) {
      if (this.isFavoriteGame(game)) emit("kickoff", "kickoff", { ...base, title: `Kickoff: ${game.away.abbreviation} at ${game.home.abbreviation}`, detail: "A favorite team\u2019s game has started." });
    }
    const inOvertime = st.period !== null && st.period > st.regulationPeriods && isLiveOrPaused(st.kind);
    if (inOvertime && !mem.overtime && mem.period !== null && mem.period <= st.regulationPeriods) {
      emit("overtime", "overtime", { ...base, title: `Overtime: ${scoreText(game)}`, detail: "Regulation ended tied." });
    }
    if (inOvertime) mem.overtime = true;
    if (st.kind === "final" && mem.status !== "final" && mem.status !== "unknown") {
      emit("final", "final", { ...base, title: `Final: ${scoreText(game)}`, detail: st.detail ?? "Final" });
    }
    const newScoringPlays = [];
    if (detail) {
      if (mem.plays === null) {
        mem.plays = new Map(detail.plays.map((p) => [p.id, { revision: p.revision, alerts: /* @__PURE__ */ new Map() }]));
      } else {
        const present = /* @__PURE__ */ new Set();
        let unseen = 0;
        for (const p of detail.plays) if (!mem.plays.has(p.id) && !ADMIN_KINDS.has(p.kind)) unseen++;
        const burst = unseen > BURST_PLAYS;
        for (const p of detail.plays) {
          present.add(p.id);
          const known = mem.plays.get(p.id);
          if (!known) {
            const kinds = this.playAlertKinds(game, p);
            const record = { revision: p.revision, alerts: /* @__PURE__ */ new Map() };
            mem.plays.set(p.id, record);
            for (const [kind, text2] of kinds) {
              const key = `${kind}:${p.providerId}`;
              emit(kind, key, { team: text2.team, period: p.period, clock: p.clock, title: text2.title, detail: text2.detail, sourceTime: p.wallclock, playId: p.id, late: burst });
              record.alerts.set(kind, `${game.id}:${key}`);
            }
            if (p.scoring || kinds.has("touchdown") || kinds.has("field_goal") || kinds.has("safety")) newScoringPlays.push(p);
          } else if (known.revision !== p.revision) {
            known.revision = p.revision;
            const kinds = this.playAlertKinds(game, p);
            for (const [kind, id] of known.alerts) {
              const still = kinds.get(kind);
              if (still) update(id, { title: still.title, detail: `${still.detail} (Play corrected)`, status: "corrected" });
              else update(id, { status: "withdrawn", detail: `Play corrected: ${p.description}` });
            }
            for (const [kind, text2] of kinds) {
              if (known.alerts.has(kind)) continue;
              const key = `${kind}:${p.providerId}`;
              emit(kind, key, { team: text2.team, period: p.period, clock: p.clock, title: text2.title, detail: `${text2.detail} (Play corrected)`, sourceTime: p.wallclock, playId: p.id, late: true });
              known.alerts.set(kind, `${game.id}:${key}`);
            }
          }
        }
        for (const [id, known] of mem.plays) {
          if (present.has(id)) continue;
          for (const alertId of known.alerts.values()) update(alertId, { status: "withdrawn", detail: "The provider removed this play." });
          mem.plays.delete(id);
        }
      }
    }
    const { home, away } = game.score;
    const knownBefore = mem.score.home !== null && mem.score.away !== null;
    if (home !== null && away !== null && knownBefore && (home !== mem.score.home || away !== mem.score.away)) {
      const decreased = home < mem.score.home || away < mem.score.away;
      const now = leader(game);
      if (!decreased) {
        if (now === "tied" && mem.leader !== "tied") {
          emit("tied", `tied:${away}-${home}`, { ...base, title: `Tied: ${scoreText(game)}`, detail: "The game is level." });
        } else if ((mem.leader === "home" || mem.leader === "away") && (now === "home" || now === "away") && now !== mem.leader) {
          const team = teamFor(game, now);
          emit("lead_change", `lead:${away}-${home}`, { ...base, team: now, title: `${team.abbreviation} takes the lead`, detail: scoreText(game) });
        }
      }
      if (decreased) {
        emit("score_change", `score:${away}-${home}`, { ...base, title: `Score corrected: ${scoreText(game)}`, detail: "The provider lowered a score. No new points were scored." });
        mem.pendingScore = null;
      } else if (newScoringPlays.length) {
        mem.pendingScore = null;
      } else if (!detailExpected || game.coverage.level === "score-only") {
        emit("score_change", `score:${away}-${home}`, {
          ...base,
          title: `Score changed: ${scoreText(game)}`,
          detail: game.coverage.level === "score-only" ? "This game has score-only coverage, so the scoring play is not reported." : "Play-by-play is not loaded for this game, so the scoring play is not identified."
        });
      } else {
        mem.pendingScore = { home, away, at: at2 };
      }
    } else if (newScoringPlays.length) {
      mem.pendingScore = null;
    }
    if (mem.pendingScore && at2 - mem.pendingScore.at >= SCORE_GRACE_MS) {
      const p = mem.pendingScore;
      mem.pendingScore = null;
      emit("score_change", `score:${p.away}-${p.home}`, { ...base, title: `Score changed: ${game.away.abbreviation} ${p.away}, ${game.home.abbreviation} ${p.home}`, detail: "No matching scoring play has been reported yet.", late: true });
    }
    if (home !== null && away !== null) {
      mem.score = { home, away };
      mem.leader = leader(game);
    }
    const sit = game.situation;
    if (sit && isLiveOrPaused(st.kind)) {
      const progress = sit.spot.progress;
      const inside = progress === null ? null : progress >= 80;
      if (inside === true && mem.redZone === "outside") {
        mem.redZoneCount++;
        const team = teamFor(game, sit.possession);
        emit("red_zone", `redzone:${mem.redZoneCount}:${sit.possession}:${st.period}`, {
          ...base,
          team: sit.possession,
          title: `${team?.abbreviation ?? "Offense"} in the red zone`,
          detail: `${downDistance(sit) ?? "Down not reported"} at ${spotLabel(sit.spot, game)}`
        });
      }
      if (inside !== null) mem.redZone = inside ? "inside" : "outside";
      if (sit.down === 4) {
        const key = `${sit.possession}:${progress ?? "unknown"}:${st.period}`;
        if (key !== mem.fourthKey) {
          mem.fourthKey = key;
          const team = teamFor(game, sit.possession);
          emit("fourth_down", `fourth:${key}`, { ...base, team: sit.possession, title: `4th down: ${team?.abbreviation ?? "offense"}`, detail: `${downDistance(sit)} at ${spotLabel(sit.spot, game)}` });
        }
      } else if (sit.down !== null) {
        mem.fourthKey = null;
      }
    }
    const late = st.kind === "in_progress" && st.period !== null && st.period === st.regulationPeriods && st.clockSeconds !== null && st.clockSeconds <= this.rules.lateSeconds;
    const m = home !== null && away !== null ? Math.abs(home - away) : null;
    if (late && m !== null && m <= this.rules.closeMargin && mem.closeLatePeriod !== st.period) {
      mem.closeLatePeriod = st.period;
      emit("close_late", `close:${st.period}`, {
        ...base,
        title: m === 0 ? `Tied late: ${scoreText(game)}` : `${m}-point game late`,
        detail: `${scoreText(game)} \xB7 ${st.clock ?? ""} ${st.period !== null && st.period > st.regulationPeriods ? "in overtime" : "left in the 4th"}`.trim()
      });
    }
    mem.status = st.kind;
    mem.period = st.period;
    return out;
  }
  baseline(game, detail) {
    const st = game.status;
    const progress = game.situation?.spot.progress ?? null;
    const m = game.score.home !== null && game.score.away !== null ? Math.abs(game.score.home - game.score.away) : null;
    const late = st.kind === "in_progress" && st.period !== null && st.period === st.regulationPeriods && st.clockSeconds !== null && st.clockSeconds <= this.rules.lateSeconds;
    return {
      status: st.kind,
      period: st.period,
      score: { ...game.score },
      leader: leader(game),
      redZone: progress === null ? null : progress >= 80 ? "inside" : "outside",
      redZoneCount: 0,
      fourthKey: game.situation?.down === 4 ? `${game.situation.possession}:${progress ?? "unknown"}:${st.period}` : null,
      closeLatePeriod: late && m !== null && m <= this.rules.closeMargin ? st.period : null,
      overtime: st.period !== null && st.period > st.regulationPeriods,
      plays: detail ? new Map(detail.plays.map((p) => [p.id, { revision: p.revision, alerts: /* @__PURE__ */ new Map() }])) : null,
      pendingScore: null,
      alerts: /* @__PURE__ */ new Map()
    };
  }
  isFavoriteGame(game) {
    return this.context.favorites.includes(game.home.key) || this.context.favorites.includes(game.away.key);
  }
  allowed(game, kind) {
    if (!this.rules.enabled[kind]) return false;
    if (this.context.muted.includes(game.id)) return false;
    if (kind === "kickoff") return this.isFavoriteGame(game);
    if (this.rules.scope === "favorites") return this.isFavoriteGame(game);
    if (this.rules.scope === "monitored") return this.context.monitored.includes(game.id) || this.isFavoriteGame(game);
    return true;
  }
  /** Alert kinds a play qualifies for, from explicit classification only. */
  playAlertKinds(game, p) {
    const out = /* @__PURE__ */ new Map();
    const offense = teamFor(game, p.offense);
    const conversion = p.conversion ? ` \xB7 ${p.conversion.kind === "kick" ? "Extra point" : "Two-point try"} ${p.conversion.result === "good" ? "good" : p.conversion.result === "unknown" ? "result not reported" : p.conversion.result}` : "";
    if (TOUCHDOWN_KINDS.has(p.kind) && p.scoring !== false) {
      const side = p.scoringTeam ?? (p.kind === "touchdown_return" ? null : p.offense);
      const team = teamFor(game, side);
      out.set("touchdown", { team: side, title: `Touchdown ${team?.abbreviation ?? ""}`.trim(), detail: `${p.description}${conversion}` });
    }
    if (p.kind === "field_goal_good") {
      const side = p.scoringTeam ?? p.offense;
      out.set("field_goal", { team: side, title: `Field goal ${teamFor(game, side)?.abbreviation ?? ""}`.trim(), detail: p.description });
    }
    if (p.kind === "safety") out.set("safety", { team: p.scoringTeam, title: "Safety", detail: p.description });
    if (p.turnover === true || TURNOVER_KINDS.has(p.kind)) {
      const gaining = p.offense ? p.offense === "home" ? "away" : "home" : null;
      const how = p.kind === "interception" ? "Interception" : p.kind === "fumble_lost" ? "Fumble lost" : "Turnover";
      out.set("turnover", { team: gaining, title: `${how}: ${teamFor(game, gaining)?.abbreviation ?? "defense"} ball`, detail: p.description });
    }
    if (p.yards !== null && p.yards >= this.rules.bigPlayYards && GAIN_KINDS.has(p.kind) && !p.penalty) {
      out.set("big_play", { team: p.offense, title: `Big play: +${p.yards} yards${offense ? `, ${offense.abbreviation}` : ""}`, detail: p.description });
    }
    if (p.start?.down === 4 && SNAP_KINDS.has(p.kind)) {
      const converted = TOUCHDOWN_KINDS.has(p.kind) || p.end?.down === 1 && p.end?.spot.offense === p.offense && !p.possessionChanged;
      const failed = p.possessionChanged === true || TURNOVER_KINDS.has(p.kind);
      out.set("fourth_down_attempt", {
        team: p.offense,
        title: `4th-down try ${converted ? "converted" : failed ? "stopped" : ""}`.trim() + (offense ? `: ${offense.abbreviation}` : ""),
        detail: p.description
      });
    }
    if (p.review) out.set("review", { team: null, title: `Review: ${p.review.outcome === "unknown" ? "outcome not reported" : p.review.outcome}`, detail: p.description });
    return out;
  }
};

// server/push/webpush.ts
import { Buffer as Buffer2 } from "node:buffer";
import { createCipheriv, createDecipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes as randomBytes2, sign } from "node:crypto";
var CURVE = "prime256v1";
var PUBLIC_KEY_BYTES = 65;
var PRIVATE_KEY_BYTES = 32;
var AUTH_SECRET_BYTES = 16;
var SALT_BYTES = 16;
var TAG_BYTES = 16;
var HEADER_BYTES = SALT_BYTES + 4 + 1 + PUBLIC_KEY_BYTES;
var MIN_RECORD_SIZE = 18;
var MAX_RECORD_SIZE = 4294967295;
var DEFAULT_RECORD_SIZE = 4096;
var MAX_BODY_BYTES = 4096;
var MAX_PAYLOAD_BYTES = MAX_BODY_BYTES - HEADER_BYTES - 1 - TAG_BYTES;
var LAST_RECORD_DELIMITER = 2;
var MAX_VAPID_TTL_SECONDS = 24 * 60 * 60;
var DEFAULT_VAPID_TTL_SECONDS = 12 * 60 * 60;
var DEFAULT_MESSAGE_TTL_SECONDS = 60 * 60;
var DEFAULT_TIMEOUT_MS = 1e4;
var JWT_HEADER = Buffer2.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
var KEY_INFO_PREFIX = Buffer2.from("WebPush: info\0");
var CEK_INFO = Buffer2.from("Content-Encoding: aes128gcm\0");
var NONCE_INFO = Buffer2.from("Content-Encoding: nonce\0");
var URGENCIES = ["very-low", "low", "normal", "high"];
var TOPIC = /^[A-Za-z0-9_-]{1,32}$/;
var PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
var PUSH_SERVICE_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];
function fromBase64Url(value, label) {
  const text2 = typeof value === "string" ? value.replace(/=+$/, "") : "";
  if (!/^[A-Za-z0-9_-]+$/.test(text2)) throw new Error(`${label} must be a base64url string`);
  return Buffer2.from(text2, "base64url");
}
function decodeFixed(value, bytes, label) {
  const decoded = fromBase64Url(value, label);
  if (decoded.length !== bytes) throw new Error(`${label} must be ${bytes} bytes, not ${decoded.length}`);
  return decoded;
}
function decodePublicKey(value, label) {
  const decoded = decodeFixed(value, PUBLIC_KEY_BYTES, label);
  if (decoded[0] !== 4) throw new Error(`${label} must be an uncompressed P-256 point (0x04 first)`);
  return decoded;
}
function newKeyPair() {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return ecdh;
}
function keyPairFor(privateKey, label) {
  const ecdh = createECDH(CURVE);
  try {
    ecdh.setPrivateKey(privateKey);
  } catch {
    throw new Error(`${label} is not a valid P-256 private key`);
  }
  return ecdh;
}
function rawPrivateKey(ecdh) {
  const scalar = ecdh.getPrivateKey();
  return scalar.length === PRIVATE_KEY_BYTES ? scalar : Buffer2.concat([Buffer2.alloc(PRIVATE_KEY_BYTES - scalar.length), scalar]);
}
function sharedSecret(ecdh, peerPublicKey, label) {
  try {
    return ecdh.computeSecret(peerPublicKey);
  } catch {
    throw new Error(`${label} is not a point on the P-256 curve`);
  }
}
function parseEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Push endpoint must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Push endpoint must be an http or https URL");
  return url;
}
function generateVapidKeys() {
  const ecdh = newKeyPair();
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: rawPrivateKey(ecdh).toString("base64url") };
}
function assertSubject(subject) {
  const valid = typeof subject === "string" && (/^mailto:[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(subject) || /^https:\/\/\S+$/.test(subject) && URL.canParse(subject));
  if (!valid) throw new Error("VAPID subject must be a mailto: address or an https: URL");
}
function vapidHeaders(endpoint, keys, subject, nowSeconds = Math.floor(Date.now() / 1e3), ttlSeconds = DEFAULT_VAPID_TTL_SECONDS) {
  assertSubject(subject);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_VAPID_TTL_SECONDS) {
    throw new Error(`VAPID token lifetime must be a whole number of seconds from 1 to ${MAX_VAPID_TTL_SECONDS}`);
  }
  const publicKey = decodePublicKey(keys.publicKey, "VAPID public key");
  const privateKey = decodeFixed(keys.privateKey, PRIVATE_KEY_BYTES, "VAPID private key");
  if (!keyPairFor(privateKey, "VAPID private key").getPublicKey().equals(publicKey)) {
    throw new Error("VAPID public key does not belong to the private key");
  }
  const claims = { aud: parseEndpoint(endpoint).origin, exp: Math.floor(nowSeconds) + ttlSeconds, sub: subject };
  const signingInput = `${JWT_HEADER}.${Buffer2.from(JSON.stringify(claims)).toString("base64url")}`;
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33).toString("base64url"),
      d: privateKey.toString("base64url")
    },
    format: "jwk"
  });
  const signature = sign("sha256", Buffer2.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return { Authorization: `vapid t=${signingInput}.${signature.toString("base64url")}, k=${publicKey.toString("base64url")}` };
}
function hkdf(ikm, salt, info, length) {
  return Buffer2.from(hkdfSync("sha256", ikm, salt, info, length));
}
function contentKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt) {
  const ikm = hkdf(ecdhSecret, authSecret, Buffer2.concat([KEY_INFO_PREFIX, uaPublic, asPublic]), 32);
  return { cek: hkdf(ikm, salt, CEK_INFO, 16), nonce: hkdf(ikm, salt, NONCE_INFO, 12) };
}
function recordHeader(salt, recordSize, keyId) {
  const header = Buffer2.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, SALT_BYTES);
  header.writeUInt8(keyId.length, SALT_BYTES + 4);
  keyId.copy(header, SALT_BYTES + 5);
  return header;
}
function encryptPayload(plaintext, subscription, options = {}) {
  const payload = typeof plaintext === "string" ? Buffer2.from(plaintext, "utf8") : Buffer2.from(plaintext);
  const recordSize = options.recordSize ?? DEFAULT_RECORD_SIZE;
  if (!Number.isInteger(recordSize) || recordSize < MIN_RECORD_SIZE || recordSize > MAX_RECORD_SIZE) {
    throw new Error(`Record size must be a whole number from ${MIN_RECORD_SIZE} to ${MAX_RECORD_SIZE}`);
  }
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Push payload of ${payload.length} bytes is too large; the limit is ${MAX_PAYLOAD_BYTES} bytes`);
  }
  if (payload.length + 1 + TAG_BYTES > recordSize) {
    throw new Error(`Push payload of ${payload.length} bytes does not fit in one ${recordSize}-byte record`);
  }
  const uaPublic = decodePublicKey(subscription.p256dh, "Subscription p256dh key");
  const authSecret = decodeFixed(subscription.auth, AUTH_SECRET_BYTES, "Subscription auth secret");
  const salt = options.salt === void 0 ? randomBytes2(SALT_BYTES) : Buffer2.from(options.salt);
  if (salt.length !== SALT_BYTES) throw new Error(`Salt must be ${SALT_BYTES} bytes, not ${salt.length}`);
  const local = options.localPrivateKey === void 0 ? newKeyPair() : keyPairFor(decodeFixed(options.localPrivateKey, PRIVATE_KEY_BYTES, "Local private key"), "Local private key");
  const asPublic = local.getPublicKey();
  const { cek, nonce } = contentKeys(sharedSecret(local, uaPublic, "Subscription p256dh key"), authSecret, uaPublic, asPublic, salt);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer2.concat([cipher.update(payload), cipher.update(Buffer2.of(LAST_RECORD_DELIMITER)), cipher.final()]);
  return Buffer2.concat([recordHeader(salt, recordSize, asPublic), ciphertext, cipher.getAuthTag()]);
}
function buildPushRequest(subscription, payload, options) {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_MESSAGE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) throw new Error("Push TTL must be a whole number of seconds, 0 or more");
  const urgency = options.urgency ?? "normal";
  if (!URGENCIES.includes(urgency)) throw new Error(`Push urgency must be one of: ${URGENCIES.join(", ")}`);
  if (options.topic !== void 0 && !TOPIC.test(options.topic)) throw new Error("Push topic must be 1 to 32 base64url characters");
  const url = parseEndpoint(subscription.endpoint).href;
  const headers = {
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttlSeconds),
    Urgency: urgency,
    ...options.topic === void 0 ? {} : { Topic: options.topic },
    ...vapidHeaders(url, options.vapid, options.subject)
  };
  return { url, method: "POST", headers, body: encryptPayload(payload, subscription.keys) };
}
function isAllowedPushEndpoint(endpoint, extraHosts = []) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const { protocol, host, hostname, port } = url;
  if ((protocol === "https:" || protocol === "http:") && extraHosts.some((extra) => extra.toLowerCase() === host)) return true;
  if (protocol !== "https:" || port !== "") return false;
  return PUSH_SERVICE_HOSTS.includes(hostname) || PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => hostname.length > suffix.length && hostname.endsWith(suffix));
}
function hostOf(endpoint) {
  try {
    return new URL(endpoint).host || "an endpoint with no host";
  } catch {
    return "an endpoint that is not a URL";
  }
}
function retryAfterSeconds(value) {
  if (value === null) return void 0;
  if (/^\s*\d+\s*$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? void 0 : Math.max(0, Math.ceil((date - Date.now()) / 1e3));
}
function describeFailure(error) {
  const { message, cause } = error ?? {};
  const text2 = typeof message === "string" ? message : String(error);
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : "";
  return detail ? `${text2} (${detail})` : text2;
}
async function discardBody(res) {
  await res.body?.cancel().catch(() => void 0);
}
async function resultOf(res) {
  const { status } = res;
  if (status >= 200 && status < 300) {
    await discardBody(res);
    return { ok: true, status };
  }
  if (status === 404 || status === 410) {
    await discardBody(res);
    return { ok: false, status, retryable: false, gone: true };
  }
  if (status === 429 || status >= 500) {
    await discardBody(res);
    const wait = retryAfterSeconds(res.headers.get("retry-after"));
    return wait === void 0 ? { ok: false, status, retryable: true } : { ok: false, status, retryable: true, retryAfterSeconds: wait };
  }
  const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
  return { ok: false, status, retryable: false, error: detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}` };
}
async function sendPush(subscription, payload, options) {
  if (!isAllowedPushEndpoint(subscription.endpoint, options.allowHosts)) {
    throw new Error(`Refusing to send a push to ${hostOf(subscription.endpoint)}: it is not a known push service`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Push timeout must be a positive number of milliseconds");
  const request = buildPushRequest(subscription, payload, options);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual", signal: controller.signal });
    return await resultOf(res);
  } catch (e) {
    return { ok: false, status: 0, retryable: true, error: controller.signal.aborted ? `Timed out after ${timeoutMs}ms` : `Network error: ${describeFailure(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

// server/push/store.ts
var STORE_FILE = "push-subscriptions.json";
var STORE_VERSION = 1;
var MAX_TEAMS = 32;
var DEFAULT_MAX_SUBSCRIPTIONS = 1e4;
var MAX_ENDPOINT_LENGTH = 2048;
var TEAM_KEY = /^(nfl|cfb)-\d{1,6}$/;
var BASE64URL = /^[A-Za-z0-9_-]+$/;
var DEFAULT_DEBOUNCE_MS = 1e3;
function subscriptionId(endpoint) {
  return createHash("sha256").update(endpoint).digest("base64url").slice(0, 22);
}
function decodeBase64Url(value, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) return null;
  const text2 = value.replace(/=+$/, "");
  return BASE64URL.test(text2) ? Buffer.from(text2, "base64url") : null;
}
function onCurve(point) {
  try {
    ECDH.convertKey(point, "prime256v1", void 0, void 0, "uncompressed");
    return true;
  } catch {
    return false;
  }
}
function readKeys(value) {
  if (!isRecord(value)) return { error: "subscription.keys must be an object" };
  const p256dh = decodeBase64Url(value.p256dh, 128);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4 || !onCurve(p256dh)) {
    return { error: "subscription.keys.p256dh must be a 65-byte uncompressed P-256 public key in base64url" };
  }
  const auth = decodeBase64Url(value.auth, 64);
  if (!auth || auth.length !== 16) return { error: "subscription.keys.auth must be 16 bytes in base64url" };
  return { value: { p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url") } };
}
function readTeams(value, max = MAX_TEAMS) {
  if (!Array.isArray(value)) return { error: "teams must be an array of team keys" };
  const teams2 = /* @__PURE__ */ new Set();
  for (const team of value) {
    if (typeof team !== "string" || !TEAM_KEY.test(team)) return { error: "teams must hold only team keys such as nfl-2 or cfb-333" };
    teams2.add(team);
    if (teams2.size > max) return { error: `Choose at most ${max} teams` };
  }
  return teams2.size ? { value: [...teams2] } : { error: "Choose at least one team" };
}
function readKinds(value, allowed) {
  if (!Array.isArray(value)) return { error: "kinds must be an array of alert kinds" };
  const kinds = /* @__PURE__ */ new Set();
  for (const kind of value) {
    if (typeof kind !== "string" || !allowed.includes(kind)) return { error: `kinds may hold only: ${allowed.join(", ")}` };
    kinds.add(kind);
  }
  return kinds.size ? { value: [...kinds] } : { error: "Choose at least one kind of alert" };
}
var time = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function freeze(record) {
  Object.freeze(record.keys);
  Object.freeze(record.teams);
  Object.freeze(record.kinds);
  return Object.freeze(record);
}
async function writeAtomic(file, body) {
  await mkdir(dirname2(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes3(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", 384);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => void 0);
    throw e;
  }
}
var PushStore = class {
  records = /* @__PURE__ */ new Map();
  /** Subscriptions following each team, so the union of teams is cheap to read. */
  teamCounts = /* @__PURE__ */ new Map();
  file;
  max;
  kinds;
  allowEndpoint;
  debounceMs;
  now;
  log;
  timer = null;
  writing = null;
  dirty = false;
  rewrite = false;
  constructor(options) {
    this.file = options.cacheDir ? join2(options.cacheDir, STORE_FILE) : null;
    this.max = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
    this.kinds = options.kinds ?? ALERT_KINDS;
    this.allowEndpoint = options.allowEndpoint ?? ((endpoint) => isAllowedPushEndpoint(endpoint));
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {
    });
    this.load();
  }
  get size() {
    return this.records.size;
  }
  get(endpoint) {
    return this.records.get(endpoint) ?? null;
  }
  list() {
    return [...this.records.values()];
  }
  /** Every team at least one subscription follows, sorted. */
  teams() {
    return [...this.teamCounts.keys()].sort();
  }
  /** Adds a subscription, or replaces the keys, teams and kinds of the one with this endpoint. */
  upsert(input) {
    const checked = this.check(input);
    if ("error" in checked) return { ok: false, reason: "invalid", error: checked.error };
    const existing = this.records.get(checked.endpoint);
    if (!existing && this.records.size >= this.max) return { ok: false, reason: "full", error: "Push alerts are at capacity on this server" };
    const now = this.now();
    const record = existing ? { ...existing, keys: checked.keys, teams: checked.teams, kinds: checked.kinds, updatedAt: now, failures: 0 } : { id: subscriptionId(checked.endpoint), ...checked, createdAt: now, updatedAt: now, lastSuccessAt: null, failures: 0 };
    if (existing) this.drop(existing);
    this.put(record);
    this.changed();
    return { ok: true, record: this.records.get(record.endpoint), created: !existing };
  }
  remove(endpoint) {
    const record = this.records.get(endpoint);
    if (!record) return false;
    this.drop(record);
    this.changed();
    return true;
  }
  /**
   * Moves a subscription's teams and kinds to the subscription a browser made when it replaced the old one
   * (pushsubscriptionchange), and removes the old endpoint. The old endpoint must be known.
   */
  transfer(oldEndpoint, next) {
    const old = typeof oldEndpoint === "string" ? this.records.get(oldEndpoint) : void 0;
    if (!old) return { ok: false, reason: "unknown", error: "Unknown subscription" };
    const checked = this.check({ endpoint: next?.endpoint, keys: next?.keys, teams: old.teams, kinds: old.kinds });
    if ("error" in checked) return { ok: false, reason: "invalid", error: checked.error };
    const now = this.now();
    const target = this.records.get(checked.endpoint);
    this.drop(old);
    if (target && target !== old) this.drop(target);
    const base = target ?? old;
    this.put({
      ...base,
      id: subscriptionId(checked.endpoint),
      ...checked,
      createdAt: Math.min(old.createdAt, base.createdAt),
      updatedAt: now,
      lastSuccessAt: target ? target.lastSuccessAt : checked.endpoint === old.endpoint ? old.lastSuccessAt : null,
      failures: 0
    });
    this.changed();
    return { ok: true, record: this.records.get(checked.endpoint), created: !target };
  }
  /** A delivery the push service accepted: failures in a row start again from zero. */
  markSuccess(endpoint, at2 = this.now()) {
    const record = this.records.get(endpoint);
    if (!record) return;
    this.records.set(endpoint, freeze({ ...record, lastSuccessAt: at2, failures: 0 }));
    if (record.failures > 0) this.changed();
    else this.dirty = true;
  }
  /** A delivery the push service refused. Returns the failures in a row, or 0 for an unknown endpoint. */
  markFailure(endpoint) {
    const record = this.records.get(endpoint);
    if (!record) return 0;
    const failures = record.failures + 1;
    this.records.set(endpoint, freeze({ ...record, failures }));
    this.changed();
    return failures;
  }
  /** Saves any pending change now, after a save already under way. For shutdown and tests. */
  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.writing) await this.writing;
    if (this.dirty && this.file) {
      this.rewrite = true;
      await this.save();
    }
  }
  // ------------------------------------------------------------ records
  check(input) {
    if (!isRecord(input)) return { error: "A subscription must be an object" };
    const { endpoint } = input;
    if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_LENGTH || !this.allowEndpoint(endpoint)) return { error: "The endpoint is not a known push service" };
    const keys = readKeys(input.keys);
    if ("error" in keys) return keys;
    const teams2 = readTeams(input.teams);
    if ("error" in teams2) return teams2;
    const kinds = readKinds(input.kinds, this.kinds);
    if ("error" in kinds) return kinds;
    return { endpoint, keys: keys.value, teams: teams2.value, kinds: kinds.value };
  }
  put(record) {
    this.records.set(record.endpoint, freeze(record));
    for (const team of record.teams) this.teamCounts.set(team, (this.teamCounts.get(team) ?? 0) + 1);
  }
  drop(record) {
    this.records.delete(record.endpoint);
    for (const team of record.teams) {
      const count = (this.teamCounts.get(team) ?? 0) - 1;
      if (count > 0) this.teamCounts.set(team, count);
      else this.teamCounts.delete(team);
    }
  }
  /** A saved record, rebuilt from its checked fields alone, or null when any of them fails. */
  readRecord(value) {
    if (!isRecord(value)) return null;
    const checked = this.check(value);
    if ("error" in checked) return null;
    const createdAt = time(value.createdAt);
    const updatedAt = time(value.updatedAt);
    const lastSuccessAt = value.lastSuccessAt === null ? null : time(value.lastSuccessAt);
    const failures = value.failures;
    if (createdAt === null || updatedAt === null || value.lastSuccessAt !== null && lastSuccessAt === null) return null;
    if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) return null;
    return { id: subscriptionId(checked.endpoint), ...checked, createdAt, updatedAt, lastSuccessAt, failures };
  }
  load() {
    if (!this.file) return;
    let text2;
    try {
      text2 = readFileSync2(this.file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") this.log(`could not read saved push subscriptions: ${e.message}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text2);
    } catch {
      this.log("saved push subscriptions are not valid JSON; starting with none");
      return;
    }
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.subscriptions)) {
      this.log(`saved push subscriptions are not schema version ${STORE_VERSION}; starting with none`);
      return;
    }
    let dropped = 0;
    for (const entry of parsed.subscriptions) {
      const record = this.readRecord(entry);
      const existing = record ? this.records.get(record.endpoint) : void 0;
      if (!record || !existing && this.records.size >= this.max) {
        dropped++;
        continue;
      }
      if (existing) {
        dropped++;
        if (record.updatedAt < existing.updatedAt) continue;
        this.drop(existing);
      }
      this.put(record);
    }
    if (dropped) {
      this.log(`dropped ${dropped} saved push subscription${dropped === 1 ? "" : "s"} that did not validate or repeated an endpoint`);
      this.changed();
    }
  }
  // ------------------------------------------------------------ saving
  changed() {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.debounceMs);
    this.timer.unref?.();
  }
  /** One save at a time. A save asked for while one runs is folded into a second pass once it finishes. */
  save() {
    const file = this.file;
    if (!file) return Promise.resolve();
    if (this.writing) {
      this.rewrite = true;
      return this.writing;
    }
    this.writing = (async () => {
      do {
        this.rewrite = false;
        if (!this.dirty) break;
        this.dirty = false;
        const body = JSON.stringify({ version: STORE_VERSION, subscriptions: [...this.records.values()] });
        try {
          await writeAtomic(file, body);
        } catch (e) {
          this.dirty = true;
          this.log(`could not save push subscriptions: ${e.message}`);
          break;
        }
      } while (this.rewrite);
    })().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }
};

// server/push/routes.ts
var WRITES = /* @__PURE__ */ new Set(["/subscribe", "/unsubscribe", "/resubscribe", "/test"]);
var asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
function createPushRoutes(options) {
  const writes = new RateLimiter(30, 10 * 6e4, options.now);
  const reason = options.reason ?? "Push alerts are not available on this server";
  return async (req, res, url) => {
    if (!url.pathname.startsWith("/api/push/")) return false;
    const service = options.service;
    const path = url.pathname.slice("/api/push".length);
    if (path === "/key") {
      if (req.method !== "GET" && req.method !== "HEAD") send(res, 405, { error: "Method not allowed" });
      else send(res, 200, { available: !!service, ...service ? { publicKey: service.publicKey } : { reason }, kinds: PUSH_KINDS, defaults: DEFAULT_PUSH_KINDS, maxTeams: MAX_TEAMS });
      return true;
    }
    if (!WRITES.has(path)) {
      send(res, 404, { error: "Not found" });
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!service) {
      send(res, 503, { error: reason });
      return true;
    }
    if (!sameOrigin(req)) {
      send(res, 403, { error: "Cross-site requests are not allowed" });
      return true;
    }
    const wait = writes.take(clientAddress(req, options.trustProxy === true));
    if (wait) {
      send(res, 429, { error: "Too many requests; try again shortly" }, { "retry-after": String(wait) });
      return true;
    }
    let body;
    try {
      body = asObject(await readBody(req, 4096));
    } catch {
      send(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const allowed = (endpoint) => typeof endpoint === "string" && isAllowedPushEndpoint(endpoint, service.allowHosts);
    if (path === "/subscribe") {
      const subscription = asObject(body.subscription);
      const endpoint = subscription.endpoint;
      if (!allowed(endpoint)) {
        send(res, 403, { error: "The subscription endpoint is not a known push service" });
        return true;
      }
      const result2 = service.subscribe({ endpoint, keys: subscription.keys, teams: body.teams, kinds: body.kinds });
      if (result2.ok) send(res, 200, { ok: true, teams: result2.record.teams.length, kinds: result2.record.kinds.length });
      else send(res, result2.reason === "full" ? 503 : 400, { error: result2.error });
      return true;
    }
    if (path === "/unsubscribe") {
      send(res, 200, { ok: true, removed: typeof body.endpoint === "string" && service.unsubscribe(body.endpoint) });
      return true;
    }
    if (path === "/resubscribe") {
      const subscription = asObject(body.subscription);
      const endpoint = subscription.endpoint;
      if (!allowed(endpoint)) {
        send(res, 403, { error: "The subscription endpoint is not a known push service" });
        return true;
      }
      const result2 = service.resubscribe(typeof body.oldEndpoint === "string" ? body.oldEndpoint : "", { endpoint, keys: subscription.keys });
      if (result2.ok) send(res, 200, { ok: true });
      else send(res, result2.reason === "unknown" ? 404 : result2.reason === "full" ? 503 : 400, { error: result2.error });
      return true;
    }
    const result = await service.sendTest(typeof body.endpoint === "string" ? body.endpoint : "");
    if (result.ok) send(res, 200, { ok: true });
    else if (result.reason === "unknown") send(res, 404, { error: result.error });
    else if (result.reason === "cooldown") send(res, 429, { error: result.error }, { "retry-after": String(result.retryAfterSeconds) });
    else send(res, result.reason === "gone" ? 410 : 502, { error: result.error });
    return true;
  };
}

// server/push/service.ts
import { randomUUID as randomUUID3 } from "node:crypto";
var PUSH_RULES = {
  ...DEFAULT_ALERT_RULES,
  scope: "favorites",
  enabled: Object.fromEntries(ALERT_KINDS.map((kind) => [kind, PUSH_KINDS.includes(kind)]))
};
var WATCH_DIVISIONS = ["FBS", "FCS"];
var MAX_MONITORED = 64;
var LATE_NIGHT_END_HOUR = 6;
var ALERT_TTL_SECONDS = 60 * 60;
var TEST_TTL_SECONDS = 10 * 60;
var MOMENT_MEMORY_MS = 3 * 60 * 6e4;
var MAX_MOMENTS = 2e3;
var MAX_QUEUED = 5e4;
var OUTAGE_GAP_MS = 2 * 6e4;
var MAX_TEAM_NAMES = 4e3;
var EASTERN_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
function easternHour(ms) {
  const hour = Number(EASTERN_HOUR.formatToParts(new Date(ms)).find((part) => part.type === "hour")?.value);
  return Number.isFinite(hour) ? hour : 12;
}
var parseTime = (iso3) => iso3 ? Date.parse(iso3) : Number.NaN;
var involves = (game, teams2) => teams2.has(game.home.key) || teams2.has(game.away.key);
function hostOf2(endpoint) {
  try {
    return new URL(endpoint).host || "an unknown host";
  } catch {
    return "an unknown host";
  }
}
function scrub(text2, endpoint) {
  let out = text2.split(endpoint).join("<endpoint>");
  try {
    const { pathname } = new URL(endpoint);
    if (pathname.length > 1) out = out.split(pathname).join("<path>");
  } catch {
  }
  return out;
}
function listText(names, more) {
  const parts = more > 0 ? [...names, `${more} more ${more === 1 ? "team" : "teams"}`] : names;
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
var fits = (payload) => Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES;
function shorten(payload, field) {
  const chars = Array.from(payload[field]);
  const cut = (n) => {
    const text2 = `${chars.slice(0, n).join("")}\u2026`;
    return field === "body" ? { ...payload, body: text2 } : { ...payload, title: text2 };
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
function encodePayload(payload) {
  let fitted = payload;
  if (!fits(fitted)) fitted = shorten(fitted, "body");
  if (!fits(fitted)) fitted = shorten(fitted, "title");
  return JSON.stringify(fitted);
}
function momentPayload(moment, correction) {
  const { alert, game } = moment;
  const score = scoreText(game);
  return {
    v: 1,
    title: `${moment.replay ? "Replay: " : ""}${correction ? "Correction: " : ""}${alert.title}`,
    // Some moments already carry the score line; it is not repeated.
    body: alert.detail.includes(score) ? alert.detail : [alert.detail, score].filter(Boolean).join(" \xB7 "),
    tag: alert.id,
    url: `/game/${encodeURIComponent(alert.gameId)}`,
    gameId: alert.gameId,
    kind: alert.kind,
    at: moment.at,
    replay: moment.replay
  };
}
var PushService = class {
  publicKey;
  engine;
  store;
  vapid;
  subject;
  hosts;
  fetchImpl;
  now;
  log;
  concurrency;
  limit;
  windowMs;
  retryDelayMs;
  maxFailures;
  testCooldownMs;
  checkIntervalMs;
  timeoutMs;
  alerts = new AlertEngine(PUSH_RULES);
  /** Watch client ids nobody can guess, so no browser stream can take a watch over by reusing its id. */
  instance = randomUUID3();
  running = false;
  checkTimer = null;
  syncing = false;
  syncAgain = false;
  watches = /* @__PURE__ */ new Map();
  /** The latest summary of each game on a watched day, and the days that list it. */
  games = /* @__PURE__ */ new Map();
  gameDates = /* @__PURE__ */ new Map();
  /** Games the alert engine holds memory for. */
  observed = /* @__PURE__ */ new Set();
  /** Live games of subscribed teams left out of the engine's monitored list by its limit. */
  unmonitored = /* @__PURE__ */ new Set();
  /** Feeds that are failing, with their last success before the failures (NaN when there was none). */
  feedDown = /* @__PURE__ */ new Map();
  teamNames = /* @__PURE__ */ new Map();
  moments = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  ready = [];
  inFlight = /* @__PURE__ */ new Set();
  queued = 0;
  active = 0;
  retryTimers = /* @__PURE__ */ new Set();
  recent = /* @__PURE__ */ new Map();
  tests = /* @__PURE__ */ new Map();
  idleWaiters = [];
  sent = 0;
  failed = 0;
  dropped = 0;
  lastSendAt = null;
  constructor(options) {
    this.engine = options.engine;
    this.store = options.store;
    this.vapid = options.vapid;
    this.subject = options.subject;
    this.publicKey = options.vapid.publicKey;
    this.hosts = [...options.allowHosts ?? []];
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {
    });
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.limit = options.perSubscriptionLimit ?? 12;
    this.windowMs = options.perSubscriptionWindowMs ?? 5 * 6e4;
    this.retryDelayMs = options.retryDelayMs ?? 3e4;
    this.maxFailures = options.maxFailures ?? 5;
    this.testCooldownMs = options.testCooldownMs ?? 3e4;
    this.checkIntervalMs = options.checkIntervalMs ?? 6e4;
    this.timeoutMs = options.timeoutMs;
  }
  /** Exact host:port entries allowed besides the known push services. */
  get allowHosts() {
    return [...this.hosts];
  }
  // ------------------------------------------------------------ lifecycle
  start() {
    if (this.running) return;
    this.running = true;
    this.checkTimer = setInterval(() => this.tick(), this.checkIntervalMs);
    this.checkTimer.unref?.();
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
  idle() {
    if (this.active === 0 && this.queued === 0) return Promise.resolve();
    return new Promise((resolve4) => this.idleWaiters.push(resolve4));
  }
  stats() {
    const watched = /* @__PURE__ */ new Set();
    for (const watch of this.watches.values()) for (const id of watch.monitored) watched.add(id);
    return {
      subscriptions: this.store.size,
      watchedGames: watched.size,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      lastSendAt: this.lastSendAt === null ? null : new Date(this.lastSendAt).toISOString()
    };
  }
  // ------------------------------------------------------------ subscriptions
  subscribe(input) {
    const result = this.store.upsert(input);
    if (result.ok) this.refresh();
    return result;
  }
  unsubscribe(endpoint) {
    const removed = typeof endpoint === "string" && this.store.remove(endpoint);
    if (removed) this.refresh();
    return removed;
  }
  /** Moves teams and kinds from a replaced subscription to its successor. */
  resubscribe(oldEndpoint, next) {
    const result = this.store.transfer(oldEndpoint, next);
    if (result.ok) this.refresh();
    return result;
  }
  /** The "alerts are on" notification for one subscription, at most once per cooldown. */
  async sendTest(endpoint) {
    const record = typeof endpoint === "string" ? this.store.get(endpoint) : null;
    if (!record) return { ok: false, reason: "unknown", error: "This browser is not subscribed to push alerts" };
    const now = this.now();
    const last = this.tests.get(record.id);
    if (last !== void 0 && last <= now && now - last < this.testCooldownMs) {
      const retryAfterSeconds2 = Math.max(1, Math.ceil((last + this.testCooldownMs - now) / 1e3));
      return { ok: false, reason: "cooldown", error: "A test notification was just sent; try again shortly", retryAfterSeconds: retryAfterSeconds2 };
    }
    this.tests.set(record.id, now);
    const result = await this.attempt(record, encodePayload(this.testPayload(record)), TEST_TTL_SECONDS, "high");
    if (result.ok) {
      this.succeeded(record);
      return { ok: true };
    }
    this.failedWith(record, result);
    if ("gone" in result) return { ok: false, reason: "gone", error: "The push service no longer accepts this subscription. Turn alerts off and on again" };
    const error = result.retryable ? "The push service is not taking messages right now; try again shortly" : `The push service refused the test notification${result.status ? ` (HTTP ${result.status})` : ""}`;
    return { ok: false, reason: "refused", error };
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
      for (let pass = 0; pass < 5; pass++) {
        this.syncAgain = false;
        this.sync();
        if (!this.syncAgain) break;
      }
    } catch (e) {
      this.log(`push watch update failed: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }
  tick() {
    const now = this.now();
    for (const [id, times] of this.recent) if (!times.some((t) => t <= now && now - t < this.windowMs)) this.recent.delete(id);
    for (const [id, at2] of this.tests) if (at2 > now || now - at2 >= this.testCooldownMs) this.tests.delete(id);
    this.refresh();
  }
  sync() {
    const teams2 = new Set(this.store.teams());
    this.alerts.setContext({ favorites: [...teams2], monitored: [], muted: [] });
    const dates = this.running && teams2.size > 0 ? this.wantedDates() : [];
    for (const watch of [...this.watches.values()]) if (!dates.includes(watch.date)) this.unwatch(watch);
    for (const id of [...this.observed]) {
      const game = this.games.get(id);
      if (!game || !involves(game, teams2)) this.forget(id);
    }
    for (const [id, game] of this.games) if (!this.observed.has(id) && involves(game, teams2)) this.observe(game, this.detailFor(id), false);
    this.unmonitored = /* @__PURE__ */ new Set();
    for (const date of dates) {
      const interest = this.interestFor(date, teams2);
      const key = JSON.stringify(interest);
      const watch = this.watches.get(date);
      if (!watch) {
        const created = { date, clientId: `push-${this.instance}-${date}`, disconnect: null, interestKey: key, monitored: interest.monitored };
        this.watches.set(date, created);
        created.disconnect = this.engine.connect(created.clientId, interest, (message) => this.onMessage(created, message));
      } else if (key !== watch.interestKey) {
        watch.interestKey = key;
        watch.monitored = interest.monitored;
        if (!this.engine.setInterest(watch.clientId, interest)) {
          this.unwatch(watch);
          this.syncAgain = true;
        }
      }
    }
  }
  wantedDates() {
    const today = this.engine.today();
    return easternHour(this.engine.clock()) < LATE_NIGHT_END_HOUR ? [today, shiftDateKey(today, -1)] : [today];
  }
  interestFor(date, teams2) {
    let live = [];
    for (const [id, dates] of this.gameDates) {
      const game = this.games.get(id);
      if (game && dates.has(date) && isLiveOrPaused(game.status.kind) && involves(game, teams2)) live.push(id);
    }
    live.sort();
    if (live.length > MAX_MONITORED) {
      const followers = /* @__PURE__ */ new Map();
      for (const record of this.store.list()) for (const team of record.teams) followers.set(team, (followers.get(team) ?? 0) + 1);
      const weight = (id) => {
        const game = this.games.get(id);
        return (followers.get(game.home.key) ?? 0) + (followers.get(game.away.key) ?? 0);
      };
      live.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
      for (const id of live.slice(MAX_MONITORED)) this.unmonitored.add(id);
      live = live.slice(0, MAX_MONITORED).sort();
    }
    return { date, divisions: [...WATCH_DIVISIONS], focus: [], visible: [], monitored: live, alertsAllGames: false };
  }
  unwatch(watch) {
    this.watches.delete(watch.date);
    watch.disconnect?.();
    for (const id of [...this.gameDates.keys()]) this.dropFromDate(id, watch.date);
    for (const key of [...this.feedDown.keys()]) if (key.startsWith(`slate|${watch.date}|`)) this.feedDown.delete(key);
  }
  dropFromDate(id, date) {
    const dates = this.gameDates.get(id);
    if (!dates || !dates.delete(date) || dates.size) return;
    this.gameDates.delete(id);
    this.games.delete(id);
    this.feedDown.delete(`detail|${id}`);
    this.forget(id);
  }
  forget(id) {
    if (this.observed.delete(id)) this.alerts.forget(id);
  }
  detailFor(id) {
    return this.engine.peekDetail(id)?.detail ?? null;
  }
  onMessage(watch, message) {
    if (!this.running || this.watches.get(watch.date) !== watch) return;
    try {
      const teams2 = new Set(this.store.teams());
      switch (message.type) {
        case "slate": {
          const gaps = this.slateGaps(watch.date, message.snapshot.freshness);
          const present = new Set(message.snapshot.games.map((game) => game.id));
          for (const [id, dates] of [...this.gameDates]) if (dates.has(watch.date) && !present.has(id)) this.dropFromDate(id, watch.date);
          for (const game of message.snapshot.games) this.update(watch.date, game, teams2, gaps[game.league]);
          break;
        }
        case "slate-delta": {
          const gaps = this.slateGaps(watch.date, message.freshness);
          for (const id of message.removed) this.dropFromDate(id, watch.date);
          for (const game of message.upserts) this.update(watch.date, game, teams2, gaps[game.league]);
          break;
        }
        case "detail":
        case "detail-delta": {
          const gap = this.feedGap(`detail|${message.gameId}`, message.freshness);
          const detail = this.detailFor(message.gameId) ?? (message.type === "detail" ? message.detail : null);
          if (detail) this.update(null, detail.summary, teams2, gap, detail);
          break;
        }
        case "detail-freshness":
          this.feedGap(`detail|${message.gameId}`, message.freshness);
          break;
      }
    } catch (e) {
      this.log(`could not use an engine update for push alerts: ${e.message}`);
    }
    this.refresh();
  }
  slateGaps(date, freshness) {
    return { nfl: this.feedGap(`slate|${date}|nfl`, freshness?.nfl), cfb: this.feedGap(`slate|${date}|cfb`, freshness?.cfb) };
  }
  /** Whether this update ends a run of failures longer than OUTAGE_GAP_MS for its feed, so what it brings may be old news. */
  feedGap(key, freshness) {
    if (!freshness) return false;
    if (freshness.consecutiveFailures > 0) {
      if (!this.feedDown.has(key)) this.feedDown.set(key, parseTime(freshness.lastSuccessAt));
      return false;
    }
    const since = this.feedDown.get(key);
    if (since === void 0) return false;
    this.feedDown.delete(key);
    return Number.isFinite(since) && parseTime(freshness.lastSuccessAt) - since > OUTAGE_GAP_MS;
  }
  /** Records a game on a watched day (or, with no day, detail for a game already on one) and observes it when a subscribed team plays. */
  update(date, incoming, teams2, gap, detail) {
    let dates = this.gameDates.get(incoming.id);
    if (!dates) {
      if (date === null) return;
      dates = /* @__PURE__ */ new Set();
      this.gameDates.set(incoming.id, dates);
    }
    if (date !== null) dates.add(date);
    const previous = this.games.get(incoming.id);
    const game = previous ? mergeSummaries(previous, incoming) : incoming;
    this.games.set(game.id, game);
    if (this.teamNames.size > MAX_TEAM_NAMES) this.teamNames.clear();
    for (const team of [game.home, game.away]) if (team.abbreviation) this.teamNames.set(team.key, team.abbreviation);
    if (involves(game, teams2)) this.observe(game, detail ?? this.detailFor(game.id), gap);
  }
  observe(game, detail, gap) {
    const detailExpected = detail !== null || game.coverage.level !== "score-only" && isLiveOrPaused(game.status.kind) && !this.unmonitored.has(game.id);
    const at2 = this.engine.clock();
    const changes = this.alerts.observe(game, detail, at2, { gap, detailExpected });
    this.observed.add(game.id);
    for (const change of changes) this.onChange(change, game, at2);
  }
  // ------------------------------------------------------------ fan-out
  onChange(change, game, at2) {
    const { alert } = change;
    if (!PUSH_KINDS.includes(alert.kind)) return;
    if (change.type === "created") {
      if (alert.late && alert.kind !== "final") return;
      const moment2 = { alert, game, at: at2, replay: this.engine.mode === "replay", since: this.now(), delivered: /* @__PURE__ */ new Map(), sending: /* @__PURE__ */ new Set() };
      this.remember(moment2);
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
    const newStatus = alert.status !== "active" && alert.status !== moment.alert.status;
    moment.alert = alert;
    moment.game = game;
    moment.at = at2;
    if (!newStatus) return;
    const owed = /* @__PURE__ */ new Set([...moment.delivered.keys(), ...moment.sending]);
    if (!owed.size) return;
    for (const record of this.store.list()) {
      if (owed.has(record.id)) this.enqueue({ subscriptionId: record.id, endpoint: record.endpoint, alertId: alert.id, correction: true, retried: false });
    }
  }
  remember(moment) {
    this.moments.delete(moment.alert.id);
    this.moments.set(moment.alert.id, moment);
    const now = this.now();
    for (const [id, old] of this.moments) {
      if (this.moments.size <= MAX_MOMENTS && now - old.since < MOMENT_MEMORY_MS) break;
      this.moments.delete(id);
    }
  }
  /** Counts one alert against a subscription's cap. False when the cap is reached. */
  takeSlot(id) {
    const now = this.now();
    const times = (this.recent.get(id) ?? []).filter((t) => t <= now && now - t < this.windowMs);
    const allowed = times.length < this.limit;
    if (allowed) times.push(now);
    this.recent.set(id, times);
    return allowed;
  }
  testPayload(record) {
    const names = record.teams.map((team) => this.teamNames.get(team)).filter((name) => Boolean(name));
    const shown = names.slice(0, 6);
    return {
      v: 1,
      title: "Gridiron alerts are on",
      body: shown.length ? `You will get alerts for ${listText(shown, record.teams.length - shown.length)}.` : "You will get alerts for your favorite teams.",
      tag: "gridiron-test",
      url: "/",
      gameId: null,
      kind: "test",
      at: this.now(),
      replay: false
    };
  }
  // ------------------------------------------------------------ delivery
  enqueue(job) {
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
  pump() {
    while (this.active < this.concurrency && this.ready.length) {
      const id = this.ready.shift();
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
  settle() {
    if (this.active === 0 && this.queued === 0) for (const resolve4 of this.idleWaiters.splice(0)) resolve4();
  }
  async run(job) {
    try {
      const moment = this.moments.get(job.alertId);
      const record = this.store.get(job.endpoint);
      if (!moment || !record || record.id !== job.subscriptionId) return;
      const { status, priority } = moment.alert;
      const seen = moment.delivered.get(record.id);
      if (job.correction ? seen === void 0 || seen === status : seen !== void 0 || status === "withdrawn") return;
      const payload = encodePayload(momentPayload(moment, job.correction));
      moment.sending.add(record.id);
      let result;
      try {
        result = await this.attempt(record, payload, ALERT_TTL_SECONDS, priority === 1 ? "high" : "normal");
      } finally {
        moment.sending.delete(record.id);
      }
      if (result.ok) {
        moment.delivered.set(record.id, status);
        this.succeeded(record);
        return;
      }
      if (result.retryable && !job.retried) {
        const waitMs = Math.max(("retryAfterSeconds" in result ? result.retryAfterSeconds ?? 0 : 0) * 1e3, this.retryDelayMs);
        if (waitMs < ALERT_TTL_SECONDS * 1e3) {
          this.retryLater(job, waitMs);
          return;
        }
      }
      this.failedWith(record, result);
    } catch (e) {
      this.failed++;
      this.log(`push delivery failed unexpectedly: ${e.message}`);
    }
  }
  retryLater(job, waitMs) {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.enqueue({ ...job, retried: true });
    }, waitMs);
    timer.unref?.();
    this.retryTimers.add(timer);
  }
  /** One POST to the push service. Inputs sendPush refuses outright come back as a rejection instead of an exception. */
  async attempt(record, payload, ttlSeconds, urgency) {
    try {
      return await sendPush({ endpoint: record.endpoint, keys: record.keys }, payload, {
        vapid: this.vapid,
        subject: this.subject,
        ttlSeconds,
        urgency,
        fetch: this.fetchImpl,
        allowHosts: this.hosts,
        timeoutMs: this.timeoutMs
      });
    } catch (e) {
      return { ok: false, status: 0, retryable: false, error: e.message };
    }
  }
  succeeded(record) {
    this.sent++;
    this.lastSendAt = this.now();
    this.store.markSuccess(record.endpoint);
  }
  /** A send that did not arrive. Gone is removed at once; a refusal counts toward removal; failing to reach the service does not. */
  failedWith(record, result) {
    this.failed++;
    const host = hostOf2(record.endpoint);
    if ("gone" in result) {
      if (this.store.remove(record.endpoint)) this.log(`removed a push subscription at ${host}: the push service says it is gone (HTTP ${result.status})`);
      this.refresh();
      return;
    }
    const reason = "error" in result ? scrub(result.error, record.endpoint) : `HTTP ${result.status}`;
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
};

// server/push/vapid.ts
import { createECDH as createECDH2, randomBytes as randomBytes4 } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync3, rmSync, writeSync } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";
var VAPID_FILE = "vapid.json";
var DEFAULT_VAPID_SUBJECT = "https://labs.johnjayasankar.com/";
var FILE_VERSION = 1;
var SUBJECT = /^mailto:[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
function decode(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const text2 = value.trim().replace(/=+$/, "");
  return /^[A-Za-z0-9_-]+$/.test(text2) ? Buffer.from(text2, "base64url") : null;
}
function checkPair(publicKey, privateKey, names) {
  const pub = decode(publicKey);
  if (!pub || pub.length !== 65 || pub[0] !== 4) return { error: `${names.publicKey} must be a 65-byte uncompressed P-256 public key in base64url` };
  const priv = decode(privateKey);
  if (!priv || priv.length !== 32) return { error: `${names.privateKey} must be a 32-byte P-256 private key in base64url` };
  try {
    const ecdh = createECDH2("prime256v1");
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) return { error: `${names.publicKey} does not belong to ${names.privateKey}` };
  } catch {
    return { error: `${names.privateKey} is not a valid P-256 private key` };
  }
  return { keys: { publicKey: pub.toString("base64url"), privateKey: priv.toString("base64url") } };
}
var code = (e) => e.code ?? "error";
function readKeyFile(file) {
  let text2;
  try {
    text2 = readFileSync3(file, "utf8");
  } catch (e) {
    return code(e) === "ENOENT" ? null : { error: `${VAPID_FILE} in the cache directory could not be read (${code(e)})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text2);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed) || parsed.version !== FILE_VERSION) {
    return { error: `${VAPID_FILE} in the cache directory is not a version ${FILE_VERSION} key file. Fix or remove it; new keys stop existing subscriptions` };
  }
  const pair = checkPair(parsed.publicKey, parsed.privateKey, { publicKey: `publicKey in ${VAPID_FILE}`, privateKey: `privateKey in ${VAPID_FILE}` });
  return "error" in pair ? { error: `${pair.error}. Fix or remove the file; new keys stop existing subscriptions` } : pair;
}
function writeKeyFile(file, keys) {
  mkdirSync2(dirname3(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes4(6).toString("hex")}.tmp`;
  const body = `${JSON.stringify({ version: FILE_VERSION, publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`;
  try {
    const fd = openSync(temp, "wx", 384);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temp, file);
    return "written";
  } catch (e) {
    if (code(e) === "EEXIST") return "exists";
    throw e;
  } finally {
    rmSync(temp, { force: true });
  }
}
function loadVapid(options) {
  const { env, cacheDir } = options;
  const subject = env.GRIDIRON_VAPID_SUBJECT?.trim() || DEFAULT_VAPID_SUBJECT;
  if (!SUBJECT.test(subject) && !(/^https:\/\/\S+$/.test(subject) && URL.canParse(subject))) {
    return { error: "GRIDIRON_VAPID_SUBJECT must be an https: URL or a mailto: address" };
  }
  const finish = (keys, source) => {
    try {
      vapidHeaders("https://fcm.googleapis.com/", keys, subject);
    } catch (e) {
      return { error: e.message };
    }
    return { keys, subject, source };
  };
  const envPublic = env.GRIDIRON_VAPID_PUBLIC_KEY?.trim();
  const envPrivate = env.GRIDIRON_VAPID_PRIVATE_KEY?.trim();
  if (envPublic || envPrivate) {
    if (!envPublic || !envPrivate) return { error: "Set both GRIDIRON_VAPID_PUBLIC_KEY and GRIDIRON_VAPID_PRIVATE_KEY, or neither" };
    const pair = checkPair(envPublic, envPrivate, { publicKey: "GRIDIRON_VAPID_PUBLIC_KEY", privateKey: "GRIDIRON_VAPID_PRIVATE_KEY" });
    return "error" in pair ? pair : finish(pair.keys, "env");
  }
  if (!cacheDir) {
    return { error: "Push alerts need VAPID keys: set GRIDIRON_VAPID_PUBLIC_KEY and GRIDIRON_VAPID_PRIVATE_KEY, or keep the cache directory on so keys can be generated" };
  }
  const file = join3(cacheDir, VAPID_FILE);
  const saved = readKeyFile(file);
  if (saved) return "error" in saved ? saved : finish(saved.keys, "file");
  const generated = generateVapidKeys();
  try {
    if (writeKeyFile(file, generated) === "written") return finish(generated, "generated");
  } catch (e) {
    return { error: `Generated VAPID keys could not be saved in the cache directory (${code(e)})` };
  }
  const raced = readKeyFile(file);
  if (!raced) return { error: `${VAPID_FILE} in the cache directory disappeared while it was being created` };
  return "error" in raced ? raced : finish(raced.keys, "file");
}

// server/push/index.ts
function unavailablePush(reason, trustProxy = false) {
  return {
    routes: createPushRoutes({ service: null, reason, trustProxy }),
    health: () => ({ available: false, reason }),
    start() {
    },
    async stop() {
    }
  };
}
function setupPush(options) {
  const { engine: engine2, env, cacheDir, production, trustProxy } = options;
  const log = options.log ?? ((message) => console.warn(`[push] ${message}`));
  if (env.GRIDIRON_PUSH === "off") return unavailablePush("Push alerts are turned off on this server", trustProxy);
  if (engine2.mode === "replay" && env.GRIDIRON_PUSH_REPLAY !== "1") return unavailablePush("Push alerts are sent for live games only", trustProxy);
  const vapid = loadVapid({ env, cacheDir });
  if ("error" in vapid) {
    log(`push alerts are unavailable: ${vapid.error}`);
    return unavailablePush(`Push alerts are unavailable on this server: ${vapid.error}`, trustProxy);
  }
  if (vapid.source === "generated") log("generated VAPID keys in the cache directory; keep that directory so existing subscriptions keep working");
  const allowHosts = production ? [] : (env.GRIDIRON_PUSH_ALLOW_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  const store = new PushStore({ cacheDir, kinds: PUSH_KINDS, allowEndpoint: (endpoint) => isAllowedPushEndpoint(endpoint, allowHosts), log });
  const service = new PushService({ engine: engine2, store, vapid: vapid.keys, subject: vapid.subject, allowHosts, log });
  return {
    routes: createPushRoutes({ service, trustProxy }),
    health: () => ({ available: true, ...service.stats() }),
    start: () => service.start(),
    async stop() {
      service.stop();
      await Promise.race([service.idle(), new Promise((resolve4) => setTimeout(resolve4, 1500).unref())]);
      await store.flush();
    }
  };
}

// server/replay/lab.ts
import { randomUUID as randomUUID4 } from "node:crypto";

// server/replay/lateral.ts
var clamp2 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function reachOf(text2) {
  const pass = /\b(short|deep) (left|right|middle)\b/i.exec(text2);
  if (pass) {
    const side = pass[2].toLowerCase();
    return { side, reach: side === "middle" ? 0 : pass[1].toLowerCase() === "deep" ? 0.3 : 0.2 };
  }
  const run = /\b(left|right) (end|tackle|guard)\b/i.exec(text2);
  if (run) {
    const gap = run[2].toLowerCase();
    return { side: run[1].toLowerCase(), reach: gap === "end" ? 0.35 : gap === "tackle" ? 0.15 : 0.08 };
  }
  return /\bup the middle\b/i.test(text2) ? { side: "middle", reach: 0 } : null;
}
function syntheticLaterals(tl) {
  const [lowHash, highHash] = HASH_LATERAL[tl.league];
  const competitors = tl.summary?.header?.competitions?.[0]?.competitors ?? [];
  const homeId = String(competitors.find((c) => c.homeAway === "home")?.team?.id ?? "");
  const out = /* @__PURE__ */ new Map();
  let lastEnd = 0.5;
  for (const p of tl.plays) {
    const raw = p.raw;
    const restart = /kickoff|extra point|two-point|conversion/i.test(String(raw.type?.text ?? ""));
    const start = restart ? 0.5 : clamp2(lastEnd, lowHash, highHash);
    const reach = restart ? null : reachOf(String(raw.text ?? ""));
    let end = null;
    if (reach) {
      const offenseIsHome = homeId !== "" && String(raw.start?.team?.id ?? "") === homeId;
      const towardFar = reach.side === "left" !== offenseIsHome;
      end = reach.side === "middle" ? 0.5 : clamp2(0.5 + (towardFar ? -reach.reach : reach.reach), 0.04, 0.96);
    }
    out.set(String(raw.id), { start, end });
    lastEnd = restart ? 0.5 : end ?? start;
  }
  return out;
}
var cache = /* @__PURE__ */ new WeakMap();
function lateralsFor(tl) {
  if (!tl.edits.some((e) => e.kind === "synthetic-lateral")) return null;
  let laterals = cache.get(tl);
  if (!laterals) {
    laterals = syntheticLaterals(tl);
    cache.set(tl, laterals);
  }
  return laterals;
}
function snapLateral(league, after) {
  if (!after) return null;
  const [low, high] = HASH_LATERAL[league];
  return clamp2(after.end ?? after.start, low, high);
}
function withLateral(p, pair) {
  if (!pair) return p;
  return {
    ...p,
    start: p.start && p.start.spot.schematicYard !== null ? { ...p.start, spot: { ...p.start.spot, lateral: pair.start } } : p.start,
    end: p.end && p.end.spot.schematicYard !== null && pair.end !== null ? { ...p.end, spot: { ...p.end.spot, lateral: pair.end } } : p.end
  };
}
function summaryWithLateral(summary, laterals, latestPlayId2) {
  const situation = summary.situation;
  if (!situation || situation.spot.schematicYard === null || latestPlayId2 === null) return summary;
  const lateral = snapLateral(summary.league, laterals.get(latestPlayId2));
  return lateral === null ? summary : { ...summary, situation: { ...situation, spot: { ...situation.spot, lateral } } };
}
function detailWithLateral(detail, laterals) {
  const plays = detail.plays.map((p) => withLateral(p, laterals.get(p.providerId)));
  const latest = [...detail.plays].reverse().find((p) => laterals.has(p.providerId));
  return { ...detail, plays, summary: summaryWithLateral(detail.summary, laterals, latest?.providerId ?? null) };
}

// server/replay/scenarios.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { join as join4 } from "node:path";

// server/replay/timeline.ts
var STOPPAGE = /timeout|two-minute|end period|end of |coin toss/i;
function buildTimeline(league, event, summary, divisions) {
  const drives = summary.drives?.previous ?? [];
  const plays = [];
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
  const endPlay = [...plays].reverse().find((p) => /end of game/i.test(p.raw.type?.text ?? ""));
  const endAt = scoreOnly ? Number.NEGATIVE_INFINITY : endPlay ? endPlay.t : Math.max(...plays.map((p) => p.t)) + 5 * 6e4;
  return { id: `${league}-${event.id}`, league, providerEventId: String(event.id), divisions, event, summary, plays, kickoffAt, endAt, scoreOnly, edits: [], market: null, lines: null };
}
function lineAt(tl, tv) {
  let found = null;
  for (const point of tl.lines?.points ?? []) {
    const at2 = Date.parse(point.at);
    if (!Number.isFinite(at2)) continue;
    if (at2 > tv) break;
    found = point;
  }
  return found;
}
function linesAt(tl, tv) {
  const now = lineAt(tl, tv);
  if (!tl.lines || !now) return null;
  const first = tl.lines.points[0];
  const price = (line, odds) => line === null ? null : { line, odds };
  const spread = now.spreadHome === null && now.spreadAway === null ? null : {
    home: { open: price(first.spreadHome, first.spreadOddsHome), latest: price(now.spreadHome, now.spreadOddsHome) },
    away: { open: price(first.spreadAway, first.spreadOddsAway), latest: price(now.spreadAway, now.spreadOddsAway) }
  };
  const moneyline = now.moneylineHome === null && now.moneylineAway === null ? null : { home: { open: first.moneylineHome, latest: now.moneylineHome }, away: { open: first.moneylineAway, latest: now.moneylineAway } };
  const total = now.total === null ? null : {
    over: { open: price(first.total, first.totalOddsOver), latest: price(now.total, now.totalOddsOver) },
    under: { open: price(first.total, first.totalOddsUnder), latest: price(now.total, now.totalOddsUnder) }
  };
  if (!spread && !moneyline && !total) return null;
  const homeLine = now.spreadHome;
  return { provider: tl.lines.provider, details: null, favorite: homeLine !== null && homeLine !== 0 ? homeLine < 0 ? "home" : "away" : null, spread, moneyline, total };
}
function lineHistoryAt(tl, tv) {
  if (!tl.lines) return null;
  const points = tl.lines.points.filter((p) => {
    const at2 = Date.parse(p.at);
    return Number.isFinite(at2) && at2 <= tv;
  });
  return points.length ? { provider: tl.lines.provider, points, captured: true } : null;
}
function bookAt(contract, tv) {
  if (!contract) return null;
  let book = null;
  let last = null;
  for (const c of contract.candles) {
    if (c[0] * 1e3 > tv) break;
    book = c;
    if (c[3] !== null) last = c[3];
  }
  return book ? [book[0], book[1], book[2], last] : null;
}
function quoteFrom(book) {
  if (!book) return null;
  const [, bid, ask, last] = book;
  const price = quotePrice(bid, ask, last);
  if (price === null) return null;
  return { price, bid: bid !== null && bid > 0 ? bid : null, ask: ask !== null && ask > 0 ? ask : null, last: last !== null && last > 0 ? last : null };
}
function marketAt(tl, tv) {
  const market = tl.market;
  if (!market || tl.scoreOnly || tv >= tl.endAt) return null;
  const homeBook = bookAt(market.home, tv);
  const awayBook = bookAt(market.away, tv);
  const home = quoteFrom(homeBook);
  const away = quoteFrom(awayBook);
  if (!home && !away) return null;
  const at2 = Math.max(homeBook?.[0] ?? 0, awayBook?.[0] ?? 0) * 1e3;
  return { source: market.source, moneyline: { home, away }, spread: null, total: null, changedAt: new Date(at2).toISOString(), stale: false };
}
function marketHistoryAt(tl, tv) {
  const market = tl.market;
  if (!market?.home || tl.scoreOnly) return null;
  const cut = Math.min(tv, tl.endAt);
  const points = pricePoints(market.home.candles.filter((c) => c[0] * 1e3 <= cut));
  return points.length >= 2 ? { source: market.source, team: "home", points, captured: true } : null;
}
function visiblePlays(tl, tv) {
  const holds = tl.edits.filter((e) => e.kind === "hold");
  const strips = tl.edits.filter((e) => e.kind === "strip-spot");
  const revisions = tl.edits.filter((e) => e.kind === "revise" && tv >= e.at);
  const out = [];
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
      raw = { ...raw, end: { ...rest, downDistanceText: typeof raw.end.downDistanceText === "string" ? raw.end.downDistanceText.replace(/ at .*$/, "") : raw.end.downDistanceText } };
    }
    out.push({ ...p, raw });
  }
  return out;
}
function visibleWinProbability(tl, visible) {
  const entries = Array.isArray(tl.summary.winprobability) ? tl.summary.winprobability : [];
  if (!visible.length || !entries.length) return [];
  const known = new Set(tl.plays.map((p) => String(p.raw.id)));
  const shown = new Set(visible.map((p) => String(p.raw.id)));
  const out = [];
  for (const e of entries) {
    const id = String(e.playId);
    if (known.has(id) && !shown.has(id)) break;
    out.push(e);
  }
  return out;
}
var PERIOD_NAMES = ["1st Quarter", "2nd Quarter", "3rd Quarter", "4th Quarter"];
var PERIOD_SHORT = ["1st", "2nd", "3rd", "4th"];
var periodName = (p) => p <= 4 ? PERIOD_NAMES[p - 1] : p === 5 ? "OT" : `${p - 4}OT`;
var periodShort2 = (p) => p <= 4 ? PERIOD_SHORT[p - 1] : p === 5 ? "OT" : `${p - 4}OT`;
var clockSeconds = (display) => {
  const m = /^(\d+):(\d{2})/.exec(display ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
function statusAt(tl, visible, tv) {
  const final = tl.event.competitions?.[0]?.status ?? tl.event.status;
  if (tl.scoreOnly) return final;
  if (!visible.length) {
    return { clock: 0, displayClock: "0:00", period: 0, type: { id: "1", name: "STATUS_SCHEDULED", state: "pre", completed: false, description: "Scheduled", detail: "Scheduled", shortDetail: "Scheduled" } };
  }
  const last = visible[visible.length - 1].raw;
  const type = String(last.type?.text ?? "");
  if (/end of game/i.test(type) || tv >= tl.endAt) return final;
  const period = Number(last.period?.number ?? 1);
  if (/end of half/i.test(type)) {
    return { clock: 0, displayClock: "0:00", period, type: { id: "23", name: "STATUS_HALFTIME", state: "in", completed: false, description: "Halftime", detail: "Halftime", shortDetail: "Halftime" } };
  }
  if (/^end period$|end of regulation/i.test(type)) {
    return { clock: 0, displayClock: "0:00", period, type: { id: "22", name: "STATUS_END_PERIOD", state: "in", completed: false, description: "End of Period", detail: `End of ${periodName(period)}`, shortDetail: `End of ${periodShort2(period)}` } };
  }
  const display = String(last.clock?.displayValue ?? "0:00");
  return {
    clock: clockSeconds(display),
    displayClock: display,
    period,
    type: { id: "2", name: "STATUS_IN_PROGRESS", state: "in", completed: false, description: "In Progress", detail: `${display} - ${periodName(period)}`, shortDetail: `${display} - ${periodShort2(period)}` }
  };
}
function scoreOf(tl, visible) {
  if (tl.scoreOnly) {
    const comps = tl.event.competitions?.[0]?.competitors ?? [];
    return {
      home: Number(comps.find((c) => c.homeAway === "home")?.score ?? 0),
      away: Number(comps.find((c) => c.homeAway === "away")?.score ?? 0)
    };
  }
  for (let i = visible.length - 1; i >= 0; i--) {
    const raw = visible[i].raw;
    const home = Number(raw.homeScore ?? 0);
    const away = Number(raw.awayScore ?? 0);
    if (home === 0 && away === 0 && i > 0 && STOPPAGE.test(String(raw.type?.text ?? ""))) continue;
    return { home, away };
  }
  return { home: 0, away: 0 };
}
function situationOf(visible, probability) {
  for (let i = visible.length - 1; i >= 0; i--) {
    const p = visible[i].raw;
    if (STOPPAGE.test(String(p.type?.text ?? ""))) continue;
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
        ...wp ? { probability: { homeWinPercentage: wp.homeWinPercentage, tiePercentage: wp.tiePercentage } } : {}
      }
    };
  }
  return void 0;
}
var probabilityByPlay = (entries) => new Map(entries.map((e) => [String(e.playId), e]));
var stripResult = (c, final) => {
  const { records: _r, record: _rec, winner, ...rest } = c;
  return final ? { ...rest, winner } : rest;
};
function scoreboardEventAt(tl, tv) {
  const comp = tl.event.competitions[0];
  const visible = visiblePlays(tl, tv);
  const status = statusAt(tl, visible, tv);
  const final = status.type?.name === "STATUS_FINAL";
  const score = scoreOf(tl, visible);
  const competitors = comp.competitors.map((c) => ({
    ...stripResult(c, final),
    score: status.type?.state === "pre" ? "0" : String(c.homeAway === "home" ? score.home : score.away)
  }));
  const situation = status.type?.name === "STATUS_IN_PROGRESS" ? situationOf(visible, probabilityByPlay(visibleWinProbability(tl, visible))) : void 0;
  const odds = Array.isArray(tl.summary.pickcenter) ? { odds: tl.summary.pickcenter } : {};
  return { ...tl.event, status, competitions: [{ ...comp, competitors, status, situation, ...odds }] };
}
function summaryAt(tl, tv) {
  const s = tl.summary;
  const visible = visiblePlays(tl, tv);
  const status = statusAt(tl, visible, tv);
  const final = status.type?.name === "STATUS_FINAL";
  const score = scoreOf(tl, visible);
  const winprobability = visibleWinProbability(tl, visible);
  const situation = status.type?.name === "STATUS_IN_PROGRESS" ? situationOf(visible, probabilityByPlay(winprobability)) : void 0;
  const byDrive = /* @__PURE__ */ new Map();
  for (const p of visible) byDrive.set(p.drive, [...byDrive.get(p.drive) ?? [], p.raw]);
  const lastDrive = visible.length ? visible[visible.length - 1].drive : -1;
  const previous = [];
  let current;
  (s.drives?.previous ?? []).forEach((d, i) => {
    const plays = byDrive.get(i);
    if (!plays) return;
    const complete = plays.length === (d.plays?.length ?? 0) && (i < lastDrive || final);
    const cut = { ...d, plays, description: void 0, result: void 0, shortDisplayResult: void 0, displayResult: void 0, yards: void 0, offensivePlays: void 0, end: void 0, timeElapsed: void 0, isScore: void 0 };
    if (complete) previous.push({ ...d, plays });
    else if (i === lastDrive && !final) current = cut;
    else previous.push(cut);
  });
  const visibleIds = new Set(visible.map((p) => String(p.raw.id)));
  const nonScoring = new Set(visible.filter((p) => p.raw.scoringPlay === false).map((p) => String(p.raw.id)));
  const lastScoring = new Map(visible.map((p) => [String(p.raw.id), p.raw]));
  const scoringPlays = (s.scoringPlays ?? []).filter((sp) => visibleIds.has(String(sp.id)) && !nonScoring.has(String(sp.id))).map((sp) => {
    const play = lastScoring.get(String(sp.id));
    return play ? { ...sp, homeScore: play.homeScore, awayScore: play.awayScore } : sp;
  });
  const comp = s.header.competitions[0];
  const possessionTeam = situation?.possession;
  return {
    format: s.format,
    // Attendance and leaders were captured for the finished game, so they appear only once the replay reaches the final.
    gameInfo: final ? s.gameInfo : s.gameInfo ? { ...s.gameInfo, attendance: void 0 } : void 0,
    boxscore: final ? s.boxscore : void 0,
    leaders: final ? s.leaders : void 0,
    pickcenter: s.pickcenter,
    winprobability,
    header: {
      ...s.header,
      competitions: [
        {
          ...comp,
          status,
          competitors: comp.competitors.map((c) => ({
            ...stripResult(c, final),
            score: status.type?.state === "pre" ? "0" : String(c.homeAway === "home" ? score.home : score.away),
            possession: status.type?.state === "in" && possessionTeam !== void 0 && String(c.team?.id) === String(possessionTeam)
          }))
        }
      ]
    },
    drives: tl.scoreOnly ? void 0 : { previous, ...current ? { current } : {} },
    scoringPlays
  };
}

// server/replay/scenarios.ts
var FixtureStore = class {
  constructor(dir) {
    this.dir = dir;
  }
  dir;
  cache = /* @__PURE__ */ new Map();
  json(rel) {
    if (!this.cache.has(rel)) {
      const file = join4(this.dir, rel);
      this.cache.set(rel, existsSync4(file) ? JSON.parse(readFileSync4(file, "utf8")) : null);
    }
    return this.cache.get(rel) ?? null;
  }
  /** Exchange prices captured for one league and provider day, kept beside the ESPN fixtures in fixtures/kalshi. */
  market(league, dateKey) {
    return this.json(join4("..", "kalshi", `${league}-${dateKey}.json`));
  }
  /** Sportsbook lines recorded for one league and provider day, kept beside the ESPN fixtures in fixtures/lines. */
  lines(league, dateKey) {
    return this.json(join4("..", "lines", `${league}-${dateKey}.json`));
  }
};
var finiteOrNull = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
function capturedContract(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  if (typeof r.ticker !== "string" || !Array.isArray(r.candles)) return null;
  const candles = r.candles.filter((c) => Array.isArray(c) && finiteOrNull(c[0]) !== null).map((c) => [c[0], finiteOrNull(c[1]), finiteOrNull(c[2]), finiteOrNull(c[3])]).sort((a, b) => a[0] - b[0]);
  return candles.length ? { ticker: r.ticker, candles } : null;
}
function withCapturedMarket(fx, tl) {
  const scheduled = Date.parse(tl.event.date ?? tl.event.competitions?.[0]?.date);
  if (!Number.isFinite(scheduled)) return tl;
  let file;
  try {
    file = fx.market(tl.league, easternDateKey(new Date(scheduled)));
  } catch {
    return tl;
  }
  const game = file?.games?.[tl.id];
  if (!game || typeof game !== "object") return tl;
  const home = capturedContract(game.home);
  const away = capturedContract(game.away);
  if (home || away) tl.market = { source: typeof file?.source === "string" ? file.source : "Kalshi", event: String(game.event ?? ""), home, away };
  return tl;
}
function capturedPoint(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  if (typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) return null;
  return {
    at: r.at,
    spreadHome: finiteOrNull(r.spreadHome),
    spreadAway: finiteOrNull(r.spreadAway),
    spreadOddsHome: finiteOrNull(r.spreadOddsHome),
    spreadOddsAway: finiteOrNull(r.spreadOddsAway),
    total: finiteOrNull(r.total),
    totalOddsOver: finiteOrNull(r.totalOddsOver),
    totalOddsUnder: finiteOrNull(r.totalOddsUnder),
    moneylineHome: finiteOrNull(r.moneylineHome),
    moneylineAway: finiteOrNull(r.moneylineAway)
  };
}
function withCapturedLines(fx, tl) {
  const scheduled = Date.parse(tl.event.date ?? tl.event.competitions?.[0]?.date);
  if (!Number.isFinite(scheduled)) return tl;
  let file;
  try {
    file = fx.lines(tl.league, easternDateKey(new Date(scheduled)));
  } catch {
    return tl;
  }
  const game = file?.games?.[tl.id];
  const points = Array.isArray(game?.points) ? game.points.map(capturedPoint).filter((p) => p !== null) : [];
  if (!points.length) return tl;
  points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const captured = { provider: typeof game?.provider === "string" ? game.provider : typeof file?.provider === "string" ? file.provider : "Sportsbook", points };
  tl.lines = captured;
  return tl;
}
var MIN = 6e4;
var TEAM_STATS_NOTE = "Team statistics appear when a game ends; intermediate totals were never captured.";
function timelines(fx, league, events, divisionsOf) {
  const prefix = league === "nfl" ? "nfl" : "cfb";
  return events.flatMap((e) => {
    const summary = fx.json(`summary/${prefix}-${e.id}.json`);
    return summary ? [buildTimeline(league, e, summary, divisionsOf(String(e.id)))] : [];
  });
}
function span(games) {
  const live = games.filter((g) => !g.scoreOnly);
  if (!live.length) return null;
  return { startAt: Math.min(...live.map((g) => g.kickoffAt)) - 5 * MIN, endAt: Math.max(...live.map((g) => g.endAt)) + 5 * MIN };
}
var firstQuarter = (tl, period) => tl.plays.find((p) => Number(p.raw.period?.number) === period)?.t ?? tl.kickoffAt;
function singleGame(fx, league, id, scoreboardRel, divisions) {
  const event = (fx.json(scoreboardRel)?.events ?? []).find((e) => String(e.id) === id);
  const prefix = league === "nfl" ? "nfl" : "cfb";
  const summary = fx.json(`summary/${prefix}-${id}.json`);
  return event && summary ? buildTimeline(league, event, summary, divisions) : null;
}
var dateKeyOf = (iso3) => {
  const d = new Date(Date.parse(iso3) - 5 * 60 * MIN);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
var BASE_GAME = { league: "nfl", id: "401872925", rel: "scoreboard/nfl-20260913.json" };
var SCENARIOS = [
  {
    id: "nfl-week1-sunday",
    label: "Replay \xB7 NFL Week 1, Sunday 13 Sep 2026",
    description: "The real Sunday slate, replayed from the plays ESPN reported, on a sped-up clock. Nothing here is live.",
    synthetic: false,
    speed: 30,
    build(fx) {
      const events = fx.json("scoreboard/nfl-20260913.json")?.events ?? [];
      const games = timelines(fx, "nfl", events, () => ["NFL"]);
      const s = span(games);
      return s ? { date: "20260913", games, ...s, limitations: [TEAM_STATS_NOTE], outages: [] } : null;
    }
  },
  {
    id: "college-week2-saturday",
    label: "Replay \xB7 College football, Saturday 12 Sep 2026",
    description: "Captured FBS, FCS and Division II games from one Saturday, replayed from their reported plays. Score-only games appear with their final result.",
    synthetic: false,
    speed: 45,
    build(fx) {
      const groups = [["FBS", "80"], ["FCS", "81"], ["D2", "57"], ["D3", "58"]];
      const membership = /* @__PURE__ */ new Map();
      const events = /* @__PURE__ */ new Map();
      for (const [division, g] of groups) {
        for (const e of fx.json(`scoreboard/cfb-20260912-g${g}.json`)?.events ?? []) {
          const id = String(e.id);
          membership.set(id, [...membership.get(id) ?? [], division]);
          if (!events.has(id)) events.set(id, e);
        }
      }
      const captured = [...events.values()].filter((e) => fx.json(`summary/cfb-${e.id}.json`));
      const games = timelines(fx, "cfb", captured, (id) => membership.get(id) ?? ["FBS"]);
      const s = span(games);
      return s ? { date: "20260912", games, ...s, outages: [], limitations: [TEAM_STATS_NOTE, "Score-only games have no play-by-play, so they show their final result for the whole replay.", "Only a sample of the day\u2019s games was captured for the replay."] } : null;
    }
  },
  {
    id: "nfl-overtime",
    label: "Replay \xB7 NFL overtime, Giants at Cowboys (14 Sep 2025)",
    description: "A real NFL game decided in overtime, starting late in the fourth quarter.",
    synthetic: false,
    speed: 15,
    build(fx) {
      const tl = singleGame(fx, "nfl", "401772834", "scoreboard/event-nfl-401772834.json", ["NFL"]);
      if (!tl) return null;
      return { date: dateKeyOf(tl.event.date), games: [tl], startAt: firstQuarter(tl, 4) - MIN, endAt: tl.endAt + 3 * MIN, limitations: [TEAM_STATS_NOTE], outages: [] };
    }
  },
  {
    id: "college-overtime",
    label: "Replay \xB7 College double overtime, Baylor at SMU (6 Sep 2025)",
    description: "A real college game that went to a second overtime, where each possession must attempt a two-point try.",
    synthetic: false,
    speed: 15,
    build(fx) {
      const tl = singleGame(fx, "cfb", "401754525", "scoreboard/event-cfb-401754525.json", ["FBS"]);
      if (!tl) return null;
      return { date: dateKeyOf(tl.event.date), games: [tl], startAt: firstQuarter(tl, 4) - MIN, endAt: tl.endAt + 3 * MIN, limitations: [TEAM_STATS_NOTE], outages: [] };
    }
  },
  {
    id: "test-overturned-touchdown",
    label: "Test scenario \xB7 Touchdown reversed on review (synthetic)",
    description: "Built on a real game. One touchdown is deliberately reversed 60 seconds after it appears; later plays are withheld so the edit stays consistent. Not real events.",
    synthetic: true,
    speed: 4,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ["NFL"]);
      if (!tl) return null;
      const i = tl.plays.findIndex((p) => /touchdown/i.test(p.raw.type?.text ?? "") && !/return/i.test(p.raw.type?.text ?? ""));
      if (i < 1) return null;
      const td = tl.plays[i];
      const before = tl.plays[i - 1].raw;
      const comps = tl.summary.header.competitions[0].competitors;
      const home = comps.find((c) => c.homeAway === "home")?.team;
      const away = comps.find((c) => c.homeAway === "away")?.team;
      if (!home || !away) return null;
      const offenseIsHome = String(td.raw.start?.team?.id) === String(home.id);
      const defense = offenseIsHome ? away : home;
      const passing = /passing/i.test(td.raw.type?.text ?? "");
      tl.edits.push({
        kind: "revise",
        at: td.t + MIN,
        playId: String(td.raw.id),
        scoreDelta: { home: Number(before.homeScore) - Number(td.raw.homeScore), away: Number(before.awayScore) - Number(td.raw.awayScore) },
        patch: (raw) => ({
          ...raw,
          type: passing ? { id: "24", text: "Pass Reception", abbreviation: "REC" } : { id: "5", text: "Rush", abbreviation: "RUSH" },
          scoringPlay: false,
          text: `${raw.text} [Test scenario: after review the ball carrier was ruled down at the 1-yard line. No touchdown.]`,
          modified: new Date(td.t + MIN).toISOString(),
          end: {
            ...raw.end,
            down: 1,
            distance: 1,
            yardsToEndzone: 1,
            yardLine: offenseIsHome ? 99 : 1,
            possessionText: `${defense.abbreviation} 1`,
            downDistanceText: `1st & Goal at ${defense.abbreviation} 1`,
            shortDownDistanceText: "1st & Goal",
            team: { id: raw.start?.team?.id }
          }
        })
      });
      const endAt = td.t + 4 * MIN;
      tl.edits.push({ kind: "hold", from: td.t + 1, until: Number.POSITIVE_INFINITY });
      return { date: "20260913", games: [tl], startAt: td.t - 3 * MIN, endAt, limitations: ["Synthetic test scenario: the reversal did not happen in the real game."], outages: [] };
    }
  },
  {
    id: "test-delayed-burst",
    label: "Test scenario \xB7 Delayed burst of plays (synthetic)",
    description: "Built on a real game. Five consecutive plays are withheld and then delivered at once, as a lagging feed would. Not real timing.",
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ["NFL"]);
      if (!tl) return null;
      const k = tl.plays.findIndex((p, idx) => idx > 20 && /rush|pass/i.test(p.raw.type?.text ?? ""));
      if (k < 0 || k + 5 >= tl.plays.length) return null;
      const from = tl.plays[k].t;
      const until = tl.plays[k + 5].t + 1;
      tl.edits.push({ kind: "hold", from, until });
      return { date: "20260913", games: [tl], startAt: from - 2 * MIN, endAt: until + 4 * MIN, limitations: ["Synthetic test scenario: the provider did not really delay these plays."], outages: [] };
    }
  },
  {
    id: "test-missing-spot",
    label: "Test scenario \xB7 Ball spot missing (synthetic)",
    description: "Built on a real game. For several plays the feed omits where the ball is, so the field must say the spot is unavailable. Not real data loss.",
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ["NFL"]);
      if (!tl) return null;
      const k = tl.plays.findIndex((p, idx) => idx > 40 && /rush|pass/i.test(p.raw.type?.text ?? ""));
      if (k < 0 || k + 8 >= tl.plays.length) return null;
      tl.edits.push({ kind: "strip-spot", from: tl.plays[k].t, until: tl.plays[k + 8].t });
      return { date: "20260913", games: [tl], startAt: tl.plays[k].t - 2 * MIN, endAt: tl.plays[k + 8].t + 4 * MIN, limitations: ["Synthetic test scenario: the real feed reported these spots."], outages: [] };
    }
  },
  {
    id: "test-weather",
    label: "Test scenario \xB7 Snow at the venue, at night (synthetic)",
    description: "Built on a real game, with the provider's weather at the venue replaced by snow after dark on a grass field. The real game was played in the dry. Not real weather.",
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ["NFL"]);
      if (!tl) return null;
      tl.event = { ...tl.event, weather: { conditionId: 44, temperature: 24, displayValue: "Snow" } };
      const comp = tl.event.competitions[0];
      tl.event.competitions = [{ ...comp, venue: { ...comp.venue, indoor: false, grass: true } }];
      const k = Math.max(0, Math.floor(tl.plays.length * 0.3));
      return {
        date: "20260913",
        games: [tl],
        startAt: tl.plays[k].t - 2 * MIN,
        endAt: tl.plays[Math.min(tl.plays.length - 1, k + 40)].t + 4 * MIN,
        limitations: ["Synthetic test scenario: the provider reported no snow at this game."],
        outages: []
      };
    }
  },
  {
    id: "test-provider-outage",
    label: "Test scenario \xB7 Provider outage and recovery (synthetic)",
    description: "Built on real games. The provider stops answering for two minutes of replay time, then recovers. Not a real outage.",
    synthetic: true,
    speed: 20,
    build(fx) {
      const events = (fx.json("scoreboard/nfl-20260913.json")?.events ?? []).slice(0, 4);
      const games = timelines(fx, "nfl", events, () => ["NFL"]);
      const s = span(games);
      if (!s) return null;
      const startAt = s.startAt + 60 * MIN;
      return { date: "20260913", games, startAt, endAt: startAt + 30 * MIN, limitations: ["Synthetic test scenario: the outage is simulated."], outages: [{ from: startAt + 3 * MIN, until: startAt + 5 * MIN }] };
    }
  },
  {
    id: "test-lateral-position",
    label: "Test scenario \xB7 Lateral ball position (synthetic)",
    description: "Built on a real game. Where the ball sits across the field is estimated from each play description (left, middle or right) to show lateral positioning on the fields. No feed reports these positions. Not real data.",
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ["NFL"]);
      if (!tl) return null;
      const k = tl.plays.findIndex((p, idx) => idx > 30 && /rush|pass/i.test(p.raw.type?.text ?? ""));
      if (k < 0 || k + 24 >= tl.plays.length) return null;
      tl.edits.push({ kind: "synthetic-lateral" });
      return {
        date: "20260913",
        games: [tl],
        startAt: tl.plays[k].t - 2 * MIN,
        endAt: tl.plays[k + 24].t + 4 * MIN,
        limitations: ["Synthetic test scenario: lateral positions are estimated from play descriptions. No feed reported them."],
        outages: []
      };
    }
  }
];

// server/replay/lab.ts
var REPLAY_INTERVALS = {
  slateLive: 2e3,
  slateIdle: 4e3,
  slatePast: 4e3,
  detailFocus: 2e3,
  detailVisible: 3e3,
  detailBackground: 4e3,
  detailScheduled: 6e3,
  detailFinal: 3e4
};
var iso2 = (ms) => new Date(ms).toISOString();
var VirtualClock = class {
  constructor(start, end, speed, realNow = Date.now, playing = true) {
    this.start = start;
    this.end = end;
    this.realNow = realNow;
    this.anchorReal = realNow();
    this.anchorVirtual = start;
    this.speed = speed;
    this.playing = playing;
  }
  start;
  end;
  realNow;
  anchorReal;
  anchorVirtual;
  playing;
  forcedOutageUntil = 0;
  speed;
  now() {
    if (!this.playing) return this.anchorVirtual;
    return Math.min(this.end, this.anchorVirtual + (this.realNow() - this.anchorReal) * this.speed);
  }
  rebase() {
    this.anchorVirtual = this.now();
    this.anchorReal = this.realNow();
  }
  play() {
    this.rebase();
    this.playing = true;
  }
  pause() {
    this.rebase();
    this.playing = false;
  }
  setSpeed(speed) {
    this.rebase();
    this.speed = Math.min(600, Math.max(1, speed));
  }
  step(seconds2) {
    this.rebase();
    this.anchorVirtual = Math.min(this.end, Math.max(this.start, this.anchorVirtual + seconds2 * 1e3));
  }
  seek(progress) {
    this.rebase();
    this.anchorVirtual = this.start + Math.min(1, Math.max(0, progress)) * (this.end - this.start);
  }
  outage(seconds2) {
    this.forcedOutageUntil = this.realNow() + Math.min(600, Math.max(0, seconds2)) * 1e3;
  }
  inForcedOutage() {
    return this.realNow() < this.forcedOutageUntil;
  }
  status() {
    const v = this.now();
    return {
      playing: this.playing,
      speed: this.speed,
      virtualTime: iso2(v),
      progress: this.end > this.start ? (v - this.start) / (this.end - this.start) : 1,
      start: iso2(this.start),
      end: iso2(this.end),
      outage: this.inForcedOutage()
    };
  }
};
function latestPlayId(tl, tv) {
  const visible = visiblePlays(tl, tv);
  return visible.length ? String(visible[visible.length - 1].raw.id) : null;
}
var ReplayProvider = class {
  constructor(scenario, clock, def) {
    this.scenario = scenario;
    this.clock = clock;
    this.info = {
      id: "replay",
      name: "Replay lab",
      description: def.synthetic ? "Synthetic test scenario built on captured ESPN data. These are not real events." : "Captured ESPN play-by-play replayed on a virtual clock. Not live.",
      licensed: false,
      push: false,
      divisions: ["NFL", "FBS", "FCS", "D2", "D3"]
    };
  }
  scenario;
  clock;
  info;
  diagnostics = newDiagnostics();
  failing() {
    const tv = this.clock.now();
    return this.clock.inForcedOutage() || this.scenario.outages.some((o) => tv >= o.from && tv < o.until);
  }
  async fetchSlate(league, dateKey, options) {
    const receivedAt = Date.now();
    const scope = league === "nfl" ? "NFL scoreboard" : "College scoreboard";
    if (this.failing()) {
      return { league, dateKey, games: [], divisions: [], errors: [{ scope, message: "Replay test scenario: the provider is not responding", status: 503 }], failed: true, receivedAt, discovery: "", limitations: [] };
    }
    const tv = this.clock.now();
    const wanted = (divisions2) => league === "nfl" || divisions2.some((d) => options.divisions.includes(d));
    const inPlay = dateKey === this.scenario.date ? this.scenario.games.filter((g) => g.league === league && wanted(g.divisions)) : [];
    const games = inPlay.map((g) => {
      const summary = normalizeScoreboardEvent(scoreboardEventAt(g, tv), league, league === "nfl" ? ["NFL"] : g.divisions.filter((d) => options.divisions.includes(d)), this.diagnostics);
      const laterals = summary ? lateralsFor(g) : null;
      const decorated = summary && laterals ? summaryWithLateral(summary, laterals, latestPlayId(g, tv)) : summary;
      if (!decorated) return decorated;
      const lines = g.lines ? linesAt(g, tv) : null;
      return g.market || lines ? { ...decorated, ...g.market ? { market: marketAt(g, tv) } : {}, ...lines ? { lines } : {} } : decorated;
    }).filter((g) => g !== null);
    const divisions = league === "nfl" ? [{ division: "NFL", label: "NFL", providerGroupId: null, games: games.length, health: "connected" }] : options.divisions.map((d) => ({ division: d, label: d, providerGroupId: null, games: games.filter((g) => g.divisions.includes(d)).length, health: "connected" }));
    return { league, dateKey, games, divisions, errors: [], failed: false, receivedAt, discovery: "Replay lab: captured games only.", limitations: this.scenario.limitations };
  }
  async fetchDetail(id) {
    const receivedAt = Date.now();
    if (this.failing()) return { ok: false, error: { scope: "Game detail", message: "Replay test scenario: the provider is not responding", status: 503 }, receivedAt };
    const tl = this.scenario.games.find((g) => g.id === id);
    if (!tl) return { ok: false, error: { scope: "Game detail", message: "This game is not part of the replay", status: 404 }, receivedAt };
    const tv = this.clock.now();
    const detail = normalizeSummary(summaryAt(tl, tv), tl.league, tl.divisions, this.diagnostics);
    if (!detail) return { ok: false, error: { scope: "Game detail", message: "Replay summary could not be read", status: null }, receivedAt };
    const laterals = lateralsFor(tl);
    const decorated = laterals ? detailWithLateral(detail, laterals) : detail;
    const lines = tl.lines ? linesAt(tl, tv) : null;
    if (!tl.market && !lines) return { ok: true, detail: decorated, receivedAt };
    return {
      ok: true,
      detail: {
        ...decorated,
        summary: { ...decorated.summary, ...tl.market ? { market: marketAt(tl, tv) } : {}, ...lines ? { lines } : {} },
        ...tl.market ? { marketHistory: marketHistoryAt(tl, tv) } : {},
        // The record the page rewinds, cut at the replay clock, so a replay stops where a live session would have.
        lineHistory: lineHistoryAt(tl, tv)
      },
      receivedAt
    };
  }
};
var ReplayLab = class {
  constructor(options) {
    this.options = options;
    this.fixtures = new FixtureStore(options.fixturesDir);
    this.sweeper = setInterval(() => this.sweep(), 6e4);
    this.sweeper.unref?.();
  }
  options;
  fixtures;
  sessions = /* @__PURE__ */ new Map();
  built = /* @__PURE__ */ new Map();
  sweeper;
  build(def) {
    if (!this.built.has(def.id)) {
      let result = null;
      try {
        result = def.build(this.fixtures);
      } catch {
        result = null;
      }
      this.built.set(def.id, result);
    }
    return this.built.get(def.id) ?? null;
  }
  scenarios() {
    return SCENARIOS.flatMap((def) => {
      const built = this.build(def);
      return built ? [{ id: def.id, label: def.label, description: def.description, synthetic: def.synthetic, date: built.date }] : [];
    });
  }
  create(scenarioId, opts = {}) {
    const def = SCENARIOS.find((s) => s.id === scenarioId);
    if (!def) return { error: "Unknown replay scenario" };
    let built;
    try {
      built = def.build(this.fixtures);
    } catch {
      built = null;
    }
    if (!built) return { error: "This scenario\u2019s captured data is not installed" };
    if (!def.synthetic)
      for (const tl of built.games) {
        withCapturedMarket(this.fixtures, tl);
        withCapturedLines(this.fixtures, tl);
      }
    this.sweep();
    const transient = [...this.sessions.values()].filter((s) => !s.persistent).length;
    if (!opts.persistent && transient >= this.options.maxSessions) return { error: "Too many replay sessions are running; try again shortly" };
    const clock = new VirtualClock(built.startAt, built.endAt, opts.speed ?? def.speed, Date.now, opts.playing ?? true);
    if (opts.progress !== void 0) clock.seek(opts.progress);
    const provider = new ReplayProvider(built, clock, def);
    const scenarioDate = built.date;
    const engine2 = new GridironEngine({ provider, mode: "replay", replayLabel: def.label, today: () => scenarioDate, intervals: REPLAY_INTERVALS, random: () => 0.5 });
    engine2.start();
    const id = randomUUID4();
    this.sessions.set(id, { id, def, built, clock, engine: engine2, lastUsed: Date.now(), persistent: opts.persistent === true });
    return { id, scenario: def.id, label: def.label };
  }
  engine(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.lastUsed = Date.now();
    return s.engine;
  }
  control(id, command) {
    const s = this.sessions.get(id);
    if (!s) return { error: "Unknown or expired replay session" };
    s.lastUsed = Date.now();
    switch (command.type) {
      case "play":
        s.clock.play();
        break;
      case "pause":
        s.clock.pause();
        break;
      case "speed":
        if (typeof command.speed !== "number") return { error: "speed must be a number" };
        s.clock.setSpeed(command.speed);
        break;
      case "step":
        if (typeof command.seconds !== "number") return { error: "seconds must be a number" };
        s.clock.step(command.seconds);
        break;
      case "seek":
        if (typeof command.progress !== "number") return { error: "progress must be a number" };
        s.clock.seek(command.progress);
        break;
      case "outage":
        s.clock.outage(typeof command.seconds === "number" ? command.seconds : 60);
        break;
      default:
        return { error: "Unknown command" };
    }
    void s.engine.refreshAll();
    return this.status(id);
  }
  status(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return { id, scenario: s.def.id, label: s.def.label, description: s.def.description, synthetic: s.def.synthetic, date: s.built.date, limitations: s.built.limitations, ...s.clock.status() };
  }
  sweep() {
    const idle = this.options.idleMs ?? 15 * 6e4;
    for (const [id, s] of this.sessions) {
      if (!s.persistent && Date.now() - s.lastUsed > idle) {
        s.engine.stop();
        this.sessions.delete(id);
      }
    }
  }
  stopAll() {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) s.engine.stop();
    this.sessions.clear();
  }
};

// server/teams.ts
import { existsSync as existsSync5 } from "node:fs";
import { readFile } from "node:fs/promises";
import { join as join5 } from "node:path";

// server/providers/espn/team.ts
var TEAM_ID_PATTERN = /^\d{1,10}$/;
var SEASON_TYPE_NAME = { 1: "preseason", 2: "regular season", 3: "postseason" };
var UID_LEAGUE = { nfl: "28", cfb: "23" };
var nonNull = (v) => v !== null && v !== void 0;
function assertLeague(league) {
  if (league !== "nfl" && league !== "cfb") throw new Error(`Unknown league ${JSON.stringify(league)}`);
}
function assertTeamId(teamId) {
  if (typeof teamId !== "string" || !TEAM_ID_PATTERN.test(teamId)) {
    throw new Error(`Team id must be 1 to 10 digits, got ${JSON.stringify(teamId)}`);
  }
}
function assertSeason(season) {
  if (typeof season !== "number" || !Number.isInteger(season) || season < 1e3 || season > 9999) {
    throw new Error(`Season must be a four digit year, got ${JSON.stringify(season)}`);
  }
}
function teamUrl(league, teamId) {
  assertLeague(league);
  assertTeamId(teamId);
  return `${SITE_BASE}/${espnLeaguePath(league)}/teams/${teamId}`;
}
function teamScheduleUrl(league, teamId, seasonType, season) {
  assertLeague(league);
  assertTeamId(teamId);
  if (seasonType !== 1 && seasonType !== 2 && seasonType !== 3) {
    throw new Error(`Season type must be 1, 2 or 3, got ${JSON.stringify(seasonType)}`);
  }
  const q = new URLSearchParams();
  if (season !== void 0) {
    assertSeason(season);
    q.set("season", String(season));
  }
  q.set("seasontype", String(seasonType));
  return `${SITE_BASE}/${espnLeaguePath(league)}/teams/${teamId}/schedule?${q.toString()}`;
}
function pollRank(v) {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= 25 ? n : null;
}
function pickLogo(logos, want) {
  const hit = arr(logos).map(obj).find((l) => {
    const rel = arr(l?.rel).map((r) => str(r));
    return rel.includes("full") && rel.includes(want) && !rel.includes("scoreboard");
  });
  return hit ? safeUrl(hit.href) : null;
}
function normalizeTeamProfile(league, teamJson) {
  assertLeague(league);
  const root = obj(teamJson);
  if (!root) throw new Error("Team document was not a JSON object");
  const t = obj(root.team);
  if (!t) throw new Error("Team document had no team object");
  const providerId = str(t.id);
  if (!providerId) throw new Error("Team document had no team.id");
  const uid = str(t.uid);
  const uidLeague = uid?.split("~").find((part) => part.startsWith("l:"))?.slice(2) ?? null;
  if (uidLeague !== null && uidLeague !== UID_LEAGUE[league]) {
    throw new Error(`Team document ${uid} is not a ${LEAGUES[league].name} team`);
  }
  const items = arr(at(t, "record", "items")).map(obj).filter(nonNull);
  const recordItem = (type) => items.find((i) => str(i.type) === type) ?? null;
  const total = recordItem("total");
  const stat = (name) => num(arr(total?.stats).map(obj).find((s) => str(s?.name) === name)?.value);
  const abbreviation = str(t.abbreviation) ?? providerId;
  return {
    key: teamKey(league, providerId),
    league,
    providerId,
    abbreviation,
    displayName: str(t.displayName) ?? str(t.name) ?? abbreviation,
    shortName: str(t.shortDisplayName) ?? str(t.name) ?? abbreviation,
    location: str(t.location),
    name: str(t.name),
    color: hexColor(t.color),
    alternateColor: hexColor(t.alternateColor),
    logo: safeUrl(t.logo) ?? pickLogo(t.logos, "default"),
    logoDark: pickLogo(t.logos, "dark"),
    rank: pollRank(t.rank),
    standingSummary: str(t.standingSummary),
    record: {
      total: str(total?.summary),
      home: str(recordItem("home")?.summary),
      road: str(recordItem("road")?.summary)
    },
    stats: {
      wins: stat("wins"),
      losses: stat("losses"),
      ties: stat("ties"),
      pointsFor: stat("pointsFor"),
      pointsAgainst: stat("pointsAgainst"),
      pointDifferential: stat("pointDifferential"),
      streak: stat("streak")
    }
  };
}
function seasonOf(raw) {
  const s = obj(raw);
  const year = num(s?.year);
  const type = num(s?.type);
  if (!s || year === null || type === null || !Number.isInteger(year) || !Number.isInteger(type)) return null;
  return { year, type, label: str(s.name) ?? str(s.displayName) ?? String(year) };
}
function parseScheduleDocument(json, index, teamId) {
  const label = `Schedule document ${index + 1}`;
  const root = obj(json);
  if (!root) throw new Error(`${label} was not a JSON object`);
  if (!Array.isArray(root.events)) throw new Error(`${label} had no events list`);
  const docTeam = str(at(root, "team", "id"));
  if (docTeam !== null && docTeam !== teamId) throw new Error(`${label} is for team ${docTeam}, not team ${teamId}`);
  const first = obj(root.events[0]);
  const fromEvents = first ? seasonOf({ year: at(first, "season", "year"), type: at(first, "seasonType", "type"), name: at(first, "seasonType", "name") }) : null;
  return { events: root.events, season: seasonOf(root.requestedSeason) ?? fromEvents, currentSeason: seasonOf(root.season), label };
}
function pageSeason(docs) {
  const stated = docs.map((d) => d.season).filter(nonNull);
  if (stated.length === 0) {
    const current = docs.map((d) => d.currentSeason).find(nonNull);
    if (!current) throw new Error("Schedule documents did not say which season they cover");
    return current;
  }
  const years = [...new Set(stated.map((s) => s.year))];
  if (years.length > 1) throw new Error(`Schedule documents cover different seasons (${years.join(", ")})`);
  return stated.find((s) => s.type === 2) ?? stated[0];
}
var competitorTeamId = (c) => str(at(c, "team", "id")) ?? str(c?.id);
var scoreOf2 = (c) => num(c.score) ?? num(at(c, "score", "value"));
function resultOf2(completed, us, them, score) {
  if (!completed) return null;
  const usWon = bool(us.winner);
  const themWon = bool(them.winner);
  if (usWon === true && themWon !== true) return "W";
  if (themWon === true && usWon !== true) return "L";
  if (usWon === true || score === null) return null;
  if (score.team === score.opponent) return "T";
  if (usWon === null && themWon === null) return score.team > score.opponent ? "W" : "L";
  return null;
}
function normalizeScheduleEvent(league, raw, teamId, position) {
  const e = obj(raw);
  if (!e) throw new Error(`${position} was not a JSON object`);
  const providerId = str(e.id);
  if (!providerId) throw new Error(`${position} had no id`);
  const label = `Schedule event ${providerId}`;
  const id = gameId(league, providerId);
  if (!parseGameId(id)) throw new Error(`${label} has an id that cannot form a game id`);
  const comp = obj(at(e, "competitions", 0));
  if (!comp) throw new Error(`${label} had no competition`);
  const kickoff = Date.parse(str(e.date) ?? str(comp.date) ?? "");
  if (!Number.isFinite(kickoff)) throw new Error(`${label} had no valid date`);
  const competitors = arr(comp.competitors).map(obj).filter(nonNull);
  const us = competitors.find((c) => competitorTeamId(c) === teamId);
  if (!us) throw new Error(`${label} did not list team ${teamId} as a competitor`);
  const them = competitors.find((c) => c !== us);
  if (!them) throw new Error(`${label} had no opponent`);
  const homeAway = str(us.homeAway);
  if (homeAway !== "home" && homeAway !== "away") throw new Error(`${label} did not say whether team ${teamId} was home or away`);
  const opponentId = competitorTeamId(them);
  if (!opponentId) throw new Error(`${label} had an opponent without a team id`);
  const opponentTeam = obj(them.team);
  const opponentAbbreviation = str(opponentTeam?.abbreviation) ?? opponentId;
  const statusType = obj(at(comp, "status", "type")) ?? obj(at(e, "status", "type"));
  const reportedState = str(statusType?.state);
  const state = reportedState === "pre" || reportedState === "in" || reportedState === "post" ? reportedState : "unknown";
  const completed = bool(statusType?.completed) === true;
  const usScore = scoreOf2(us);
  const themScore = scoreOf2(them);
  const score = (completed || state === "in") && usScore !== null && themScore !== null ? { team: usScore, opponent: themScore } : null;
  const weekNumber = num(at(e, "week", "number"));
  const seasonType = num(at(e, "seasonType", "type"));
  return {
    gameId: id,
    providerId,
    date: new Date(kickoff).toISOString(),
    timeValid: (bool(e.timeValid) ?? bool(comp.timeValid)) === true,
    week: { number: weekNumber !== null && Number.isInteger(weekNumber) ? weekNumber : null, text: str(at(e, "week", "text")) },
    seasonType: seasonType === 1 || seasonType === 2 || seasonType === 3 ? seasonType : null,
    homeAway,
    neutralSite: bool(comp.neutralSite) === true,
    opponent: {
      key: teamKey(league, opponentId),
      providerId: opponentId,
      abbreviation: opponentAbbreviation,
      displayName: str(opponentTeam?.displayName) ?? str(opponentTeam?.name) ?? opponentAbbreviation,
      shortName: str(opponentTeam?.shortDisplayName) ?? str(opponentTeam?.name) ?? opponentAbbreviation,
      logo: safeUrl(opponentTeam?.logo) ?? pickLogo(opponentTeam?.logos, "default"),
      rank: pollRank(at(them, "curatedRank", "current"))
    },
    venue: str(at(comp, "venue", "fullName")),
    status: { state, completed, detail: str(statusType?.detail), shortDetail: str(statusType?.shortDetail) },
    score,
    result: resultOf2(completed, us, them, score),
    broadcasts: normalizeBroadcasts(comp).map((b) => b.name),
    notes: arr(comp.notes).map((n) => str(obj(n)?.headline)).filter(nonNull)
  };
}
var tieOrder = (type) => type === 2 ? 0 : type ?? 9;
function normalizeTeamPage(league, teamJson, scheduleJsons, fetchedAt) {
  assertLeague(league);
  if (typeof fetchedAt !== "string" || !Number.isFinite(Date.parse(fetchedAt))) {
    throw new Error(`fetchedAt must be an ISO time, got ${JSON.stringify(fetchedAt)}`);
  }
  const team = normalizeTeamProfile(league, teamJson);
  if (!Array.isArray(scheduleJsons) || scheduleJsons.length === 0) throw new Error("A team page needs at least one schedule document");
  const docs = scheduleJsons.map((json, i) => parseScheduleDocument(json, i, team.providerId));
  const season = pageSeason(docs);
  const ordered = docs.flatMap((doc) => doc.events.map((event, i) => normalizeScheduleEvent(league, event, team.providerId, `${doc.label}, event ${i + 1}`))).map((game, order) => ({ game, order, time: Date.parse(game.date) })).sort((a, b) => a.time - b.time || tieOrder(a.game.seasonType) - tieOrder(b.game.seasonType) || a.order - b.order);
  const schedule = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { game } of ordered) {
    if (seen.has(game.gameId)) continue;
    seen.add(game.gameId);
    schedule.push(game);
  }
  return { team, season, schedule, byeWeeks: byeWeeksFrom(schedule), fetchedAt };
}
async function fetchTeamPage(getJson, league, teamId, season, options = {}) {
  assertLeague(league);
  assertTeamId(teamId);
  if (season !== void 0) assertSeason(season);
  const now = options.now ?? Date.now;
  const types = options.preseason ? [2, 3, 1] : [2, 3];
  const request = async (url, what) => {
    try {
      return await getJson(url);
    } catch (e) {
      throw new Error(`ESPN ${what} for ${league} team ${teamId} could not be loaded (${url}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const [teamJson, ...schedules] = await Promise.all([
    request(teamUrl(league, teamId), "team document"),
    ...types.map((type) => request(teamScheduleUrl(league, teamId, type, season), `${SEASON_TYPE_NAME[type]} schedule`))
  ]);
  const page = normalizeTeamPage(league, teamJson, schedules, new Date(now()).toISOString());
  if (season !== void 0 && page.season.year !== season) {
    throw new Error(`ESPN answered with season ${page.season.year} when season ${season} was requested for ${league} team ${teamId}`);
  }
  return page;
}

// server/teams.ts
var LIVE_TTL_MS = 6e4;
var IDLE_TTL_MS = 10 * 6e4;
var FAILURE_TTL_MS = 2e4;
var TeamService = class {
  cache = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  fetcher;
  savedDir;
  now;
  maxEntries;
  constructor(options) {
    this.fetcher = options.fetcher;
    this.savedDir = options.savedDir ?? null;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 256;
  }
  get(league, teamId, options = {}) {
    if (league !== "nfl" && league !== "cfb" || !TEAM_ID_PATTERN.test(teamId)) return Promise.resolve({ ok: false, status: 400, error: "Invalid team id" });
    const key = `${league}-${teamId}|${options.season ?? "current"}|${options.saved ? "saved" : "live"}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached.result);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = this.load(league, teamId, options).then((result) => {
      this.remember(key, result);
      return result;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }
  stats() {
    return { cached: this.cache.size, loading: this.inflight.size };
  }
  async load(league, teamId, options) {
    if (options.saved && this.hasSaved(league, teamId, options.season)) {
      try {
        const page = await fetchTeamPage(this.readSaved(league, teamId), league, teamId, options.season, { now: this.now });
        return { ok: true, page, source: "saved" };
      } catch (e) {
        return { ok: false, status: 502, error: `Saved team documents could not be read: ${e.message}` };
      }
    }
    try {
      const page = await fetchTeamPage(this.getJson, league, teamId, options.season, { now: this.now });
      return { ok: true, page, source: "live" };
    } catch (e) {
      const message = e.message;
      return { ok: false, status: /\b404\b/.test(message) ? 404 : 502, error: `The team page could not be loaded: ${message}` };
    }
  }
  getJson = async (url) => {
    const res = await this.fetcher.getJson(url);
    if (!res.ok) throw new Error(res.status ? `${res.status}: ${res.error}` : res.error);
    return res.data;
  };
  savedName(league, teamId, season, seasonType) {
    const base = `${league}-team-${teamId}`;
    if (season === void 0) return `${base}.json`;
    return `${base}-schedule-${season}${!seasonType || seasonType === "2" ? "" : `-st${seasonType}`}.json`;
  }
  /** The team document plus the regular season and postseason schedules a page is built from. */
  hasSaved(league, teamId, season) {
    if (!this.savedDir || season === void 0) return false;
    const dir = this.savedDir;
    return [this.savedName(league, teamId), this.savedName(league, teamId, season, "2"), this.savedName(league, teamId, season, "3")].every((name) => existsSync5(join5(dir, name)));
  }
  /** Answers a provider URL with the saved document that URL returned when it was captured. */
  readSaved(league, teamId) {
    const dir = this.savedDir;
    return async (url) => {
      const parsed = new URL(url);
      const schedule = parsed.pathname.endsWith("/schedule");
      const season = parsed.searchParams.get("season");
      if (schedule && !season) throw new Error("saved schedules are stored by season");
      const name = schedule ? this.savedName(league, teamId, Number(season), parsed.searchParams.get("seasontype") ?? "2") : this.savedName(league, teamId);
      return JSON.parse(await readFile(join5(dir, name), "utf8"));
    };
  }
  remember(key, result) {
    const ttl = !result.ok ? FAILURE_TTL_MS : result.page.schedule.some((g) => g.status.state === "in") ? LIVE_TTL_MS : IDLE_TTL_MS;
    this.cache.delete(key);
    this.cache.set(key, { expires: this.now() + ttl, result });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) break;
      this.cache.delete(oldest);
    }
  }
};

// shared/version.ts
var VERSION = "0.6.0";

// server/index.ts
var ROOT = resolve3(dirname4(fileURLToPath(import.meta.url)), "..");
var config = loadConfig(process.env, ROOT);
var startedAt = Date.now();
var fetcher = new ProviderFetcher(config.fetch);
var lab = new ReplayLab({
  fixturesDir: resolve3(ROOT, process.env.GRIDIRON_FIXTURES_DIR ?? "fixtures/espn"),
  maxSessions: config.maxReplaySessions
});
function sportradarProvider() {
  try {
    const settings = loadSportradarConfig(process.env);
    for (const warning of settings.warnings) console.warn(`[sportradar] ${warning}`);
    return new SportradarProvider(settings);
  } catch (e) {
    console.error(`Sportradar could not start: ${e.message}`);
    process.exit(1);
  }
}
var marketsOff = config.provider === "replay" ? "A replay server shows only the prices captured for its games" : process.env.GRIDIRON_MARKETS === "off" ? "Market prices are turned off on this server" : null;
var markets = marketsOff ? null : new MarketService({ fetcher: new ProviderFetcher({ ...config.fetch, maxConcurrent: 2, budgetPerMinute: 60, maxRetries: 1 }), log: (message) => console.warn(`[markets] ${message}`) });
var engine;
if (config.provider === "replay") {
  const created = lab.create(config.replayScenario, { persistent: true });
  if ("error" in created) {
    console.error(`Replay scenario "${config.replayScenario}" could not start: ${created.error}`);
    process.exit(1);
  }
  engine = lab.engine(created.id);
} else {
  const provider = config.provider === "sportradar" ? sportradarProvider() : new EspnProvider(fetcher, { coverageCacheFile: config.cacheDir ? join6(config.cacheDir, "espn-coverage.json") : null });
  engine = new GridironEngine({
    provider,
    mode: "live",
    intervals: config.intervals,
    log: (message) => console.warn(`[engine] ${message}`),
    marketHistory: markets ? (game) => markets.history(game) : void 0
  });
  engine.start();
}
var teams = config.provider === "sportradar" ? null : new TeamService({ fetcher, savedDir: resolve3(ROOT, process.env.GRIDIRON_TEAM_FIXTURES_DIR ?? "fixtures/espn/team") });
var parties = new PartyHub();
parties.start();
var push = setupPush({ engine, env: process.env, cacheDir: config.cacheDir, production: config.production, trustProxy: config.trustProxy });
push.start();
markets?.start(engine);
var app = createApp({
  engine,
  replay: config.maxReplaySessions > 0 ? lab : null,
  staticDir: process.env.GRIDIRON_STATIC_DIR === "none" ? null : config.staticDir,
  maxStreams: config.maxStreams,
  version: VERSION,
  fetcherStats: () => ({ ...fetcher.stats() }),
  startedAt,
  teams,
  routes: [createPartyRoutes({ hub: parties, trustProxy: config.trustProxy, maxStreams: config.maxStreams }), push.routes],
  health: () => ({
    party: { available: true, ...parties.stats() },
    teams: teams?.stats() ?? null,
    push: push.health(),
    markets: markets ? { available: true, ...markets.stats() } : { available: false, reason: marketsOff }
  })
});
var server = createServer((req, res) => {
  void app(req, res);
});
server.keepAliveTimeout = 65e3;
server.headersTimeout = 66e3;
server.listen(config.port, config.host, () => {
  const mode = config.provider === "replay" ? `replay lab (${config.replayScenario})` : config.provider === "sportradar" ? "licensed Sportradar data" : "live ESPN data";
  console.log(`Gridiron server on http://${config.host}:${config.port} using ${mode}`);
});
var stopping = false;
var shutdown = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`Gridiron server stopping (${signal})`);
  setTimeout(() => process.exit(0), 5e3).unref();
  engine.stop();
  markets?.stop();
  lab.stopAll();
  parties.stop();
  void push.stop().finally(() => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 1e3).unref();
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
//# sourceMappingURL=index.mjs.map
