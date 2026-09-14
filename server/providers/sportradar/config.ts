/**
 * Sportradar configuration, read from an env object the caller passes in.
 *
 * - SPORTRADAR_NFL_API_KEY and SPORTRADAR_NCAAFB_API_KEY: at least one is required.
 * - SPORTRADAR_ACCESS_LEVEL: "trial" (default) or "production".
 * - SPORTRADAR_PUSH: "on" or "off" (default). Push feeds exist only on
 *   production plans, so "on" is ignored with a warning on trial access.
 *
 * A key is held in ApiKey, which prints as "[redacted]" through toString, JSON
 * and util.inspect. Only the HTTP layer calls reveal(), to set the x-api-key
 * header. Error messages name the variable, never its value.
 */
import { inspect } from 'node:util';
import type { LeagueId } from '../../../shared/model.js';

export type SportradarAccessLevel = 'trial' | 'production';

export const SPORTRADAR_ENV = {
  nflKey: 'SPORTRADAR_NFL_API_KEY',
  ncaafbKey: 'SPORTRADAR_NCAAFB_API_KEY',
  accessLevel: 'SPORTRADAR_ACCESS_LEVEL',
  push: 'SPORTRADAR_PUSH',
} as const;

/** Documented trial limits (developer.sportradar.com, checked 2026-09-14). */
export const TRIAL_LIMITS = { queriesPerSecond: 1, requestsPer30Days: 1000 } as const;

const REDACTED = '[redacted]';

export class ApiKey {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw key, for the x-api-key request header only. */
  reveal(): string {
    return this.#value;
  }

  equals(other: ApiKey): boolean {
    return this.#value === other.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `ApiKey(${REDACTED})`;
  }
}

export interface SportradarConfig {
  keys: Record<LeagueId, ApiKey | null>;
  accessLevel: SportradarAccessLevel;
  /** True only when SPORTRADAR_PUSH is on and the access level is production. */
  push: boolean;
  /** Settings that were ignored, in plain words. Safe to log: they never contain a key. */
  warnings: string[];
}

export class SportradarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SportradarConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function readKey(env: Env, name: string): ApiKey | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === '') return null;
  // A header value must be printable ASCII without spaces. The value itself is never echoed.
  if (/[^\x21-\x7e]/.test(value)) {
    throw new SportradarConfigError(`${name} contains spaces, control characters or non-ASCII characters. Check the value; it is not shown here.`);
  }
  return new ApiKey(value);
}

function readAccessLevel(env: Env): SportradarAccessLevel {
  const raw = env[SPORTRADAR_ENV.accessLevel]?.trim().toLowerCase();
  if (!raw) return 'trial';
  if (raw === 'trial' || raw === 'production') return raw;
  throw new SportradarConfigError(`${SPORTRADAR_ENV.accessLevel} must be "trial" or "production".`);
}

function readPush(env: Env): boolean {
  const raw = env[SPORTRADAR_ENV.push]?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'on' || raw === 'true' || raw === '1') return true;
  if (raw === 'off' || raw === 'false' || raw === '0') return false;
  throw new SportradarConfigError(`${SPORTRADAR_ENV.push} must be "on" or "off".`);
}

/** Throws SportradarConfigError when no key is set or a value is invalid. */
export function loadSportradarConfig(env: Env): SportradarConfig {
  const nfl = readKey(env, SPORTRADAR_ENV.nflKey);
  let cfb = readKey(env, SPORTRADAR_ENV.ncaafbKey);
  if (!nfl && !cfb) {
    throw new SportradarConfigError(
      `Sportradar has no API key. Set ${SPORTRADAR_ENV.nflKey} for the NFL, ${SPORTRADAR_ENV.ncaafbKey} for college football, or both.`,
    );
  }
  // One key used for both leagues shares one queries-per-second allowance, so both leagues share one instance.
  if (nfl && cfb && nfl.equals(cfb)) cfb = nfl;
  const accessLevel = readAccessLevel(env);
  const pushRequested = readPush(env);
  const warnings: string[] = [];
  if (pushRequested && accessLevel !== 'production') {
    warnings.push(`${SPORTRADAR_ENV.push}=on is ignored: Sportradar push feeds are available on production plans only, and the access level is trial.`);
  }
  return { keys: { nfl, cfb }, accessLevel, push: pushRequested && accessLevel === 'production', warnings };
}

export function missingKeyMessage(league: LeagueId): string {
  return league === 'nfl'
    ? `No Sportradar NFL key is configured. Set ${SPORTRADAR_ENV.nflKey} to read NFL games.`
    : `No Sportradar NCAA football key is configured. Set ${SPORTRADAR_ENV.ncaafbKey} to read college games.`;
}

/** A loggable description of the configuration, without keys. */
export function describeSportradarConfig(config: SportradarConfig): string {
  const set = (k: ApiKey | null) => (k ? 'set' : 'not set');
  return `Sportradar: NFL key ${set(config.keys.nfl)}, NCAA football key ${set(config.keys.cfb)}, access level ${config.accessLevel}, push ${config.push ? 'on' : 'off'}.`;
}
