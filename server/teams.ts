/**
 * Team pages for the API: a team's profile and season schedule from the
 * provider, cached briefly and shared by every viewer. The replay lab reads
 * saved team documents first (fixtures/espn/team), so replays and tests do not
 * depend on the network; a team without a complete saved set is fetched live.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LeagueId } from '../shared/model.js';
import type { TeamPage } from '../shared/team.js';
import type { FetchOutcome } from './fetcher.js';
import { fetchTeamPage, TEAM_ID_PATTERN } from './providers/espn/team.js';

/** Where a page came from: the provider just now, or saved provider documents. */
export type TeamSource = 'live' | 'saved';

export type TeamLookup = { ok: true; page: TeamPage; source: TeamSource } | { ok: false; status: 400 | 404 | 502; error: string };

export interface TeamLookupOptions {
  /** Defaults to the provider's current season. Saved documents are stored by season, so they need one. */
  season?: number;
  /** Prefer saved documents (the replay lab). */
  saved?: boolean;
}

export interface TeamServiceOptions {
  fetcher: { getJson<T>(url: string): Promise<FetchOutcome<T>> };
  /** Saved team documents, named as scripts/capture-team-fixtures.ts writes them. */
  savedDir?: string | null;
  now?: () => number;
  maxEntries?: number;
}

/** A schedule with a game in progress changes quickly; otherwise a team page holds for minutes. */
const LIVE_TTL_MS = 60_000;
const IDLE_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 20_000;

export class TeamService {
  private readonly cache = new Map<string, { expires: number; result: TeamLookup }>();
  private readonly inflight = new Map<string, Promise<TeamLookup>>();
  private readonly fetcher: TeamServiceOptions['fetcher'];
  private readonly savedDir: string | null;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: TeamServiceOptions) {
    this.fetcher = options.fetcher;
    this.savedDir = options.savedDir ?? null;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 256;
  }

  get(league: LeagueId, teamId: string, options: TeamLookupOptions = {}): Promise<TeamLookup> {
    if ((league !== 'nfl' && league !== 'cfb') || !TEAM_ID_PATTERN.test(teamId)) return Promise.resolve({ ok: false, status: 400, error: 'Invalid team id' });
    const key = `${league}-${teamId}|${options.season ?? 'current'}|${options.saved ? 'saved' : 'live'}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached.result);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = this.load(league, teamId, options)
      .then((result) => {
        this.remember(key, result);
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  stats() {
    return { cached: this.cache.size, loading: this.inflight.size };
  }

  private async load(league: LeagueId, teamId: string, options: TeamLookupOptions): Promise<TeamLookup> {
    if (options.saved && this.hasSaved(league, teamId, options.season)) {
      try {
        const page = await fetchTeamPage(this.readSaved(league, teamId), league, teamId, options.season, { now: this.now });
        return { ok: true, page, source: 'saved' };
      } catch (e) {
        return { ok: false, status: 502, error: `Saved team documents could not be read: ${(e as Error).message}` };
      }
    }
    try {
      const page = await fetchTeamPage(this.getJson, league, teamId, options.season, { now: this.now });
      return { ok: true, page, source: 'live' };
    } catch (e) {
      const message = (e as Error).message;
      return { ok: false, status: /\b404\b/.test(message) ? 404 : 502, error: `The team page could not be loaded: ${message}` };
    }
  }

  private readonly getJson = async (url: string): Promise<unknown> => {
    const res = await this.fetcher.getJson<unknown>(url);
    if (!res.ok) throw new Error(res.status ? `${res.status}: ${res.error}` : res.error);
    return res.data;
  };

  private savedName(league: LeagueId, teamId: string, season?: number, seasonType?: string): string {
    const base = `${league}-team-${teamId}`;
    if (season === undefined) return `${base}.json`;
    return `${base}-schedule-${season}${!seasonType || seasonType === '2' ? '' : `-st${seasonType}`}.json`;
  }

  /** The team document plus the regular season and postseason schedules a page is built from. */
  private hasSaved(league: LeagueId, teamId: string, season?: number): boolean {
    if (!this.savedDir || season === undefined) return false;
    const dir = this.savedDir;
    return [this.savedName(league, teamId), this.savedName(league, teamId, season, '2'), this.savedName(league, teamId, season, '3')].every((name) => existsSync(join(dir, name)));
  }

  /** Answers a provider URL with the saved document that URL returned when it was captured. */
  private readSaved(league: LeagueId, teamId: string) {
    const dir = this.savedDir as string;
    return async (url: string): Promise<unknown> => {
      const parsed = new URL(url);
      const schedule = parsed.pathname.endsWith('/schedule');
      const season = parsed.searchParams.get('season');
      if (schedule && !season) throw new Error('saved schedules are stored by season');
      const name = schedule ? this.savedName(league, teamId, Number(season), parsed.searchParams.get('seasontype') ?? '2') : this.savedName(league, teamId);
      return JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown;
    };
  }

  private remember(key: string, result: TeamLookup) {
    const ttl = !result.ok ? FAILURE_TTL_MS : result.page.schedule.some((g) => g.status.state === 'in') ? LIVE_TTL_MS : IDLE_TTL_MS;
    this.cache.delete(key);
    this.cache.set(key, { expires: this.now() + ttl, result });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) break;
      this.cache.delete(oldest);
    }
  }
}
