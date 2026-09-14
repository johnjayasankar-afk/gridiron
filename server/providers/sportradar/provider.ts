/**
 * The Sportradar provider: an optional, licensed alternative to ESPN.
 *
 * Nothing here has been run against Sportradar's real API. It follows the public
 * documentation (developer.sportradar.com, checked 2026-09-14) and is tested
 * offline against hand-written fixtures.
 *
 * - A day's slate comes from the league's current season schedule, cached and
 *   refreshed rarely, filtered by the US Eastern date of each game's scheduled
 *   time. There is no by-date schedule feed.
 * - Games that are live, final, or past their scheduled kickoff are read from
 *   their boxscore. Games that have not reached kickoff use the schedule.
 * - Detail is the game's play-by-play.
 * - Every request goes through SportradarClient: 1 query per second per key by
 *   default, and back-off on HTTP 429.
 * - A failure is reported, never covered: a game whose boxscore cannot be read
 *   is left out of the slate and its league is marked unavailable, so the engine
 *   keeps what it already had and marks it stale.
 * - A league without a key reports unavailable with the variable to set.
 */
import type { Division, DivisionCoverage, GameDetail, GameId, GameSummary, LeagueId } from '../../../shared/model.js';
import { isLiveOrPaused } from '../../../shared/model.js';
import type { DetailResult, ProviderError, ProviderInfo, ProviderPushEvent, SlateOptions, SlateResult, SportsProvider } from '../types.js';
import { boxscoreUrl, playByPlayUrl, pushEventsUrl, seasonScheduleUrl, SportradarClient } from './client.js';
import { missingKeyMessage, TRIAL_LIMITS, type ApiKey, type SportradarConfig } from './config.js';
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  isSportradarUuid,
  newSportradarDiagnostics,
  normalizeBoxscore,
  normalizePlayByPlay,
  normalizeStatus,
  parseSchedule,
  parseSportradarGameId,
  sportradarGameId,
  summaryFromPush,
  summaryFromSchedule,
  type ScheduleEntry,
  type SportradarDiagnostics,
} from './normalize.js';
import { SportradarPushStream, type PushStreamEvent } from './push.js';
import { obj, str } from '../espn/raw.js';

const LEAGUE_LABEL: Record<LeagueId, string> = { nfl: 'NFL', cfb: 'NCAA football' };

/** How long a season schedule is reused before it is read again. */
const SCHEDULE_TTL_MS = 6 * 60 * 60_000;
/** Sportradar documents that live feeds refresh every 3 seconds, so a younger copy cannot be older than the feed. */
const LIVE_REFRESH_MS = 3_000;
/** A "complete" game's score is final but its stats are still being verified: re-read it now and then. */
const COMPLETE_REFRESH_MS = 5 * 60_000;
const MAX_DOCUMENTS = 400;
const PUSH_BACKFILL_DELAY_MS = 3_000;

export interface PushStreamLike {
  on(listener: (event: PushStreamEvent) => void): () => void;
  start(): void;
  stop(): Promise<void>;
}

export interface SportradarProviderOptions {
  client?: SportradarClient;
  now?: () => number;
  /** Queries per second per key, when no client is passed. Defaults to the trial limit of 1. */
  queriesPerSecond?: number;
  scheduleTtlMs?: number;
  pushStream?: (league: LeagueId, url: string, key: ApiKey) => PushStreamLike;
}

interface CachedDocument {
  data: unknown;
  receivedAt: number;
}

type DocumentRead = { ok: true; data: unknown; receivedAt: number } | { ok: false; error: string; status: number | null; receivedAt: number };

/** Keep a cached boxscore or play-by-play this long, by the status it reported. */
function maxAgeFor(data: unknown): number {
  const status = str(obj(data)?.status)?.toLowerCase();
  if (status === 'closed') return Number.POSITIVE_INFINITY;
  if (status === 'complete') return COMPLETE_REFRESH_MS;
  return LIVE_REFRESH_MS;
}

export class SportradarProvider implements SportsProvider {
  readonly info: ProviderInfo;
  readonly diagnostics: SportradarDiagnostics = newSportradarDiagnostics();
  readonly subscribe?: (onEvent: (event: ProviderPushEvent) => void) => () => void;

  private readonly client: SportradarClient;
  private readonly now: () => number;
  private readonly scheduleTtlMs: number;
  private readonly schedules = new Map<LeagueId, { entries: ScheduleEntry[]; receivedAt: number }>();
  private readonly documents = new Map<string, CachedDocument>();
  private readonly summaries = new Map<GameId, GameSummary>();
  private readonly pushListeners = new Set<(event: ProviderPushEvent) => void>();
  private readonly backfills = new Map<GameId, ReturnType<typeof setTimeout>>();
  private streams: PushStreamLike[] = [];

  constructor(
    private readonly config: SportradarConfig,
    private readonly options: SportradarProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.client = options.client ?? new SportradarClient({ now: this.now, queriesPerSecond: options.queriesPerSecond ?? TRIAL_LIMITS.queriesPerSecond });
    this.scheduleTtlMs = options.scheduleTtlMs ?? SCHEDULE_TTL_MS;
    const leagues = (['nfl', 'cfb'] as const).filter((l) => config.keys[l]).map((l) => LEAGUE_LABEL[l]);
    const push = config.push && config.accessLevel === 'production';
    this.info = {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      description:
        `Sportradar NFL and NCAA Football v7 APIs on ${config.accessLevel} access, for ${leagues.join(' and ')}. Licensed. ` +
        `Requests are queued per key within the queries-per-second limit. ${push ? 'Push events are streamed, with play-by-play re-read after each event.' : 'Polled, not pushed.'}`,
      licensed: true,
      push,
      // College divisions are not named in the documented schedule and game fields, so none are claimed.
      divisions: config.keys.nfl ? ['NFL'] : [],
    };
    if (push) this.subscribe = (onEvent) => this.addPushListener(onEvent);
  }

  // ------------------------------------------------------------ slate

  async fetchSlate(league: LeagueId, dateKey: string, _options: SlateOptions): Promise<SlateResult> {
    const label = LEAGUE_LABEL[league];
    const key = this.config.keys[league];
    const unavailable = (error: ProviderError, limitations: string[] = []): SlateResult => ({
      league,
      dateKey,
      games: [],
      divisions: league === 'nfl' ? [{ division: 'NFL', label: 'NFL', providerGroupId: null, games: 0, health: 'unavailable' }] : [],
      errors: [error],
      failed: true,
      receivedAt: this.now(),
      discovery: `${label} games come from Sportradar's current season schedule.`,
      limitations,
    });
    if (!key) return unavailable({ scope: `${label} schedule`, message: missingKeyMessage(league), status: null });

    const schedule = await this.schedule(league, key);
    if (!schedule.value) return unavailable(schedule.error ?? { scope: `${label} schedule`, message: 'Schedule unavailable', status: null });
    const errors: ProviderError[] = schedule.error ? [schedule.error] : [];
    const limitations = this.limitations(league);
    if (schedule.error) {
      limitations.push(`The ${label} season schedule could not be refreshed; games that have not reached kickoff use the copy read at ${new Date(schedule.value.receivedAt).toISOString()}.`);
    }

    const day = schedule.value.entries.filter((e) => e.dateKey === dateKey);
    const divisions: Division[] = league === 'nfl' ? ['NFL'] : [];
    const results = await Promise.all(day.map((entry) => this.summaryFor(entry, league, key, divisions)));
    const games: GameSummary[] = [];
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
    games.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? '') || a.id.localeCompare(b.id));
    if (games.some((g) => g.status.providerCode?.toLowerCase() === 'complete')) {
      limitations.push('Some final scores are marked complete: the score is final but Sportradar is still verifying the statistics.');
    }

    const coverage: DivisionCoverage[] =
      league === 'nfl'
        ? [{
            division: 'NFL',
            label: unreadable ? `NFL (${unreadable} of ${day.length} games could not be read)` : 'NFL',
            providerGroupId: null,
            games: games.length,
            // "unavailable" tells the engine to keep the games it already has instead of dropping them.
            health: unreadable ? 'unavailable' : 'connected',
          }]
        : [];
    return {
      league,
      dateKey,
      games,
      divisions: coverage,
      errors,
      failed: false,
      receivedAt: this.now(),
      discovery: `${label} games for ${dateKey} from Sportradar's current season schedule, filtered by the US Eastern date of each scheduled time. Live and final games are read from their boxscores.`,
      limitations,
    };
  }

  private limitations(league: LeagueId): string[] {
    const out: string[] = [];
    if (this.config.accessLevel === 'trial') {
      out.push(`Sportradar trial access allows ${TRIAL_LIMITS.queriesPerSecond} query per second and ${TRIAL_LIMITS.requestsPer30Days.toLocaleString('en-US')} requests per 30 days, so games are read slowly and the quota runs out quickly while games are live.`);
    }
    if (league === 'cfb') {
      out.push("Sportradar's documented schedule and game fields do not name a college game's division, so college games are not sorted into FBS, FCS, Division II or Division III, and the division filter cannot narrow them.");
    }
    out.push('Only the current season schedule is read, so days outside the current season have no games.');
    return out;
  }

  private async schedule(league: LeagueId, key: ApiKey): Promise<{ value: { entries: ScheduleEntry[]; receivedAt: number } | null; error: ProviderError | null }> {
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
      return { value: cached, error: { scope, message: (e as Error).message, status: res.status } };
    }
  }

  private async summaryFor(entry: ScheduleEntry, league: LeagueId, key: ApiKey, divisions: Division[]): Promise<{ ok: true; summary: GameSummary } | { ok: false; error: ProviderError }> {
    const scope = `${LEAGUE_LABEL[league]} game ${entry.uuid}`;
    const cachedBox = this.documents.get(boxscoreUrl(league, this.config.accessLevel, entry.uuid));
    const kind = normalizeStatus(str(obj(cachedBox?.data)?.status) ?? entry.status, null, null).kind;
    const start = entry.scheduled ? Date.parse(entry.scheduled) : NaN;
    const started = Number.isFinite(start) && this.now() >= start;
    const needsBoxscore = kind === 'final' || isLiveOrPaused(kind) || ((kind === 'scheduled' || kind === 'unknown') && started);
    try {
      if (!needsBoxscore) return { ok: true, summary: summaryFromSchedule(entry, league, divisions) };
      const doc = await this.document(boxscoreUrl(league, this.config.accessLevel, entry.uuid), key);
      if (!doc.ok) return { ok: false, error: { scope: `${scope} boxscore`, message: doc.error, status: doc.status } };
      return { ok: true, summary: normalizeBoxscore(doc.data, league, divisions) };
    } catch (e) {
      this.diagnostics.invalidGames++;
      return { ok: false, error: { scope, message: (e as Error).message, status: null } };
    }
  }

  /** A boxscore or play-by-play document, reused while younger than its status allows. */
  private async document(url: string, key: ApiKey): Promise<DocumentRead> {
    const cached = this.documents.get(url);
    if (cached && this.now() - cached.receivedAt < maxAgeFor(cached.data)) return { ok: true, data: cached.data, receivedAt: cached.receivedAt };
    const res = await this.client.getJson(url, key);
    if (!res.ok) return { ok: false, error: res.error, status: res.status, receivedAt: res.receivedAt };
    this.documents.delete(url);
    this.documents.set(url, { data: res.data, receivedAt: res.receivedAt });
    while (this.documents.size > MAX_DOCUMENTS) this.documents.delete(this.documents.keys().next().value as string);
    return { ok: true, data: res.data, receivedAt: res.receivedAt };
  }

  private remember(summary: GameSummary) {
    this.summaries.delete(summary.id);
    this.summaries.set(summary.id, summary);
    while (this.summaries.size > MAX_DOCUMENTS) this.summaries.delete(this.summaries.keys().next().value as string);
  }

  // ------------------------------------------------------------ detail

  async fetchDetail(id: GameId, knownDivisions?: Division[]): Promise<DetailResult> {
    const scope = 'Game detail';
    const parsed = parseSportradarGameId(id);
    if (!parsed) return { ok: false, error: { scope, message: `Not a Sportradar game id: ${id}`, status: null }, receivedAt: this.now() };
    const key = this.config.keys[parsed.league];
    if (!key) return { ok: false, error: { scope, message: missingKeyMessage(parsed.league), status: null }, receivedAt: this.now() };
    const doc = await this.document(playByPlayUrl(parsed.league, this.config.accessLevel, parsed.uuid), key);
    if (!doc.ok) return { ok: false, error: { scope, message: doc.error, status: doc.status }, receivedAt: doc.receivedAt };
    let detail: GameDetail;
    try {
      detail = normalizePlayByPlay(doc.data, parsed.league, knownDivisions ?? (parsed.league === 'nfl' ? ['NFL'] : []), this.diagnostics);
    } catch (e) {
      return { ok: false, error: { scope, message: (e as Error).message, status: null }, receivedAt: doc.receivedAt };
    }
    if (detail.gameId !== id) {
      return { ok: false, error: { scope, message: `Play-by-play for ${id} described a different game`, status: null }, receivedAt: doc.receivedAt };
    }
    this.remember(detail.summary);
    return { ok: true, detail, receivedAt: doc.receivedAt };
  }

  // ------------------------------------------------------------ push

  private addPushListener(onEvent: (event: ProviderPushEvent) => void): () => void {
    this.pushListeners.add(onEvent);
    if (!this.streams.length) {
      for (const league of ['nfl', 'cfb'] as const) {
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

  private emitPush(event: ProviderPushEvent) {
    for (const listener of [...this.pushListeners]) {
      try {
        listener(event);
      } catch {
        // One failing listener must not stop the others.
      }
    }
  }

  private onPush(league: LeagueId, event: PushStreamEvent) {
    if (event.type === 'open' && event.attempt > 1) {
      // No resume after a reconnect: re-read play-by-play for games that were live.
      for (const s of this.summaries.values()) if (s.league === league && isLiveOrPaused(s.status.kind)) this.backfill(s.id);
      return;
    }
    if (event.type !== 'message' || event.message.type !== 'event') return;
    const { game, event: play } = event.message;
    const uuid = str(game?.id);
    if (!isSportradarUuid(uuid)) {
      this.diagnostics.unattributedPushEvents++;
      return;
    }
    const id = sportradarGameId(league, uuid);
    let summary: GameSummary;
    try {
      summary = summaryFromPush(game, play, league, this.summaries.get(id) ?? null);
    } catch {
      this.diagnostics.unattributedPushEvents++;
      return;
    }
    this.remember(summary);
    this.emitPush({ gameId: id, kind: 'summary', summary, receivedAt: event.at });
    if (play) this.backfill(id);
  }

  /** Re-read one game's play-by-play shortly after push activity, once per burst. */
  private backfill(id: GameId) {
    if (this.backfills.has(id)) return;
    const timer = setTimeout(() => {
      this.backfills.delete(id);
      void this.fetchDetail(id, this.summaries.get(id)?.divisions).then((res) => {
        if (res.ok && this.pushListeners.size) this.emitPush({ gameId: id, kind: 'detail', detail: res.detail, receivedAt: res.receivedAt });
      });
    }, PUSH_BACKFILL_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
    this.backfills.set(id, timer);
  }
}
