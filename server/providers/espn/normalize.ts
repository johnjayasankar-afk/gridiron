/**
 * ESPN site API → Gridiron model.
 *
 * Conventions established from real responses (51 NFL, FBS, FCS and Division II
 * games from 12-13 September 2026, 14,577 play states):
 *
 * - `possessionText` ("CIN 46") names the half the ball is in. It fixes the
 *   ball's physical position without knowing who has the ball.
 * - `yardLine` is measured from the HOME team's goal line. Where both existed it
 *   agreed with `possessionText` in 12,593 of 12,593 states.
 * - `team.id` on a play state is the team with the ball, except on timeouts and
 *   two-minute warnings, where it is the team that called the stoppage.
 * - `yardsToEndzone` is relative to the team with the ball, but disagreed with
 *   the label in 529 states. In 97 of 98 end-of-play disagreements the next
 *   play confirmed `team.id`, so `yardsToEndzone` is used only when neither the
 *   label nor `yardLine` is present.
 * - `yardLine` 0 with `yardsToEndzone` 0 is also how the feed writes "missing";
 *   it is accepted only for a scoring play by the away team, where it is real.
 * - Downs of 0 and -1 mark kickoffs and tries; only 1-4 are downs.
 * - `sequenceNumber` is not always monotonic, and a scoring play can be appended
 *   after the end of the game. Provider order is kept, except that a play whose
 *   wall-clock time is far earlier than the play before it is moved back.
 * - Kicked tries are written inside the touchdown play text, and the play's
 *   scores already include them.
 */
import type {
  BallSpot,
  Broadcast,
  CoverageCapabilities,
  Division,
  Drive,
  DriveEdge,
  GameDetail,
  GameStatus,
  GameStatusKind,
  GameSummary,
  VenueImage,
  HistoryGap,
  LeagueId,
  PlayBrief,
  PlayEvent,
  PlayKind,
  PlayState,
  Score,
  ScoreEvent,
  Situation,
  Team,
  TeamStat,
} from '../../../shared/model.js';
import { ADMIN_KINDS, TOUCHDOWN_KINDS, UNKNOWN_SPOT, gameId as toGameId, isLiveOrPaused, teamKey } from '../../../shared/model.js';
import { labelFromProgress, progressFromSchematicYard, type Side, type SpotProvenance } from '../../../shared/field.js';
import { clockToSeconds, fingerprint } from '../../../shared/util.js';
import { classifyPlayType, parseConversion, parseReview } from './classify.js';
import { lastPlayWinProbability, latestWinProbability, normalizeLines, normalizePredictor, normalizeVenueImage, normalizeWeather, normalizeWinProbability } from './odds.js';
import { arr, at, bool, hexColor, num, obj, safeUrl, str } from './raw.js';
import { VENUES } from '../../../shared/venues.js';

export const PROVIDER_NAME = 'ESPN';
export const SITE_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football';
export const RESULT_LIMIT = 500;

/**
 * How many people a venue holds, from the checked-in reference table.
 *
 * It is applied here rather than on the detail path so every summary carries it,
 * which means a card, a replay and a game page all draw the same sized bowl. A
 * stadium's capacity does not change between polls, or between a live game and a
 * replay of it, so there is nothing to look up and nothing to wait for.
 */
const BY_ID = new Map(VENUES.map((v) => [v.espnId, v]));
/*
 * By id first, and by name where there is no id.
 *
 * The provider did not always publish a venue id: captured scoreboards from
 * before it did name their venues and identify them with nothing. Falling back
 * to the name is safe here in a way a fuzzy match never is, because both strings
 * are the provider's own `fullName` for the same place, so the comparison is
 * exact rather than approximate. It is still only taken when the name belongs to
 * exactly one venue in the table, which a test holds.
 */
/*
 * By name, but only for names that belong to one venue.
 *
 * The table names two different grounds "Greene Stadium", and a fallback that
 * picked one of them would put another venue's facts on a game. A name that is
 * not unique is simply not matchable, which costs those two venues their row and
 * costs nothing else.
 */
const NAME_COUNTS = VENUES.reduce((counts, v) => counts.set(v.name, (counts.get(v.name) ?? 0) + 1), new Map<string, number>());
const BY_NAME = new Map(VENUES.filter((v) => NAME_COUNTS.get(v.name) === 1).map((v) => [v.name, v]));
const recordFor = (venueId: string | null, name: string | null) => (venueId ? BY_ID.get(venueId) : name ? BY_NAME.get(name) : undefined) ?? null;

/**
 * A venue as the payload describes it, filled in from the table where the
 * payload was quiet.
 *
 * The payload always wins: it is the live description of this game at this
 * place, and the table is a reference. What the table answers is the scoreboard,
 * which names a venue and says whether it has a roof and nothing else. Without
 * it every card on a college Saturday drew mowing stripes whether the ground had
 * grass or not, because the surface is only on a venue's own document, and 0 of
 * 116 cards on a real Saturday knew it.
 */
function venueFrom(venue: Record<string, unknown>, image: VenueImage | null): NonNullable<GameSummary['venue']> {
  const id = str(venue.id);
  const name = str(venue.fullName);
  const known = recordFor(id, name);
  return {
    id,
    name,
    city: str(at(venue, 'address', 'city')),
    state: str(at(venue, 'address', 'state')),
    indoor: bool(venue.indoor) ?? known?.indoor ?? null,
    grass: bool(venue.grass) ?? known?.grass ?? null,
    image,
    capacity: known?.capacity ?? null,
  };
}

export const espnLeaguePath = (league: LeagueId) => (league === 'nfl' ? 'nfl' : 'college-football');

export function scoreboardUrl(league: LeagueId, dateKey: string, groupId?: string): string {
  const q = new URLSearchParams({ dates: dateKey, limit: String(RESULT_LIMIT) });
  if (groupId) q.set('groups', groupId);
  return `${SITE_BASE}/${espnLeaguePath(league)}/scoreboard?${q.toString()}`;
}

export function summaryUrl(league: LeagueId, providerEventId: string): string {
  return `${SITE_BASE}/${espnLeaguePath(league)}/summary?event=${encodeURIComponent(providerEventId)}`;
}

export interface NormalizeDiagnostics {
  invalidEvents: number;
  spotSignalConflicts: number;
  ignoredStoppageTeams: number;
  reorderedPlays: number;
  duplicatePlays: number;
}

export const newDiagnostics = (): NormalizeDiagnostics => ({
  invalidEvents: 0,
  spotSignalConflicts: 0,
  ignoredStoppageTeams: 0,
  reorderedPlays: 0,
  duplicatePlays: 0,
});

interface GameContext {
  league: LeagueId;
  gameId: string;
  home: Team;
  away: Team;
}

// ---------------------------------------------------------------- validation

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseScoreboard(json: unknown): Parsed<{ events: unknown[]; root: Record<string, unknown> }> {
  const root = obj(json);
  if (!root) return { ok: false, error: 'Scoreboard response was not a JSON object' };
  if (!Array.isArray(root.events)) return { ok: false, error: 'Scoreboard response had no events list' };
  return { ok: true, value: { events: root.events, root } };
}

export function parseSummaryShape(json: unknown): Parsed<Record<string, unknown>> {
  const root = obj(json);
  if (!root) return { ok: false, error: 'Game summary was not a JSON object' };
  const competitors = arr(at(root, 'header', 'competitions', 0, 'competitors'));
  if (competitors.length < 2) return { ok: false, error: 'Game summary had no competitors' };
  return { ok: true, value: root };
}

// ---------------------------------------------------------------- teams & status

export function normalizeTeam(league: LeagueId, competitor: unknown): Team | null {
  const c = obj(competitor);
  const t = obj(c?.team);
  const providerId = str(t?.id);
  if (!c || !t || !providerId) return null;
  const abbreviation = str(t.abbreviation) ?? providerId;
  const logos = arr(t.logos).map(obj).filter((l): l is Record<string, unknown> => l !== null);
  const pick = (want: string) => {
    const hit = logos.find((l) => {
      const rel = arr(l.rel).map((r) => str(r));
      return rel.includes('full') && rel.includes(want) && !rel.includes('scoreboard');
    });
    return hit ? safeUrl(hit.href) : null;
  };
  const rankRaw = num(at(c, 'curatedRank', 'current')) ?? num(c.rank);
  const records = [...arr(c.records), ...arr(c.record)].map(obj);
  const total = records.find((r) => str(r?.type) === 'total' || str(r?.name) === 'overall');
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
    logo: safeUrl(t.logo) ?? pick('default'),
    logoDark: pick('dark'),
    rank: rankRaw !== null && rankRaw >= 1 && rankRaw <= 25 ? rankRaw : null,
    record: str(total?.summary) ?? str(total?.displayValue),
    conferenceId: str(t.conferenceId) ?? str(at(t, 'groups', 'id')),
  };
}

const STATUS_CODES: Record<string, GameStatusKind> = {
  STATUS_SCHEDULED: 'scheduled',
  STATUS_TBD: 'scheduled',
  STATUS_IN_PROGRESS: 'in_progress',
  STATUS_FIRST_HALF: 'in_progress',
  STATUS_SECOND_HALF: 'in_progress',
  STATUS_OVERTIME: 'in_progress',
  STATUS_HALFTIME: 'halftime',
  STATUS_END_PERIOD: 'end_of_period',
  STATUS_DELAYED: 'delayed',
  STATUS_RAIN_DELAY: 'delayed',
  STATUS_WEATHER_DELAY: 'delayed',
  STATUS_SUSPENDED: 'suspended',
  STATUS_FINAL: 'final',
  STATUS_FINAL_OVERTIME: 'final',
  STATUS_FORFEIT: 'final',
  STATUS_POSTPONED: 'postponed',
  STATUS_CANCELED: 'canceled',
  STATUS_CANCELLED: 'canceled',
  STATUS_ABANDONED: 'canceled',
};

export function normalizeStatus(raw: unknown, regulationPeriods = 4): GameStatus {
  const s = obj(raw);
  const t = obj(s?.type);
  const code = str(t?.name);
  let kind: GameStatusKind = code && STATUS_CODES[code] ? STATUS_CODES[code] : 'unknown';
  if (kind === 'unknown') {
    const state = str(t?.state);
    if (state === 'pre') kind = 'scheduled';
    else if (state === 'post' && bool(t?.completed) === true) kind = 'final';
  }
  const period = num(s?.period);
  const detail = str(t?.shortDetail) ?? str(t?.detail) ?? str(t?.description);
  // Halftime and period breaks carry leftover clocks ("End of 4th" has been captured with 0:20), so only running states keep one.
  const clockRelevant = kind === 'in_progress' || kind === 'delayed' || kind === 'suspended';
  let clock = clockRelevant ? str(s?.displayClock) : null;
  // College overtime has no game clock: the feed sends "0:00" with a detail of just "OT" or "2OT".
  if (clock !== null && period !== null && period > regulationPeriods && clockToSeconds(clock) === 0 && detail !== null && !detail.includes(':')) clock = null;
  return {
    kind,
    period: kind === 'scheduled' || period === null || period < 1 ? null : period,
    regulationPeriods,
    clock,
    clockSeconds: clockToSeconds(clock),
    detail,
    providerCode: code,
  };
}

function scoreValue(competitor: Record<string, unknown> | null, kind: GameStatusKind): number | null {
  if (!competitor || kind === 'scheduled' || kind === 'postponed' || kind === 'canceled') return null;
  const direct = num(competitor.score);
  if (direct !== null) return direct;
  return num(at(competitor, 'score', 'value'));
}

function mediumOf(typeName: string | null): Broadcast['medium'] {
  const t = (typeName ?? '').toLowerCase();
  if (t === 'tv') return 'tv';
  if (t === 'streaming' || t === 'web') return 'streaming';
  if (t === 'radio') return 'radio';
  return 'unknown';
}

export function normalizeBroadcasts(comp: Record<string, unknown>): Broadcast[] {
  const out = new Map<string, Broadcast>();
  const put = (b: Broadcast) => {
    const k = b.name.toLowerCase();
    const existing = out.get(k);
    if (!existing || (existing.medium === 'unknown' && b.medium !== 'unknown')) out.set(k, b);
  };
  for (const g of arr(comp.geoBroadcasts)) {
    const o = obj(g);
    const name = str(at(o, 'media', 'shortName'));
    if (!o || !name) continue;
    const market = str(at(o, 'market', 'type'));
    put({ name, medium: mediumOf(str(at(o, 'type', 'shortName'))), national: market ? market === 'National' : null });
  }
  for (const b of arr(comp.broadcasts)) {
    const o = obj(b);
    if (!o) continue;
    const media = str(at(o, 'media', 'shortName'));
    if (media) {
      const market = str(at(o, 'market', 'type'));
      put({ name: media, medium: mediumOf(str(at(o, 'type', 'shortName'))), national: bool(o.isNational) ?? (market ? market === 'National' : null) });
    }
    for (const n of arr(o.names)) {
      const name = str(n);
      if (name) put({ name, medium: 'unknown', national: str(o.market) === 'national' ? true : null });
    }
  }
  return [...out.values()];
}

function gamePageLink(links: unknown): string | null {
  for (const l of arr(links)) {
    const o = obj(l);
    const rel = arr(o?.rel).map((r) => str(r));
    if (rel.includes('summary') && rel.includes('desktop')) return safeUrl(o?.href);
  }
  return null;
}

// ---------------------------------------------------------------- ball spots

const sideOf = (ctx: GameContext, teamId: string | null): Side | null =>
  teamId === null ? null : teamId === ctx.home.providerId ? 'home' : teamId === ctx.away.providerId ? 'away' : null;

/** Schematic yard from a label naming a half: "HOME 20" → 80, "AWAY 20" → 20, "50" → 50. */
export function schematicYardFromLabel(label: string | null, home: string, away: string): number | null {
  if (!label) return null;
  const text = label.trim().toUpperCase();
  if (/^(?:MID(?:FIELD)?\s*)?50$/.test(text)) return 50;
  const m = /^([A-Z0-9&.'-]{1,8})\s+(\d{1,2})$/.exec(text);
  if (!m) return null;
  const yard = Number(m[2]);
  if (yard > 50) return null;
  if (yard === 50) return 50;
  if (m[1] === home.toUpperCase()) return 100 - yard;
  if (m[1] === away.toUpperCase()) return yard;
  return null;
}

function labelForSchematic(yard: number, ctx: GameContext): string {
  const y = Math.round(yard);
  if (y === 50) return '50';
  return y < 50 ? `${ctx.away.abbreviation} ${y}` : `${ctx.home.abbreviation} ${100 - y}`;
}

interface RawSpot {
  label: string | null;
  yardLine: number | null;
  yardsToEndzone: number | null;
  team: Side | null;
}

export function resolveSpot(
  raw: RawSpot,
  ctx: GameContext,
  opts: { phase: BallSpot['phase']; sourceTime: string | null; scoring?: boolean; diagnostics?: NormalizeDiagnostics },
): BallSpot {
  const bothZero = raw.yardLine === 0 && raw.yardsToEndzone === 0;
  const zeroIsReal = bothZero && opts.scoring === true && raw.team === 'away';
  const usable = (v: number | null) => v !== null && v >= 0 && v <= 100 && (!bothZero || zeroIsReal);

  const fromLabel = schematicYardFromLabel(raw.label, ctx.home.abbreviation, ctx.away.abbreviation);
  const fromYardLine = usable(raw.yardLine) ? 100 - (raw.yardLine as number) : null;

  let schematic: number | null = null;
  let provenance: SpotProvenance = 'unknown';
  if (fromLabel !== null) {
    schematic = fromLabel;
    provenance = 'label';
    if (fromYardLine !== null && Math.abs(fromYardLine - fromLabel) >= 0.5 && opts.diagnostics) opts.diagnostics.spotSignalConflicts++;
  } else if (fromYardLine !== null) {
    schematic = fromYardLine;
    provenance = 'home-yardline';
  } else if (raw.team && usable(raw.yardsToEndzone)) {
    const yte = raw.yardsToEndzone as number;
    schematic = raw.team === 'away' ? 100 - yte : yte;
    provenance = 'yards-to-endzone';
  }

  if (schematic === null) {
    return { ...UNKNOWN_SPOT, label: raw.label, offense: raw.team, phase: opts.phase, sourceTime: opts.sourceTime };
  }
  const progress = raw.team ? progressFromSchematicYard(schematic, raw.team) : null;
  const label =
    raw.label ??
    (raw.team && progress !== null
      ? labelFromProgress(progress, raw.team, { home: ctx.home, away: ctx.away })
      : labelForSchematic(schematic, ctx));
  return { label, offense: raw.team, progress, schematicYard: schematic, phase: opts.phase, provenance, lateral: null, sourceTime: opts.sourceTime };
}

const validDown = (d: number | null) => (d !== null && Number.isInteger(d) && d >= 1 && d <= 4 ? d : null);
const validDistance = (d: number | null, down: number | null) => (down !== null && d !== null && d > 0 && d <= 99 ? d : null);
const goalFromText = (...texts: Array<string | null>) => {
  const joined = texts.filter(Boolean).join(' ');
  if (!joined) return null;
  return /&\s*goal/i.test(joined);
};

// ---------------------------------------------------------------- situation

export function normalizeSituation(raw: unknown, ctx: GameContext, diagnostics?: NormalizeDiagnostics): Situation | null {
  const s = obj(raw);
  if (!s) return null;
  const possession = sideOf(ctx, str(s.possession) ?? str(at(s, 'possession', 'id')));
  const down = validDown(num(s.down));
  const ddText = str(s.downDistanceText);
  const shortText = str(s.shortDownDistanceText);
  const spot = resolveSpot(
    { label: str(s.possessionText), yardLine: num(s.yardLine), yardsToEndzone: num(s.yardsToEndzone), team: possession },
    ctx,
    { phase: 'pre-snap', sourceTime: null, diagnostics },
  );
  const lp = obj(s.lastPlay);
  const lastPlay: PlayBrief | null = lp
    ? {
        id: str(lp.id) ? `${ctx.gameId}:${str(lp.id)}` : null,
        kind: classifyPlayType(str(at(lp, 'type', 'text'))),
        description: str(lp.text) ?? '',
        yards: num(lp.statYardage),
        team: sideOf(ctx, str(at(lp, 'team', 'id'))),
      }
    : null;
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
    lastPlay,
  };
}

// ---------------------------------------------------------------- scoreboard

export function normalizeScoreboardEvent(
  raw: unknown,
  league: LeagueId,
  divisions: Division[],
  diagnostics: NormalizeDiagnostics = newDiagnostics(),
): GameSummary | null {
  const e = obj(raw);
  const comp = obj(at(e, 'competitions', 0));
  const providerEventId = str(e?.id);
  if (!e || !comp || !providerEventId) {
    diagnostics.invalidEvents++;
    return null;
  }
  const competitors = arr(comp.competitors).map(obj);
  const homeRaw = competitors.find((c) => str(c?.homeAway) === 'home') ?? null;
  const awayRaw = competitors.find((c) => str(c?.homeAway) === 'away') ?? null;
  const home = normalizeTeam(league, homeRaw);
  const away = normalizeTeam(league, awayRaw);
  if (!home || !away) {
    diagnostics.invalidEvents++;
    return null;
  }
  const id = toGameId(league, providerEventId);
  const ctx: GameContext = { league, gameId: id, home, away };
  const regulation = num(at(comp, 'format', 'regulation', 'periods')) ?? 4;
  const status = normalizeStatus(comp.status ?? e.status, regulation);
  const pbp = bool(comp.playByPlayAvailable);
  const situation = isLiveOrPaused(status.kind) ? normalizeSituation(comp.situation, ctx, diagnostics) : null;
  const venue = obj(comp.venue);
  const coverage: CoverageCapabilities = {
    // Before kickoff the feed marks play-by-play unavailable even for fully covered games, so that is not a coverage level yet.
    level: pbp === true ? 'full' : pbp === false && status.kind !== 'scheduled' ? 'score-only' : 'unknown',
    score: true,
    situation: situation !== null,
    playByPlay: pbp === true,
    drives: pbp === true,
    teamStats: pbp === true,
    provider: PROVIDER_NAME,
  };
  // Lines and win probability are added only when reported, so games without them keep their exact shape.
  const lines = normalizeLines(comp.odds, home.providerId, away.providerId);
  const winProbability = isLiveOrPaused(status.kind) ? lastPlayWinProbability(at(comp, 'situation', 'lastPlay'), id) : null;
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
    venue: venue
      ? venueFrom(venue, normalizeVenueImage(venue.images))
      : null,
    // The weather at the venue, as reported. A roofed venue has none, which is the roof saying so.
    weather: normalizeWeather(e.weather),
    neutralSite: bool(comp.neutralSite),
    conferenceGame: bool(comp.conferenceCompetition),
    links: { gamePage: gamePageLink(e.links) },
    season: { year: num(at(e, 'season', 'year')), type: num(at(e, 'season', 'type')), week: num(at(e, 'week', 'number')) },
    notes: arr(comp.notes).map((n) => str(obj(n)?.headline)).filter((n): n is string => !!n),
    coverage,
    ...(lines ? { lines } : {}),
    ...(winProbability ? { winProbability } : {}),
  };
}

// ---------------------------------------------------------------- plays & drives

function normalizePlayState(
  raw: unknown,
  ctx: GameContext,
  team: Side | null,
  opts: { phase: BallSpot['phase']; sourceTime: string | null; scoring: boolean; diagnostics: NormalizeDiagnostics },
): PlayState | null {
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
      opts,
    ),
  };
}

function normalizePlay(raw: unknown, ctx: GameContext, driveId: string | null, diagnostics: NormalizeDiagnostics): PlayEvent | null {
  const p = obj(raw);
  const providerId = str(p?.id);
  if (!p || !providerId) return null;
  const typeText = str(at(p, 'type', 'text'));
  const kind: PlayKind = classifyPlayType(typeText);
  const stoppage = ADMIN_KINDS.has(kind);
  const startTeam = sideOf(ctx, str(at(p, 'start', 'team', 'id')));
  const endTeam = sideOf(ctx, str(at(p, 'end', 'team', 'id')));
  if (stoppage && (startTeam || endTeam)) diagnostics.ignoredStoppageTeams++;
  const scoring = bool(p.scoringPlay);
  const wallclock = str(p.wallclock);
  const text = str(p.text);
  const awayScore = num(p.awayScore);
  const homeScore = num(p.homeScore);
  const period = num(at(p, 'period', 'number'));
  const clock = str(at(p, 'clock', 'displayValue'));
  const yards = num(p.statYardage);
  const turnover = bool(p.isTurnover);
  const penalty = bool(p.isPenalty);
  const offense = stoppage ? null : startTeam;
  const start = normalizePlayState(p.start, ctx, offense, { phase: 'pre-snap', sourceTime: wallclock, scoring: false, diagnostics });
  const end = normalizePlayState(p.end, ctx, stoppage ? null : endTeam, {
    phase: 'post-play',
    sourceTime: wallclock,
    scoring: scoring === true,
    diagnostics,
  });
  const revision = fingerprint(
    JSON.stringify([
      typeText, text, awayScore, homeScore, scoring, turnover, penalty, yards, period, clock,
      at(p, 'start', 'yardLine'), at(p, 'start', 'down'), at(p, 'start', 'distance'), str(at(p, 'start', 'team', 'id')),
      at(p, 'end', 'yardLine'), at(p, 'end', 'down'), at(p, 'end', 'distance'), str(at(p, 'end', 'team', 'id')),
    ]),
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
    description: text ?? typeText ?? 'Play',
    providerType: { id: str(at(p, 'type', 'id')), text: typeText },
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
    conversion: TOUCHDOWN_KINDS.has(kind) || kind === 'extra_point' || kind === 'two_point' ? parseConversion(text) : null,
    review: parseReview(text),
    scoreAfter: { home: homeScore, away: awayScore },
    modified: str(p.modified),
    wallclock,
    revision,
  };
}

function normalizeDriveEdge(raw: unknown, ctx: GameContext, offense: Side | null): DriveEdge | null {
  const o = obj(raw);
  if (!o) return null;
  const label = str(o.text);
  return {
    period: num(at(o, 'period', 'number')),
    clock: str(at(o, 'clock', 'displayValue')),
    label,
    spot: resolveSpot({ label, yardLine: num(o.yardLine), yardsToEndzone: null, team: offense }, ctx, { phase: 'pre-snap', sourceTime: null }),
  };
}

function normalizeDrive(raw: unknown, ctx: GameContext, isCurrent: boolean): Drive | null {
  const d = obj(raw);
  const providerId = str(d?.id);
  if (!d || !providerId) return null;
  const offense = sideOf(ctx, str(at(d, 'team', 'id')));
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
    timeElapsed: str(at(d, 'timeElapsed', 'displayValue')),
    result: str(d.displayResult) ?? str(d.result),
    isScore: bool(d.isScore),
    isCurrent,
  };
}

/** How far back (ms) a play's wall-clock time must jump before it is treated as misplaced. */
const MISPLACED_MS = 5 * 60_000;

/**
 * Keep provider order, but move a play back when its wall-clock time is far
 * earlier than the plays already placed (for example a scoring play appended
 * after the end of the game). Small timestamp noise never reorders plays.
 */
export function orderPlays(plays: PlayEvent[], diagnostics?: NormalizeDiagnostics): PlayEvent[] {
  const time = (p: PlayEvent) => {
    const t = p.wallclock ? Date.parse(p.wallclock) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const out: PlayEvent[] = [];
  let latest: number | null = null;
  for (const p of plays) {
    const t = time(p);
    if (t !== null && latest !== null && t < latest - MISPLACED_MS) {
      let at = out.length;
      while (at > 0) {
        const prev = out[at - 1];
        const pt = time(prev);
        const prevPeriod = prev.period ?? 0;
        const period = p.period ?? prevPeriod;
        if (prevPeriod < period || (prevPeriod === period && pt !== null && pt <= t)) break;
        at--;
      }
      out.splice(at, 0, p);
      if (diagnostics) diagnostics.reorderedPlays++;
    } else {
      out.push(p);
    }
    if (t !== null) latest = latest === null ? t : Math.max(latest, t);
  }
  return out.map((p, i) => ({ ...p, order: i }));
}

const NO_CONTINUITY: ReadonlySet<PlayKind> = new Set<PlayKind>([
  'touchdown_rush', 'touchdown_pass', 'touchdown_return', 'field_goal_good', 'field_goal_missed', 'field_goal_blocked',
  'safety', 'punt', 'punt_return', 'punt_blocked', 'kickoff', 'kickoff_return', 'penalty', 'interception',
  'fumble_lost', 'fumble', 'extra_point', 'two_point', 'other',
]);

/** Places where consecutive reported spots do not connect. Exposed, never filled in. */
export function findGaps(plays: PlayEvent[]): HistoryGap[] {
  const gaps: HistoryGap[] = [];
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
      gaps.push({ afterPlayId: prev.id, beforePlayId: next.id, reason: 'The reported spots do not connect here; a play may be missing from the feed.' });
    }
  }
  return gaps;
}

const STAT_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['totalYards', 'Total yards'],
  ['netPassingYards', 'Passing yards'],
  ['rushingYards', 'Rushing yards'],
  ['firstDowns', 'First downs'],
  ['thirdDownEff', 'Third downs'],
  ['fourthDownEff', 'Fourth downs'],
  ['turnovers', 'Turnovers'],
  ['fumblesLost', 'Fumbles lost'],
  ['interceptions', 'Interceptions thrown'],
  ['completionAttempts', 'Completions / attempts'],
  ['sacksYardsLost', 'Sacks / yards lost'],
  ['redZoneAttempts', 'Red zone scores / trips'],
  ['totalPenaltiesYards', 'Penalties / yards'],
  ['possessionTime', 'Time of possession'],
  ['yardsPerPlay', 'Yards per play'],
];

function normalizeStats(root: Record<string, unknown>, ctx: GameContext): TeamStat[] {
  const bySide: Record<Side, Map<string, string>> = { home: new Map(), away: new Map() };
  for (const t of arr(at(root, 'boxscore', 'teams'))) {
    const o = obj(t);
    const side = sideOf(ctx, str(at(o, 'team', 'id')));
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
    away: bySide.away.get(key) ?? null,
  }));
}

function scoreKind(typeText: string | null): ScoreEvent['kind'] {
  const t = typeText ?? '';
  if (/touchdown/i.test(t)) return 'touchdown';
  if (/field goal good/i.test(t)) return 'field_goal';
  if (/safety/i.test(t)) return 'safety';
  if (/two.?point|extra point|conversion|\bpat\b/i.test(t)) return 'conversion';
  return 'unknown';
}

// ---------------------------------------------------------------- summary

export function normalizeSummary(
  json: unknown,
  league: LeagueId,
  divisions: Division[] = league === 'nfl' ? ['NFL'] : [],
  diagnostics: NormalizeDiagnostics = newDiagnostics(),
): GameDetail | null {
  const parsed = parseSummaryShape(json);
  if (!parsed.ok) return null;
  const root = parsed.value;
  const header = obj(root.header);
  const comp = obj(at(header, 'competitions', 0));
  const providerEventId = str(header?.id) ?? str(comp?.id);
  if (!header || !comp || !providerEventId) return null;
  const competitors = arr(comp.competitors).map(obj);
  const homeRaw = competitors.find((c) => str(c?.homeAway) === 'home') ?? null;
  const awayRaw = competitors.find((c) => str(c?.homeAway) === 'away') ?? null;
  const home = normalizeTeam(league, homeRaw);
  const away = normalizeTeam(league, awayRaw);
  if (!home || !away) return null;
  const id = toGameId(league, providerEventId);
  const ctx: GameContext = { league, gameId: id, home, away };
  const regulation = num(at(root, 'format', 'regulation', 'periods')) ?? 4;
  const status = normalizeStatus(comp.status, regulation);

  // Drives: previous drives, then the current drive. The current drive can also
  // appear in the previous list; it is merged, and its plays are deduplicated.
  const drives = new Map<string, Drive>();
  const entries: PlayEvent[] = [];
  const rawDrives: Array<{ raw: unknown; current: boolean }> = arr(at(root, 'drives', 'previous')).map((raw) => ({ raw, current: false }));
  if (obj(at(root, 'drives', 'current'))) rawDrives.push({ raw: at(root, 'drives', 'current'), current: true });
  for (const { raw, current } of rawDrives) {
    const drive = normalizeDrive(raw, ctx, current);
    if (!drive) continue;
    const existing = drives.get(drive.id);
    if (existing) {
      if (current) Object.assign(existing, { ...drive, playIds: existing.playIds, isCurrent: true });
    } else {
      drives.set(drive.id, drive);
    }
    for (const rp of arr(obj(raw)?.plays)) {
      const play = normalizePlay(rp, ctx, drive.id, diagnostics);
      if (play) entries.push(play);
    }
  }

  const seen = new Map<string, number>();
  const deduped: PlayEvent[] = [];
  for (const p of entries) {
    const at0 = seen.get(p.id);
    if (at0 === undefined) {
      seen.set(p.id, deduped.length);
      deduped.push(p);
      continue;
    }
    diagnostics.duplicatePlays++;
    const prev = deduped[at0];
    const newer = (p.modified ?? '') >= (prev.modified ?? '');
    if (newer) deduped[at0] = { ...p, driveId: p.driveId ?? prev.driveId };
  }
  const plays = orderPlays(deduped, diagnostics);

  const scoring: ScoreEvent[] = arr(root.scoringPlays)
    .map(obj)
    .filter((sp): sp is Record<string, unknown> => sp !== null)
    .map((sp) => {
      const pid = str(sp.id);
      return {
        id: `${id}:score:${pid ?? fingerprint(JSON.stringify(sp))}`,
        gameId: id,
        playId: pid ? `${id}:${pid}` : null,
        period: num(at(sp, 'period', 'number')),
        clock: str(at(sp, 'clock', 'displayValue')),
        team: sideOf(ctx, str(at(sp, 'team', 'id'))),
        kind: scoreKind(str(at(sp, 'type', 'text'))),
        description: str(sp.text) ?? str(at(sp, 'type', 'text')) ?? 'Score',
        scoreAfter: { home: num(sp.homeScore), away: num(sp.awayScore) },
      };
    });

  // Scoring team: the explicit scoring summary first, then the side whose
  // reported score rose on a play the provider flagged as scoring.
  const scoringTeamByPlay = new Map(scoring.filter((s) => s.playId && s.team).map((s) => [s.playId as string, s.team as Side]));
  let before: Score = { home: 0, away: 0 };
  const playsWithTeams = plays.map((original) => {
    // The feed sometimes reports 0-0 on a stoppage (captured on a two-minute warning); a stoppage never changes the score.
    const zeroed = ADMIN_KINDS.has(original.kind) && original.scoreAfter.home === 0 && original.scoreAfter.away === 0 && ((before.home ?? 0) > 0 || (before.away ?? 0) > 0);
    const p = zeroed ? { ...original, scoreAfter: { ...before } } : original;
    let scoringTeam: Side | null = scoringTeamByPlay.get(p.id) ?? null;
    if (!scoringTeam && p.scoring) {
      const dh = p.scoreAfter.home !== null && before.home !== null ? p.scoreAfter.home - before.home : 0;
      const da = p.scoreAfter.away !== null && before.away !== null ? p.scoreAfter.away - before.away : 0;
      if (dh > 0 && da <= 0) scoringTeam = 'home';
      else if (da > 0 && dh <= 0) scoringTeam = 'away';
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
  const venue = obj(at(root, 'gameInfo', 'venue'));
  const situation = normalizeSituation(comp.situation, ctx, diagnostics);
  const possessionFlag = competitors.find((c) => bool(c?.possession) === true);
  const summary: GameSummary = {
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
    situation:
      situation ??
      (isLiveOrPaused(status.kind) && possessionFlag
        ? {
            possession: str(possessionFlag.homeAway) === 'home' ? 'home' : 'away',
            down: null,
            distance: null,
            goalToGo: null,
            downDistanceText: null,
            spot: UNKNOWN_SPOT,
            isRedZone: null,
            timeouts: { home: null, away: null },
            lastPlay: null,
          }
        : null),
    broadcasts: normalizeBroadcasts(comp),
    venue: venue
      ? venueFrom(venue, normalizeVenueImage(venue.images))
      : null,
    weather: normalizeWeather(at(root, 'header', 'weather') ?? root.weather),
    neutralSite: bool(comp.neutralSite),
    conferenceGame: bool(comp.conferenceCompetition),
    links: { gamePage: gamePageLink(header.links) },
    season: { year: num(at(header, 'season', 'year')), type: num(at(header, 'season', 'type')), week: num(header.week) },
    notes: [],
    coverage: {
      // Before kickoff the summary marks play-by-play as unavailable even for fully covered games, so that is not a coverage level yet.
      level: pbpSource === 'full' ? 'full' : pbpSource === 'none' && status.kind !== 'scheduled' ? 'score-only' : 'unknown',
      score: true,
      situation: situation !== null,
      playByPlay: playsWithTeams.length > 0,
      drives: driveList.length > 0,
      teamStats: boxSource === 'full',
      provider: PROVIDER_NAME,
    },
  };

  const leaders = normalizeLeaders(root.leaders, ctx);
  const attendance = num(at(root, 'gameInfo', 'attendance'));
  const gaps = findGaps(playsWithTeams);
  if (pbpSource === 'full' && playsWithTeams.length === 0 && status.kind !== 'scheduled') {
    gaps.push({ afterPlayId: null, beforePlayId: null, reason: 'The provider lists full play-by-play for this game but returned no plays yet.' });
  }

  // Lines, win probability and the matchup predictor are added only when reported, so other games keep their exact shape.
  const lines = normalizeLines(root.pickcenter, home.providerId, away.providerId);
  const winProbability = normalizeWinProbability(root.winprobability, id);
  const latest = status.kind === 'scheduled' ? null : latestWinProbability(winProbability);
  const predictor = normalizePredictor(root.predictor, home.providerId, away.providerId);
  const reported: GameSummary = { ...summary, ...(lines ? { lines } : {}), ...(latest ? { winProbability: latest } : {}), ...(predictor ? { predictor } : {}) };

  return {
    gameId: id,
    summary: reported,
    drives: driveList,
    plays: playsWithTeams,
    scoring,
    stats: normalizeStats(root, ctx),
    leaders,
    attendance: attendance !== null && attendance > 0 ? Math.round(attendance) : null,
    currentDriveId: current?.id ?? null,
    gaps,
    ...(winProbability.length ? { winProbability } : {}),
  };
}

type TeamLeadersModel = import('../../../shared/model.js').TeamLeaders;
type GameLeaderModel = import('../../../shared/model.js').GameLeader;

const LEADER_CATEGORY: Record<string, GameLeaderModel['category']> = { passingYards: 'passing', rushingYards: 'rushing', receivingYards: 'receiving' };
const LEADER_ORDER: GameLeaderModel['category'][] = ['passing', 'rushing', 'receiving'];
const PROVIDER_IMAGE = /^https:\/\/a\.espncdn\.com\//;

/** Game leaders exactly as the provider reports them: one athlete and stat line per category, per team. */
function normalizeLeaders(raw: unknown, ctx: GameContext): TeamLeadersModel[] {
  const out: TeamLeadersModel[] = [];
  for (const entry of arr(raw)) {
    const e = obj(entry);
    const teamId = str(at(e, 'team', 'id'));
    const side = teamId && teamId === ctx.home.providerId ? 'home' : teamId && teamId === ctx.away.providerId ? 'away' : null;
    if (!e || !side || out.some((t) => t.side === side)) continue;
    const leaders: GameLeaderModel[] = [];
    for (const item of arr(e.leaders)) {
      const c = obj(item);
      const category = LEADER_CATEGORY[str(c?.name) ?? ''];
      if (!c || !category || leaders.some((l) => l.category === category)) continue;
      const top = obj(arr(c.leaders)[0]);
      const athlete = obj(top?.athlete);
      const name = str(athlete?.displayName) ?? str(athlete?.shortName);
      const line = str(top?.displayValue);
      if (!name || !line) continue;
      const headshot = str(at(athlete, 'headshot', 'href'));
      leaders.push({
        category,
        label: str(c.displayName) ?? category,
        athlete: {
          name,
          shortName: str(athlete?.shortName),
          position: str(at(athlete, 'position', 'abbreviation')),
          jersey: str(athlete?.jersey),
          headshot: headshot && PROVIDER_IMAGE.test(headshot) ? headshot : null,
        },
        line,
      });
    }
    leaders.sort((a, b) => LEADER_ORDER.indexOf(a.category) - LEADER_ORDER.indexOf(b.category));
    if (leaders.length) out.push({ side, leaders });
  }
  return out.sort((a, b) => (a.side === b.side ? 0 : a.side === 'away' ? -1 : 1));
}
