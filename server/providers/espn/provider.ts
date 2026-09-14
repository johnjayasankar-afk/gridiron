/**
 * The ESPN site API provider: Gridiron's working default.
 *
 * These endpoints are public but undocumented. Nothing guarantees their
 * availability, latency or shape, so every response is validated and a failure
 * is reported as a failure. The provider never substitutes other data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConferenceInfo, Division, DivisionCoverage, GameSummary, LeagueId } from '../../../shared/model.js';
import { parseGameId } from '../../../shared/model.js';
import type { ProviderFetcher } from '../../fetcher.js';
import type { DetailResult, ProviderError, ProviderInfo, SlateOptions, SlateResult, SportsProvider } from '../types.js';
import { CORE_BASE, discoverCollegeDivisions, seasonForDate, type DiscoveredCoverage } from './coverage.js';
import {
  newDiagnostics,
  normalizeScoreboardEvent,
  normalizeSummary,
  parseScoreboard,
  RESULT_LIMIT,
  scoreboardUrl,
  type NormalizeDiagnostics,
} from './normalize.js';
import { arr, at, num, obj, str } from './raw.js';

const DISCOVERY_TTL_MS = 12 * 60 * 60_000;
const SEASON_TTL_MS = 6 * 60 * 60_000;
const CONFERENCE_TTL_MS = 24 * 60 * 60_000;

export interface EspnProviderOptions {
  now?: () => number;
  /** Where the last successful division discovery is remembered between restarts. */
  coverageCacheFile?: string | null;
}

export class EspnProvider implements SportsProvider {
  readonly info: ProviderInfo = {
    id: 'espn',
    name: 'ESPN',
    description:
      'ESPN public site API. Undocumented and unlicensed: no guarantee of availability, latency or completeness. Polled, not pushed.',
    licensed: false,
    push: false,
    divisions: ['NFL', 'FBS', 'FCS', 'D2', 'D3'],
  };

  readonly diagnostics: NormalizeDiagnostics = newDiagnostics();
  private coverage = new Map<string, DiscoveredCoverage>();
  private conferences = new Map<string, { info: ConferenceInfo | null; at: number }>();
  private seasons = new Map<string, { value: { season: number; seasonType: number } | null; at: number }>();
  private readonly now: () => number;

  constructor(
    private readonly fetcher: ProviderFetcher,
    private readonly options: EspnProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.loadCoverageCache();
  }

  // ------------------------------------------------------------ slate

  async fetchSlate(league: LeagueId, dateKey: string, options: SlateOptions): Promise<SlateResult> {
    return league === 'nfl' ? this.fetchNflSlate(dateKey) : this.fetchCollegeSlate(dateKey, options.divisions);
  }

  private async fetchNflSlate(dateKey: string): Promise<SlateResult> {
    const url = scoreboardUrl('nfl', dateKey);
    const res = await this.fetcher.getJson<unknown>(url);
    const base = { league: 'nfl' as const, dateKey, receivedAt: res.receivedAt, discovery: 'NFL scoreboard for the day', limitations: [] as string[] };
    if (!res.ok) {
      return { ...base, games: [], divisions: [{ division: 'NFL', label: 'NFL', providerGroupId: null, games: 0, health: 'unavailable' }], errors: [{ scope: 'NFL scoreboard', message: res.error, status: res.status }], failed: true };
    }
    const parsed = parseScoreboard(res.data);
    if (!parsed.ok) {
      return { ...base, games: [], divisions: [{ division: 'NFL', label: 'NFL', providerGroupId: null, games: 0, health: 'unavailable' }], errors: [{ scope: 'NFL scoreboard', message: parsed.error, status: res.status }], failed: true };
    }
    const games = parsed.value.events
      .map((e) => normalizeScoreboardEvent(e, 'nfl', ['NFL'], this.diagnostics))
      .filter((g): g is GameSummary => g !== null);
    if (parsed.value.events.length >= RESULT_LIMIT) base.limitations.push(`The NFL scoreboard returned ${RESULT_LIMIT} games, its request limit; some games may be missing.`);
    return { ...base, games, divisions: [{ division: 'NFL', label: 'NFL', providerGroupId: null, games: games.length, health: 'connected' }], errors: [], failed: false };
  }

  private async seasonFor(dateKey: string): Promise<{ season: number; seasonType: number } | null> {
    const cached = this.seasons.get(dateKey);
    if (cached && this.now() - cached.at < SEASON_TTL_MS) return cached.value;
    const res = await this.fetcher.getJson<unknown>(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${dateKey}`);
    if (!res.ok) return cached?.value ?? null;
    let value = seasonForDate(res.data, dateKey);
    if (!value) {
      // Outside every calendar entry (the offseason): fall back to the season the scoreboard reports.
      const year = num(at(res.data, 'season', 'year'));
      const type = num(at(res.data, 'season', 'type'));
      value = year !== null && type !== null ? { season: year, seasonType: type } : null;
    }
    this.seasons.set(dateKey, { value, at: this.now() });
    return value;
  }

  private async divisionsFor(dateKey: string): Promise<{ coverage: DiscoveredCoverage | null; note: string | null }> {
    const season = await this.seasonFor(dateKey);
    if (!season) {
      const any = [...this.coverage.values()].sort((a, b) => b.discoveredAt - a.discoveredAt)[0] ?? null;
      return { coverage: any, note: any ? 'Season could not be read; using the most recent division list.' : 'College season could not be read from the provider.' };
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
      if (cached) return { coverage: cached, note: `Division discovery failed (${(e as Error).message}); using the list discovered earlier.` };
      // A different season type (for example postseason) may share the same divisions.
      const any = [...this.coverage.values()].sort((a, b) => b.discoveredAt - a.discoveredAt)[0] ?? null;
      return { coverage: any, note: any ? `Division discovery failed (${(e as Error).message}); using the most recent division list.` : `Division discovery failed: ${(e as Error).message}` };
    }
  }

  private async fetchCollegeSlate(dateKey: string, wanted: Division[]): Promise<SlateResult> {
    const receivedAt = this.now();
    const { coverage, note } = await this.divisionsFor(dateKey);
    const limitations: string[] = [];
    if (note) limitations.push(note);
    if (!coverage) {
      return {
        league: 'cfb', dateKey, games: [], divisions: [], receivedAt, failed: true,
        errors: [{ scope: 'College divisions', message: note ?? 'College divisions unavailable', status: null }],
        discovery: 'College divisions could not be discovered', limitations,
      };
    }
    const groups = coverage.groups.filter((g) => wanted.includes(g.division));
    const results = await Promise.all(
      groups.map(async (g) => ({ group: g, res: await this.fetcher.getJson<unknown>(scoreboardUrl('cfb', dateKey, g.groupId)) })),
    );
    const merged = new Map<string, { raw: unknown; divisions: Division[] }>();
    const divisions: DivisionCoverage[] = [];
    const errors: ProviderError[] = [];
    for (const { group, res } of results) {
      if (!res.ok) {
        errors.push({ scope: `${group.label} scoreboard`, message: res.error, status: res.status });
        divisions.push({ division: group.division, label: group.label, providerGroupId: group.groupId, games: 0, health: 'unavailable' });
        continue;
      }
      const parsed = parseScoreboard(res.data);
      if (!parsed.ok) {
        errors.push({ scope: `${group.label} scoreboard`, message: parsed.error, status: res.status });
        divisions.push({ division: group.division, label: group.label, providerGroupId: group.groupId, games: 0, health: 'unavailable' });
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
      divisions.push({ division: group.division, label: group.label, providerGroupId: group.groupId, games: parsed.value.events.length, health: 'connected' });
    }
    const games = [...merged.values()]
      .map(({ raw, divisions: d }) => normalizeScoreboardEvent(raw, 'cfb', d, this.diagnostics))
      .filter((g): g is GameSummary => g !== null);
    const conferenceIds = [...new Set(games.flatMap((g) => [g.home.conferenceId, g.away.conferenceId]).filter((id): id is string => !!id))];
    return {
      league: 'cfb',
      dateKey,
      games,
      divisions,
      conferences: await this.conferenceInfo(conferenceIds, coverage),
      errors,
      failed: groups.length > 0 && errors.length === groups.length,
      receivedAt,
      discovery: `Divisions discovered from ESPN's group list for season ${coverage.season}, type ${coverage.seasonType}: ${coverage.groups.map((g) => `${g.label} (group ${g.groupId})`).join(', ')}. Games in more than one division appear once.`,
      limitations,
    };
  }

  /**
   * Conference names for the ids seen in a slate, from the provider's group
   * documents (for example group 8 is "Southeastern Conference", short name
   * "SEC"). Unknown ids are looked up once a day; a failed lookup is retried on a
   * later slate and the conference is simply left out of the filter meanwhile.
   */
  private async conferenceInfo(ids: string[], coverage: DiscoveredCoverage): Promise<ConferenceInfo[]> {
    const due = ids
      .filter((id) => /^\d{1,6}$/.test(id))
      .filter((id) => {
        const cached = this.conferences.get(id);
        return !cached || this.now() - cached.at > CONFERENCE_TTL_MS;
      })
      .slice(0, 40);
    await Promise.all(
      due.map(async (id) => {
        const res = await this.fetcher.getJson<unknown>(`${CORE_BASE}/seasons/${coverage.season}/types/${coverage.seasonType}/groups/${id}`);
        if (!res.ok) {
          if (res.status === 404) this.conferences.set(id, { info: null, at: this.now() });
          return;
        }
        const g = obj(res.data);
        const name = str(g?.name);
        const shortName = str(g?.shortName) ?? str(g?.midsizeName) ?? str(g?.abbreviation)?.toUpperCase() ?? null;
        this.conferences.set(id, { info: name ? { id, name, shortName: shortName ?? name } : null, at: this.now() });
      }),
    );
    return ids
      .map((id) => this.conferences.get(id)?.info ?? null)
      .filter((c): c is ConferenceInfo => c !== null)
      .sort((a, b) => a.shortName.localeCompare(b.shortName));
  }

  // ------------------------------------------------------------ detail

  async fetchDetail(id: string, knownDivisions?: Division[]): Promise<DetailResult> {
    const parsedId = parseGameId(id);
    if (!parsedId) return { ok: false, error: { scope: 'Game detail', message: `Unknown game id ${id}`, status: null }, receivedAt: this.now() };
    const league = parsedId.league;
    const path = league === 'nfl' ? 'nfl' : 'college-football';
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/${path}/summary?event=${encodeURIComponent(parsedId.providerEventId)}`;
    const res = await this.fetcher.getJson<unknown>(url);
    if (!res.ok) return { ok: false, error: { scope: 'Game detail', message: res.error, status: res.status }, receivedAt: res.receivedAt };
    const detail = normalizeSummary(res.data, league, knownDivisions ?? (league === 'nfl' ? ['NFL'] : []), this.diagnostics);
    if (!detail) return { ok: false, error: { scope: 'Game detail', message: 'Game summary did not have the expected shape', status: res.status }, receivedAt: res.receivedAt };
    return { ok: true, detail, receivedAt: res.receivedAt };
  }

  // ------------------------------------------------------------ cache

  private loadCoverageCache() {
    const file = this.options.coverageCacheFile;
    if (!file || !existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      for (const item of arr(data)) {
        const c = obj(item);
        const season = num(c?.season);
        const seasonType = num(c?.seasonType);
        const groups = arr(c?.groups).map(obj).filter((g): g is Record<string, unknown> => !!g && !!str(g.groupId) && !!str(g.division));
        if (season === null || seasonType === null || !groups.length) continue;
        this.coverage.set(`${season}-${seasonType}`, {
          season,
          seasonType,
          discoveredAt: num(c?.discoveredAt) ?? 0,
          source: str(c?.source) ?? 'cache',
          groups: groups.map((g) => ({
            division: str(g.division) as Division,
            label: str(g.label) ?? String(g.division),
            groupId: str(g.groupId) as string,
            parentId: str(g.parentId),
            parentName: str(g.parentName),
          })),
        });
      }
    } catch {
      // A corrupt cache is ignored; discovery runs again.
    }
  }

  private saveCoverageCache() {
    const file = this.options.coverageCacheFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify([...this.coverage.values()], null, 2));
    } catch {
      // Caching is an optimisation; failure to write is not fatal.
    }
  }
}
