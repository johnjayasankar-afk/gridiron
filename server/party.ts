/**
 * Watch parties: a host shares a link and guests follow the host's view in
 * real time. A party holds only view state (the route, focused games, the data
 * source, an inspected play, the watch delay, the day and the league), never
 * personal data. The hub knows nothing about HTTP; the server wires it to
 * routes and server-sent events.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { GameId, LeagueId } from '../shared/model.js';
import { parseGameId } from '../shared/model.js';
import { isDateKey, isRecord } from '../shared/util.js';

export interface PartyState {
  route: { name: 'slate' | 'focus' | 'wall' | 'game' | 'team'; id: string | null };
  focusGames: GameId[];
  source: { kind: 'live' } | { kind: 'replay'; sessionId: string };
  inspection: { gameId: GameId; playId: string | null } | null;
  delaySeconds: number;
  date: string | null;
  league: 'all' | LeagueId;
}

/** What anyone holding the party id may see. The host token is never part of it. */
export interface PartyView {
  id: string;
  state: PartyState;
  rev: number;
  members: number;
  createdAt: number;
  updatedAt: number;
}

export type PartyEvent = { type: 'state'; view: PartyView } | { type: 'members'; members: number } | { type: 'ended' };

export type PartyListener = (event: PartyEvent) => void;

export type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 429 | 503; error: string };

export interface PartyHubOptions {
  /** Parties that may exist at once. */
  maxParties?: number;
  /** Listeners one party may hold. */
  maxMembers?: number;
  /** An empty party is swept once its last update or member departure is older than this. */
  idleMs?: number;
  /** Host updates accepted per party within any one second. */
  maxUpdatesPerSecond?: number;
  now?: () => number;
  randomId?: () => string;
  randomToken?: () => string;
}

type Failure = Extract<Result<never>, { ok: false }>;
type Check<T> = { value: T } | { error: string };

const MAX_STATE_BYTES = 4_096;
const MAX_FOCUS_GAMES = 4;
const MAX_DELAY_SECONDS = 300;
const RATE_WINDOW_MS = 1_000;
const STATE_KEYS = ['route', 'focusGames', 'source', 'inspection', 'delaySeconds', 'date', 'league'];
const ROUTE_NAMES: ReadonlyArray<PartyState['route']['name']> = ['slate', 'focus', 'wall', 'game', 'team'];
const LEAGUE_FILTERS: ReadonlyArray<PartyState['league']> = ['all', 'nfl', 'cfb'];
const TEAM_ID = /^(nfl|cfb)-\d{1,6}$/;
const SESSION_ID = /^[a-zA-Z0-9-]{8,64}$/;
const PLAY_ID = /^[\w:.-]{1,64}$/;

// ---------------------------------------------------------------- validation

const isGameId = (v: unknown): v is GameId => typeof v === 'string' && parseGameId(v) !== null;

/** Byte length of the value as JSON, or null when it cannot be serialized (a cycle or a BigInt, say). */
function serializedBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return null;
  }
}

function readRoute(value: unknown): Check<PartyState['route']> {
  if (!isRecord(value)) return { error: 'route must be an object' };
  const name = value.name as PartyState['route']['name'];
  if (!ROUTE_NAMES.includes(name)) return { error: 'route.name must be slate, focus, wall, game or team' };
  const id = value.id;
  if (name === 'game') return isGameId(id) ? { value: { name, id } } : { error: 'route.id must be a game id for a game route' };
  if (name === 'team') {
    return typeof id === 'string' && TEAM_ID.test(id) ? { value: { name, id } } : { error: 'route.id must be nfl- or cfb- followed by up to 6 digits for a team route' };
  }
  return id === null ? { value: { name, id } } : { error: `route.id must be null for a ${name} route` };
}

/** Every entry must be a game id; repeats collapse, and at most four different games remain. */
function readFocusGames(value: unknown): Check<GameId[]> {
  if (!Array.isArray(value)) return { error: 'focusGames must be an array' };
  const games = new Set<GameId>();
  for (const game of value) {
    if (!isGameId(game)) return { error: 'focusGames must contain only game ids' };
    games.add(game);
  }
  return games.size <= MAX_FOCUS_GAMES ? { value: [...games] } : { error: `focusGames may hold at most ${MAX_FOCUS_GAMES} different games` };
}

function readSource(value: unknown): Check<PartyState['source']> {
  if (!isRecord(value)) return { error: 'source must be an object' };
  if (value.kind === 'live') return { value: { kind: 'live' } };
  if (value.kind !== 'replay') return { error: 'source.kind must be live or replay' };
  const sessionId = value.sessionId;
  return typeof sessionId === 'string' && SESSION_ID.test(sessionId)
    ? { value: { kind: 'replay', sessionId } }
    : { error: 'source.sessionId must be 8 to 64 letters, digits or hyphens' };
}

function readInspection(value: unknown): Check<PartyState['inspection']> {
  if (value === null) return { value: null };
  if (!isRecord(value)) return { error: 'inspection must be null or an object' };
  const gameId = value.gameId;
  if (!isGameId(gameId)) return { error: 'inspection.gameId must be a game id' };
  const playId = value.playId;
  if (playId === null || (typeof playId === 'string' && PLAY_ID.test(playId))) return { value: { gameId, playId } };
  return { error: 'inspection.playId must be null or 1 to 64 letters, digits, underscores, colons, dots or hyphens' };
}

function readDelay(value: unknown): Check<number> {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DELAY_SECONDS
    ? { value }
    : { error: `delaySeconds must be a whole number from 0 to ${MAX_DELAY_SECONDS}` };
}

function readDate(value: unknown): Check<string | null> {
  return value === null || isDateKey(value) ? { value } : { error: 'date must be null or a YYYYMMDD date key' };
}

function readLeague(value: unknown): Check<PartyState['league']> {
  const league = value as PartyState['league'];
  return LEAGUE_FILTERS.includes(league) ? { value: league } : { error: 'league must be all, nfl or cfb' };
}

/**
 * Strict validation of a host's view. Every key is required, unknown top-level
 * keys and states over 4,096 bytes of JSON are refused, and the state returned
 * is rebuilt from the checked fields alone, so nothing else is ever stored.
 */
export function validatePartyState(value: unknown): { ok: true; state: PartyState } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'Party state must be an object' };
  const bytes = serializedBytes(value);
  if (bytes === null) return { ok: false, error: 'Party state must be plain JSON' };
  if (bytes > MAX_STATE_BYTES) return { ok: false, error: `Party state must be at most ${MAX_STATE_BYTES} bytes as JSON` };
  const unknownKey = Object.keys(value).find((key) => !STATE_KEYS.includes(key));
  if (unknownKey !== undefined) return { ok: false, error: `Unknown party state key "${unknownKey.slice(0, 64)}"` };

  const route = readRoute(value.route);
  if ('error' in route) return { ok: false, error: route.error };
  const focusGames = readFocusGames(value.focusGames);
  if ('error' in focusGames) return { ok: false, error: focusGames.error };
  const source = readSource(value.source);
  if ('error' in source) return { ok: false, error: source.error };
  const inspection = readInspection(value.inspection);
  if ('error' in inspection) return { ok: false, error: inspection.error };
  const delay = readDelay(value.delaySeconds);
  if ('error' in delay) return { ok: false, error: delay.error };
  const date = readDate(value.date);
  if ('error' in date) return { ok: false, error: date.error };
  const league = readLeague(value.league);
  if ('error' in league) return { ok: false, error: league.error };

  return {
    ok: true,
    state: { route: route.value, focusGames: focusGames.value, source: source.value, inspection: inspection.value, delaySeconds: delay.value, date: date.value, league: league.value },
  };
}

// ---------------------------------------------------------------- hub

interface Member {
  listener: PartyListener;
}

interface Party {
  id: string;
  hostToken: Buffer;
  state: PartyState;
  rev: number;
  createdAt: number;
  updatedAt: number;
  /** The last update or member departure. The sweep measures idleness from here. */
  lastActivity: number;
  /** When recently accepted updates arrived, for the one-second rate window. */
  recentUpdates: number[];
  /** One entry per subscription, so the same function subscribed twice counts twice. */
  members: Set<Member>;
  ended: boolean;
}

const notFound = (): Failure => ({ ok: false, status: 404, error: 'Unknown or ended watch party' });
const forbidden = (): Failure => ({ ok: false, status: 403, error: 'Only the host can change this watch party' });

/** Constant-time comparison. A token of a different length is simply wrong. */
function tokenMatches(expected: Buffer, given: string): boolean {
  if (typeof given !== 'string' || expected.length === 0) return false;
  const candidate = Buffer.from(given);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** A listener that throws must not keep the others from hearing the event. */
function deliver(member: Member, event: PartyEvent) {
  try {
    member.listener(event);
  } catch {
    // The transport owns its listener's failures; the broadcast carries on.
  }
}

export class PartyHub {
  private readonly parties = new Map<string, Party>();
  private readonly maxParties: number;
  private readonly maxMembers: number;
  private readonly idleMs: number;
  private readonly maxUpdatesPerSecond: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomToken: () => string;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: PartyHubOptions = {}) {
    this.maxParties = options.maxParties ?? 200;
    this.maxMembers = options.maxMembers ?? 50;
    this.idleMs = options.idleMs ?? 6 * 60 * 60_000;
    this.maxUpdatesPerSecond = options.maxUpdatesPerSecond ?? 8;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  }

  /** Starts a party. When the hub is full, idle parties are swept first; if it is still full the answer is 503. */
  create(state: unknown): Result<{ id: string; hostToken: string; view: PartyView }> {
    const checked = validatePartyState(state);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    if (this.parties.size >= this.maxParties) this.sweep();
    if (this.parties.size >= this.maxParties) return { ok: false, status: 503, error: 'Too many watch parties are running; try again shortly' };
    const id = this.randomId();
    if (this.parties.has(id)) return { ok: false, status: 503, error: 'Could not start a watch party; try again' };
    const hostToken = this.randomToken();
    const now = this.now();
    const party: Party = { id, hostToken: Buffer.from(hostToken), state: checked.state, rev: 0, createdAt: now, updatedAt: now, lastActivity: now, recentUpdates: [], members: new Set(), ended: false };
    this.parties.set(id, party);
    return { ok: true, value: { id, hostToken, view: this.toView(party) } };
  }

  view(id: string): Result<PartyView> {
    const party = this.find(id);
    return party ? { ok: true, value: this.toView(party) } : notFound();
  }

  /**
   * Replaces the host's view. Checks run in order: unknown party (404), wrong
   * token (403), invalid state (400), too many updates (429). Only accepted
   * updates count toward the rate, so nobody without the token can spend it.
   */
  update(id: string, hostToken: string, state: unknown): Result<PartyView> {
    const party = this.find(id);
    if (!party) return notFound();
    if (!tokenMatches(party.hostToken, hostToken)) return forbidden();
    const checked = validatePartyState(state);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    const now = this.now();
    if (!this.takeUpdateSlot(party, now)) return { ok: false, status: 429, error: 'The host is changing the view too quickly; try again in a moment' };
    party.state = checked.state;
    party.rev += 1;
    party.updatedAt = now;
    party.lastActivity = now;
    this.broadcast(party, { type: 'state', view: this.toView(party) });
    return { ok: true, value: this.toView(party) };
  }

  /** Sends the new listener the current view, then everyone the member count. The returned function leaves, once. */
  subscribe(id: string, listener: PartyListener): Result<() => void> {
    const party = this.find(id);
    if (!party) return notFound();
    if (party.members.size >= this.maxMembers) return { ok: false, status: 429, error: 'This watch party is full' };
    const member: Member = { listener };
    party.members.add(member);
    deliver(member, { type: 'state', view: this.toView(party) });
    this.broadcast(party, { type: 'members', members: party.members.size });
    return { ok: true, value: () => this.leave(party, member) };
  }

  /** Tells every listener the party is over, then removes it. */
  end(id: string, hostToken: string): Result<true> {
    const party = this.find(id);
    if (!party) return notFound();
    if (!tokenMatches(party.hostToken, hostToken)) return forbidden();
    party.ended = true;
    this.broadcast(party, { type: 'ended' });
    party.members.clear();
    this.parties.delete(id);
    return { ok: true, value: true };
  }

  /** Removes parties nobody is watching whose last update or member departure is older than idleMs. Returns how many went. */
  sweep(): number {
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
  start(intervalMs = 60_000) {
    this.stop();
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  stats(): { parties: number; members: number } {
    let members = 0;
    for (const party of this.parties.values()) members += party.members.size;
    return { parties: this.parties.size, members };
  }

  /** Ended parties stay mapped only while their final event goes out, and are already gone to callers. */
  private find(id: string): Party | null {
    const party = this.parties.get(id);
    return party && !party.ended ? party : null;
  }

  /** A copy, so no listener or caller can reach the stored state. */
  private toView(party: Party): PartyView {
    return { id: party.id, state: structuredClone(party.state), rev: party.rev, members: party.members.size, createdAt: party.createdAt, updatedAt: party.updatedAt };
  }

  /** Sliding one-second window. Entries from the future (a clock stepped back) are dropped so they cannot lock the host out. */
  private takeUpdateSlot(party: Party, now: number): boolean {
    party.recentUpdates = party.recentUpdates.filter((at) => at > now - RATE_WINDOW_MS && at <= now);
    if (party.recentUpdates.length >= this.maxUpdatesPerSecond) return false;
    party.recentUpdates.push(now);
    return true;
  }

  private leave(party: Party, member: Member) {
    if (!party.members.delete(member) || party.ended) return;
    party.lastActivity = this.now();
    this.broadcast(party, { type: 'members', members: party.members.size });
  }

  /** Walks a copy of the members: a listener may join or leave while hearing the event. */
  private broadcast(party: Party, event: PartyEvent) {
    for (const member of [...party.members]) if (party.members.has(member)) deliver(member, event);
  }
}
