/**
 * Push alerts for the persistent server, wired from the environment: keys, the
 * subscription store, the service and its routes. Whatever keeps push alerts
 * from working (turned off, a replay-only server, keys that fail to load)
 * leaves them unavailable with the reason, and the rest of Gridiron runs as usual.
 *
 * - GRIDIRON_PUSH=off turns push alerts off.
 * - A server running the replay lab as its main data sends no push alerts, unless GRIDIRON_PUSH_REPLAY=1 (tests).
 * - GRIDIRON_PUSH_ALLOW_HOSTS (comma-separated host:port) admits a local test push service, outside production only.
 * - Keys and the subject: see vapid.ts.
 */
import type { GridironEngine } from '../engine.js';
import type { ApiRoute } from '../respond.js';
import { PUSH_KINDS } from '../../shared/push.js';
import { createPushRoutes } from './routes.js';
import { PushService } from './service.js';
import { PushStore } from './store.js';
import { loadVapid } from './vapid.js';
import { isAllowedPushEndpoint } from './webpush.js';

export interface PushSetup {
  routes: ApiRoute;
  health(): Record<string, unknown>;
  start(): void;
  /** Stops sending and saves subscriptions. */
  stop(): Promise<void>;
}

export interface PushSetupOptions {
  engine: GridironEngine;
  env: Record<string, string | undefined>;
  cacheDir: string | null;
  production: boolean;
  trustProxy: boolean;
  log?: (message: string) => void;
}

export function unavailablePush(reason: string, trustProxy = false): PushSetup {
  return {
    routes: createPushRoutes({ service: null, reason, trustProxy }),
    health: () => ({ available: false, reason }),
    start() {},
    async stop() {},
  };
}

export function setupPush(options: PushSetupOptions): PushSetup {
  const { engine, env, cacheDir, production, trustProxy } = options;
  const log = options.log ?? ((message: string) => console.warn(`[push] ${message}`));
  if (env.GRIDIRON_PUSH === 'off') return unavailablePush('Push alerts are turned off on this server', trustProxy);
  if (engine.mode === 'replay' && env.GRIDIRON_PUSH_REPLAY !== '1') return unavailablePush('Push alerts are sent for live games only', trustProxy);

  const vapid = loadVapid({ env, cacheDir });
  if ('error' in vapid) {
    log(`push alerts are unavailable: ${vapid.error}`);
    return unavailablePush(`Push alerts are unavailable on this server: ${vapid.error}`, trustProxy);
  }
  if (vapid.source === 'generated') log('generated VAPID keys in the cache directory; keep that directory so existing subscriptions keep working');

  const allowHosts = production
    ? []
    : (env.GRIDIRON_PUSH_ALLOW_HOSTS ?? '')
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean);
  const store = new PushStore({ cacheDir, kinds: PUSH_KINDS, allowEndpoint: (endpoint) => isAllowedPushEndpoint(endpoint, allowHosts), log });
  const service = new PushService({ engine, store, vapid: vapid.keys, subject: vapid.subject, allowHosts, log });

  return {
    routes: createPushRoutes({ service, trustProxy }),
    health: () => ({ available: true, ...service.stats() }),
    start: () => service.start(),
    async stop() {
      service.stop();
      // Sends already under way get a moment to finish; the subscriptions are saved either way.
      await Promise.race([service.idle(), new Promise((resolve) => setTimeout(resolve, 1_500).unref())]);
      await store.flush();
    },
  };
}
