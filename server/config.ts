/** Server configuration from environment variables. Every value has a safe default. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_FETCH_POLICY, type FetchPolicy } from './fetcher.js';
import { DEFAULT_INTERVALS, type PollIntervals } from './engine.js';

export interface ServerConfig {
  port: number;
  host: string;
  production: boolean;
  /**
   * 'espn' polls the live ESPN feed. 'sportradar' uses the licensed Sportradar APIs with keys from
   * SPORTRADAR_* variables. 'replay' serves the labelled replay lab as the main dashboard (for tests and demos).
   */
  provider: 'espn' | 'sportradar' | 'replay';
  replayScenario: string;
  staticDir: string | null;
  cacheDir: string | null;
  fetch: FetchPolicy;
  intervals: PollIntervals;
  maxStreams: number;
  /** Replay lab sessions a single server will run at once. */
  maxReplaySessions: number;
  /** Behind a reverse proxy, rate limits read the visitor's address from x-forwarded-for. */
  trustProxy: boolean;
}

const int = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const seconds = (v: string | undefined, fallbackMs: number, minS: number, maxS: number) =>
  v === undefined || v === '' ? fallbackMs : int(v, fallbackMs / 1000, minS, maxS) * 1000;

const PROVIDERS: ReadonlyArray<ServerConfig['provider']> = ['espn', 'sportradar', 'replay'];

/** `root` is the repository root; relative paths resolve against it, not the working directory. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root: string = process.cwd()): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const staticCandidate = resolve(root, env.GRIDIRON_STATIC_DIR ?? 'dist');
  const provider = PROVIDERS.find((p) => p === env.GRIDIRON_PROVIDER) ?? 'espn';
  return {
    port: int(env.PORT, 8787, 1, 65535),
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    production,
    provider,
    replayScenario: env.GRIDIRON_REPLAY_SCENARIO ?? 'nfl-week1-sunday',
    staticDir: existsSync(staticCandidate) ? staticCandidate : null,
    cacheDir: env.GRIDIRON_CACHE_DIR === 'off' ? null : resolve(root, env.GRIDIRON_CACHE_DIR ?? '.cache'),
    fetch: {
      ...DEFAULT_FETCH_POLICY,
      timeoutMs: int(env.GRIDIRON_FETCH_TIMEOUT_MS, DEFAULT_FETCH_POLICY.timeoutMs, 1000, 60_000),
      maxConcurrent: int(env.GRIDIRON_FETCH_CONCURRENCY, DEFAULT_FETCH_POLICY.maxConcurrent, 1, 32),
      budgetPerMinute: int(env.GRIDIRON_FETCH_BUDGET, DEFAULT_FETCH_POLICY.budgetPerMinute, 10, 2000),
    },
    intervals: {
      slateLive: seconds(env.GRIDIRON_POLL_SLATE_LIVE_S, DEFAULT_INTERVALS.slateLive, 10, 600),
      slateIdle: seconds(env.GRIDIRON_POLL_SLATE_IDLE_S, DEFAULT_INTERVALS.slateIdle, 60, 3600),
      slatePast: seconds(env.GRIDIRON_POLL_SLATE_PAST_S, DEFAULT_INTERVALS.slatePast, 60, 7200),
      detailFocus: seconds(env.GRIDIRON_POLL_FOCUS_S, DEFAULT_INTERVALS.detailFocus, 8, 300),
      detailVisible: seconds(env.GRIDIRON_POLL_VISIBLE_S, DEFAULT_INTERVALS.detailVisible, 10, 600),
      detailBackground: seconds(env.GRIDIRON_POLL_BACKGROUND_S, DEFAULT_INTERVALS.detailBackground, 20, 1800),
      detailScheduled: seconds(env.GRIDIRON_POLL_SCHEDULED_S, DEFAULT_INTERVALS.detailScheduled, 60, 7200),
      detailFinal: seconds(env.GRIDIRON_POLL_FINAL_S, DEFAULT_INTERVALS.detailFinal, 60, 7200),
    },
    maxStreams: int(env.GRIDIRON_MAX_STREAMS, 500, 1, 10_000),
    maxReplaySessions: int(env.GRIDIRON_MAX_REPLAY_SESSIONS, 25, 0, 500),
    trustProxy: env.GRIDIRON_TRUST_PROXY === '1' || env.GRIDIRON_TRUST_PROXY === 'true',
  };
}
