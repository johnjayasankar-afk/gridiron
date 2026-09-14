/**
 * College coverage discovery.
 *
 * ESPN's site scoreboard filters college games with a `groups` parameter, and
 * the default college scoreboard returns only one division. Group ids are not
 * guessed: they are read from ESPN's core API, which lists the season type's
 * top-level groups ("NCAA Division I", "Division II/III") and their children
 * ("FBS", "FCS", "NCAA Division II", "NCAA Division III"). The mapping from a
 * child group's own name to Gridiron's division is the only interpretation.
 *
 * Observed on 2026-09-12: FBS 80 games, FCS 78, 33 in both (FBS vs FCS),
 * Division II 72, Division III 105. Each child returned the same count with
 * limit=500 as with no limit; limit=999 silently fell back to 25 results.
 */
import type { Division } from '../../../shared/model.js';
import type { ProviderFetcher } from '../../fetcher.js';
import { arr, obj, str } from './raw.js';

export interface DivisionGroup {
  division: Division;
  label: string;
  groupId: string;
  parentId: string | null;
  parentName: string | null;
}

export interface DiscoveredCoverage {
  season: number;
  seasonType: number;
  groups: DivisionGroup[];
  discoveredAt: number;
  source: string;
}

export const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

/** Map a provider group's own naming to a division. Order matters: "Division III" contains "Division II". */
export function divisionFromGroupName(g: { name?: string | null; abbreviation?: string | null; shortName?: string | null }): Division | null {
  const text = [g.name, g.abbreviation, g.shortName].filter(Boolean).join(' | ').toLowerCase();
  if (/\bfbs\b|division i-a\b|\bi-a\b/.test(text)) return 'FBS';
  if (/\bfcs\b|division i-aa\b|\bi-aa\b/.test(text)) return 'FCS';
  if (/division iii\b|\bd3\b/.test(text)) return 'D3';
  if (/division ii\b|\bd2\b/.test(text)) return 'D2';
  return null;
}

const LABEL: Record<Division, string> = { NFL: 'NFL', FBS: 'FBS', FCS: 'FCS', D2: 'Division II', D3: 'Division III' };

/** Core API references point at an internal host or plain http; only follow refs on the public core host. */
export function coreRef(ref: unknown): string | null {
  const s = str(ref);
  if (!s) return null;
  try {
    const u = new URL(s);
    u.protocol = 'https:';
    if (u.hostname === 'sports.core.api.espn.pvt') u.hostname = 'sports.core.api.espn.com';
    if (u.hostname !== 'sports.core.api.espn.com') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function discoverCollegeDivisions(
  fetcher: ProviderFetcher,
  season: number,
  seasonType: number,
  now: () => number = Date.now,
): Promise<DiscoveredCoverage> {
  const listUrl = `${CORE_BASE}/seasons/${season}/types/${seasonType}/groups?limit=100`;
  const list = await fetcher.getJson<unknown>(listUrl);
  if (!list.ok) throw new Error(`College group list unavailable: ${list.error}`);
  const parents = arr(obj(list.data)?.items).map((it) => coreRef(obj(it)?.$ref)).filter((u): u is string => !!u);
  if (!parents.length) throw new Error('College group list was empty');

  const groups: DivisionGroup[] = [];
  for (const parentUrl of parents) {
    const parent = await fetcher.getJson<unknown>(parentUrl);
    const p = parent.ok ? obj(parent.data) : null;
    const parentId = str(p?.id);
    const parentName = str(p?.name);
    const childrenUrl = `${parentUrl.split('?')[0]}/children?limit=100`;
    const children = await fetcher.getJson<unknown>(childrenUrl);
    if (!children.ok) continue;
    for (const item of arr(obj(children.data)?.items)) {
      const ref = coreRef(obj(item)?.$ref);
      if (!ref) continue;
      const child = await fetcher.getJson<unknown>(ref);
      const c = child.ok ? obj(child.data) : null;
      const id = str(c?.id);
      if (!c || !id) continue;
      const division = divisionFromGroupName({ name: str(c.name), abbreviation: str(c.abbreviation), shortName: str(c.shortName) });
      if (!division || groups.some((g) => g.division === division)) continue;
      groups.push({ division, label: LABEL[division], groupId: id, parentId, parentName });
    }
  }
  if (!groups.length) throw new Error('No recognisable college divisions in the provider group list');
  const order: Division[] = ['FBS', 'FCS', 'D2', 'D3'];
  groups.sort((a, b) => order.indexOf(a.division) - order.indexOf(b.division));
  return { season, seasonType, groups, discoveredAt: now(), source: listUrl };
}

/**
 * Season and season type for a provider day, read from the scoreboard's league
 * calendar. Returns null when the date is outside every calendar entry.
 */
export function seasonForDate(scoreboard: unknown, dateKey: string): { season: number; seasonType: number } | null {
  const league = obj(arr(obj(scoreboard)?.leagues)[0]);
  if (!league) return null;
  const season = Number(str(obj(league.season)?.year));
  const noonEastern = Date.parse(`${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}T16:00:00Z`);
  for (const entry of arr(league.calendar)) {
    const e = obj(entry);
    const start = Date.parse(str(e?.startDate) ?? '');
    const end = Date.parse(str(e?.endDate) ?? '');
    const type = Number(str(e?.value));
    if (Number.isFinite(start) && Number.isFinite(end) && noonEastern >= start && noonEastern < end && Number.isFinite(type)) {
      return { season: Number.isFinite(season) ? season : new Date(noonEastern).getUTCFullYear(), seasonType: type };
    }
  }
  return null;
}
