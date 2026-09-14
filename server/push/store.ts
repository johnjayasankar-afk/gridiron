/**
 * Push subscriptions for favorite team alerts.
 *
 * - Kept in memory, and saved to push-subscriptions.json in the cache directory when there is one (schema version
 *   1). With the cache directory off they last only as long as the process.
 * - Saves are debounced (about a second), written to a temporary file, synced and renamed into place, so a crash
 *   never leaves half a file. The file is readable by its owner only: an endpoint works like a credential.
 * - Every saved record is validated on load, and anything that does not pass is dropped rather than trusted.
 * - A record holds only what delivery needs: the endpoint and its keys, the teams and alert kinds chosen, and
 *   delivery bookkeeping. Nothing in it identifies a person.
 * - Records are frozen and replaced on every change, so what the store hands out can never be edited behind it.
 */
import { createHash, ECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ALERT_KINDS } from '../../shared/alerts.js';
import type { AlertKind, TeamKey } from '../../shared/model.js';
import { isRecord } from '../../shared/util.js';
import { isAllowedPushEndpoint, type WebPushKeys } from './webpush.js';

export interface PushRecord {
  /** The first 22 characters of the endpoint's SHA-256 in base64url: safe to log and to key limits by. */
  readonly id: string;
  readonly endpoint: string;
  readonly keys: Readonly<WebPushKeys>;
  readonly teams: readonly TeamKey[];
  readonly kinds: readonly AlertKind[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSuccessAt: number | null;
  /** Deliveries the push service refused in a row. */
  readonly failures: number;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: WebPushKeys;
  teams: readonly string[];
  kinds: readonly string[];
}

export type UpsertResult =
  | { ok: true; record: PushRecord; created: boolean }
  | { ok: false; reason: 'full' | 'invalid' | 'unknown'; error: string };

export interface PushStoreOptions {
  /** Where push-subscriptions.json lives, or null to keep subscriptions in memory only. */
  cacheDir: string | null;
  /** Subscriptions kept at once. A new endpoint beyond this is refused. */
  maxSubscriptions?: number;
  /** Alert kinds a record may hold (every alert kind by default). */
  kinds?: readonly AlertKind[];
  /** Endpoints a record may hold (the known push services by default). */
  allowEndpoint?: (endpoint: string) => boolean;
  debounceMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export const STORE_FILE = 'push-subscriptions.json';
export const STORE_VERSION = 1;
export const MAX_TEAMS = 32;
export const DEFAULT_MAX_SUBSCRIPTIONS = 10_000;
/** Push service endpoints run to a few hundred characters; anything far longer is not one. */
export const MAX_ENDPOINT_LENGTH = 2_048;
/** League and provider team id, as in shared/model.ts. The provider's team ids are digits. */
export const TEAM_KEY = /^(nfl|cfb)-\d{1,6}$/;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DEFAULT_DEBOUNCE_MS = 1_000;

type Check<T> = { value: T } | { error: string };

export function subscriptionId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('base64url').slice(0, 22);
}

/** Strict base64url (padding allowed), or null. Long strings are refused before any decoding. */
function decodeBase64Url(value: unknown, maxLength: number): Buffer | null {
  if (typeof value !== 'string' || value.length > maxLength) return null;
  const text = value.replace(/=+$/, '');
  return BASE64URL.test(text) ? Buffer.from(text, 'base64url') : null;
}

function onCurve(point: Buffer): boolean {
  try {
    ECDH.convertKey(point, 'prime256v1', undefined, undefined, 'uncompressed');
    return true;
  } catch {
    return false;
  }
}

/** A subscription's keys: p256dh a 65-byte uncompressed P-256 point, auth 16 bytes. Returned in canonical base64url. */
export function readKeys(value: unknown): Check<WebPushKeys> {
  if (!isRecord(value)) return { error: 'subscription.keys must be an object' };
  const p256dh = decodeBase64Url(value.p256dh, 128);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04 || !onCurve(p256dh)) {
    return { error: 'subscription.keys.p256dh must be a 65-byte uncompressed P-256 public key in base64url' };
  }
  const auth = decodeBase64Url(value.auth, 64);
  if (!auth || auth.length !== 16) return { error: 'subscription.keys.auth must be 16 bytes in base64url' };
  return { value: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') } };
}

/** One to `max` team keys. Repeats collapse. */
export function readTeams(value: unknown, max = MAX_TEAMS): Check<TeamKey[]> {
  if (!Array.isArray(value)) return { error: 'teams must be an array of team keys' };
  const teams = new Set<TeamKey>();
  for (const team of value) {
    if (typeof team !== 'string' || !TEAM_KEY.test(team)) return { error: 'teams must hold only team keys such as nfl-2 or cfb-333' };
    teams.add(team);
    if (teams.size > max) return { error: `Choose at most ${max} teams` };
  }
  return teams.size ? { value: [...teams] } : { error: 'Choose at least one team' };
}

/** At least one of the allowed kinds. Repeats collapse. */
export function readKinds(value: unknown, allowed: readonly AlertKind[]): Check<AlertKind[]> {
  if (!Array.isArray(value)) return { error: 'kinds must be an array of alert kinds' };
  const kinds = new Set<AlertKind>();
  for (const kind of value) {
    if (typeof kind !== 'string' || !allowed.includes(kind as AlertKind)) return { error: `kinds may hold only: ${allowed.join(', ')}` };
    kinds.add(kind as AlertKind);
  }
  return kinds.size ? { value: [...kinds] } : { error: 'Choose at least one kind of alert' };
}

const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

function freeze(record: PushRecord): PushRecord {
  Object.freeze(record.keys);
  Object.freeze(record.teams);
  Object.freeze(record.kinds);
  return Object.freeze(record);
}

/** Writes to a new temporary file, syncs it, then renames it over the target, so readers see the old file or the new one. */
async function writeAtomic(file: string, body: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export class PushStore {
  private readonly records = new Map<string, PushRecord>();
  /** Subscriptions following each team, so the union of teams is cheap to read. */
  private readonly teamCounts = new Map<TeamKey, number>();
  private readonly file: string | null;
  private readonly max: number;
  private readonly kinds: readonly AlertKind[];
  private readonly allowEndpoint: (endpoint: string) => boolean;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;
  private dirty = false;
  private rewrite = false;

  constructor(options: PushStoreOptions) {
    this.file = options.cacheDir ? join(options.cacheDir, STORE_FILE) : null;
    this.max = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
    this.kinds = options.kinds ?? ALERT_KINDS;
    this.allowEndpoint = options.allowEndpoint ?? ((endpoint) => isAllowedPushEndpoint(endpoint));
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.load();
  }

  get size(): number {
    return this.records.size;
  }

  get(endpoint: string): PushRecord | null {
    return this.records.get(endpoint) ?? null;
  }

  list(): PushRecord[] {
    return [...this.records.values()];
  }

  /** Every team at least one subscription follows, sorted. */
  teams(): TeamKey[] {
    return [...this.teamCounts.keys()].sort();
  }

  /** Adds a subscription, or replaces the keys, teams and kinds of the one with this endpoint. */
  upsert(input: PushSubscriptionInput): UpsertResult {
    const checked = this.check(input);
    if ('error' in checked) return { ok: false, reason: 'invalid', error: checked.error };
    const existing = this.records.get(checked.endpoint);
    if (!existing && this.records.size >= this.max) return { ok: false, reason: 'full', error: 'Push alerts are at capacity on this server' };
    const now = this.now();
    const record = existing
      ? { ...existing, keys: checked.keys, teams: checked.teams, kinds: checked.kinds, updatedAt: now, failures: 0 }
      : { id: subscriptionId(checked.endpoint), ...checked, createdAt: now, updatedAt: now, lastSuccessAt: null, failures: 0 };
    // The old record's teams stop counting before the new ones count.
    if (existing) this.drop(existing);
    this.put(record);
    this.changed();
    return { ok: true, record: this.records.get(record.endpoint)!, created: !existing };
  }

  remove(endpoint: string): boolean {
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
  transfer(oldEndpoint: string, next: { endpoint: string; keys: WebPushKeys }): UpsertResult {
    const old = typeof oldEndpoint === 'string' ? this.records.get(oldEndpoint) : undefined;
    if (!old) return { ok: false, reason: 'unknown', error: 'Unknown subscription' };
    const checked = this.check({ endpoint: next?.endpoint, keys: next?.keys, teams: old.teams, kinds: old.kinds });
    if ('error' in checked) return { ok: false, reason: 'invalid', error: checked.error };
    const now = this.now();
    const target = this.records.get(checked.endpoint);
    this.drop(old);
    if (target && target !== old) this.drop(target);
    // The old subscription's history carries over; a different endpoint has not been delivered to yet.
    const base = target ?? old;
    this.put({
      ...base,
      id: subscriptionId(checked.endpoint),
      ...checked,
      createdAt: Math.min(old.createdAt, base.createdAt),
      updatedAt: now,
      lastSuccessAt: target ? target.lastSuccessAt : checked.endpoint === old.endpoint ? old.lastSuccessAt : null,
      failures: 0,
    });
    this.changed();
    return { ok: true, record: this.records.get(checked.endpoint)!, created: !target };
  }

  /** A delivery the push service accepted: failures in a row start again from zero. */
  markSuccess(endpoint: string, at = this.now()): void {
    const record = this.records.get(endpoint);
    if (!record) return;
    this.records.set(endpoint, freeze({ ...record, lastSuccessAt: at, failures: 0 }));
    // A success alone is bookkeeping, saved with the next change or at shutdown rather than with a write of its own.
    if (record.failures > 0) this.changed();
    else this.dirty = true;
  }

  /** A delivery the push service refused. Returns the failures in a row, or 0 for an unknown endpoint. */
  markFailure(endpoint: string): number {
    const record = this.records.get(endpoint);
    if (!record) return 0;
    const failures = record.failures + 1;
    this.records.set(endpoint, freeze({ ...record, failures }));
    this.changed();
    return failures;
  }

  /** Saves any pending change now, after a save already under way. For shutdown and tests. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.writing) await this.writing;
    if (this.dirty && this.file) {
      this.rewrite = true;
      await this.save();
    }
  }

  // ------------------------------------------------------------ records

  private check(input: PushSubscriptionInput): { endpoint: string; keys: WebPushKeys; teams: TeamKey[]; kinds: AlertKind[] } | { error: string } {
    if (!isRecord(input)) return { error: 'A subscription must be an object' };
    const { endpoint } = input;
    if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH || !this.allowEndpoint(endpoint)) return { error: 'The endpoint is not a known push service' };
    const keys = readKeys(input.keys);
    if ('error' in keys) return keys;
    const teams = readTeams(input.teams);
    if ('error' in teams) return teams;
    const kinds = readKinds(input.kinds, this.kinds);
    if ('error' in kinds) return kinds;
    return { endpoint, keys: keys.value, teams: teams.value, kinds: kinds.value };
  }

  private put(record: PushRecord) {
    this.records.set(record.endpoint, freeze(record));
    for (const team of record.teams) this.teamCounts.set(team, (this.teamCounts.get(team) ?? 0) + 1);
  }

  private drop(record: PushRecord) {
    this.records.delete(record.endpoint);
    for (const team of record.teams) {
      const count = (this.teamCounts.get(team) ?? 0) - 1;
      if (count > 0) this.teamCounts.set(team, count);
      else this.teamCounts.delete(team);
    }
  }

  /** A saved record, rebuilt from its checked fields alone, or null when any of them fails. */
  private readRecord(value: unknown): PushRecord | null {
    if (!isRecord(value)) return null;
    const checked = this.check(value as unknown as PushSubscriptionInput);
    if ('error' in checked) return null;
    const createdAt = time(value.createdAt);
    const updatedAt = time(value.updatedAt);
    const lastSuccessAt = value.lastSuccessAt === null ? null : time(value.lastSuccessAt);
    const failures = value.failures;
    if (createdAt === null || updatedAt === null || (value.lastSuccessAt !== null && lastSuccessAt === null)) return null;
    if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) return null;
    return { id: subscriptionId(checked.endpoint), ...checked, createdAt, updatedAt, lastSuccessAt, failures };
  }

  private load() {
    if (!this.file) return;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`could not read saved push subscriptions: ${(e as Error).message}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log('saved push subscriptions are not valid JSON; starting with none');
      return;
    }
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.subscriptions)) {
      this.log(`saved push subscriptions are not schema version ${STORE_VERSION}; starting with none`);
      return;
    }
    let dropped = 0;
    for (const entry of parsed.subscriptions) {
      const record = this.readRecord(entry);
      const existing = record ? this.records.get(record.endpoint) : undefined;
      if (!record || (!existing && this.records.size >= this.max)) {
        dropped++;
        continue;
      }
      // A repeated endpoint keeps its most recently updated record.
      if (existing) {
        dropped++;
        if (record.updatedAt < existing.updatedAt) continue;
        this.drop(existing);
      }
      this.put(record);
    }
    if (dropped) {
      this.log(`dropped ${dropped} saved push subscription${dropped === 1 ? '' : 's'} that did not validate or repeated an endpoint`);
      this.changed();
    }
  }

  // ------------------------------------------------------------ saving

  private changed() {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.debounceMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One save at a time. A save asked for while one runs is folded into a second pass once it finishes. */
  private save(): Promise<void> {
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
          this.log(`could not save push subscriptions: ${(e as Error).message}`);
          break;
        }
      } while (this.rewrite);
    })().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }
}
