/**
 * Push alert routes. A browser sends its push subscription with the favorite
 * teams and alert kinds it wants; the service watches those teams' games and
 * sends alerts when real moments are reported.
 *
 *   GET  /api/push/key           availability, the VAPID public key and the choices
 *   POST /api/push/subscribe     { subscription, teams, kinds }
 *   POST /api/push/unsubscribe   { endpoint }
 *   POST /api/push/resubscribe   { oldEndpoint, subscription }, from the service worker
 *   POST /api/push/test          { endpoint }
 */
import { DEFAULT_PUSH_KINDS, PUSH_KINDS } from '../../shared/push.js';
import { RateLimiter } from '../rateLimit.js';
import { clientAddress, readBody, sameOrigin, send, type ApiRoute } from '../respond.js';
import type { PushService } from './service.js';
import { MAX_TEAMS } from './store.js';
import { isAllowedPushEndpoint, type WebPushKeys } from './webpush.js';

export interface PushRoutesOptions {
  /** Null when push alerts are unavailable here; `reason` says why. */
  service: PushService | null;
  reason?: string;
  trustProxy?: boolean;
  now?: () => number;
}

const WRITES = new Set(['/subscribe', '/unsubscribe', '/resubscribe', '/test']);

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function createPushRoutes(options: PushRoutesOptions): ApiRoute {
  const writes = new RateLimiter(30, 10 * 60_000, options.now);
  const reason = options.reason ?? 'Push alerts are not available on this server';

  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/push/')) return false;
    const service = options.service;
    const path = url.pathname.slice('/api/push'.length);

    if (path === '/key') {
      if (req.method !== 'GET' && req.method !== 'HEAD') send(res, 405, { error: 'Method not allowed' });
      else send(res, 200, { available: !!service, ...(service ? { publicKey: service.publicKey } : { reason }), kinds: PUSH_KINDS, defaults: DEFAULT_PUSH_KINDS, maxTeams: MAX_TEAMS });
      return true;
    }
    if (!WRITES.has(path)) {
      send(res, 404, { error: 'Not found' });
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'Method not allowed' });
      return true;
    }
    if (!service) {
      send(res, 503, { error: reason });
      return true;
    }
    if (!sameOrigin(req)) {
      send(res, 403, { error: 'Cross-site requests are not allowed' });
      return true;
    }
    const wait = writes.take(clientAddress(req, options.trustProxy === true));
    if (wait) {
      send(res, 429, { error: 'Too many requests; try again shortly' }, { 'retry-after': String(wait) });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = asObject(await readBody(req, 4_096));
    } catch {
      send(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    // Only known push services, so the server can never be pointed at another host.
    const allowed = (endpoint: unknown): endpoint is string => typeof endpoint === 'string' && isAllowedPushEndpoint(endpoint, service.allowHosts);

    if (path === '/subscribe') {
      const subscription = asObject(body.subscription);
      const endpoint = subscription.endpoint;
      if (!allowed(endpoint)) {
        send(res, 403, { error: 'The subscription endpoint is not a known push service' });
        return true;
      }
      const result = service.subscribe({ endpoint, keys: subscription.keys as WebPushKeys, teams: body.teams as string[], kinds: body.kinds as string[] });
      if (result.ok) send(res, 200, { ok: true, teams: result.record.teams.length, kinds: result.record.kinds.length });
      else send(res, result.reason === 'full' ? 503 : 400, { error: result.error });
      return true;
    }

    if (path === '/unsubscribe') {
      send(res, 200, { ok: true, removed: typeof body.endpoint === 'string' && service.unsubscribe(body.endpoint) });
      return true;
    }

    if (path === '/resubscribe') {
      const subscription = asObject(body.subscription);
      const endpoint = subscription.endpoint;
      if (!allowed(endpoint)) {
        send(res, 403, { error: 'The subscription endpoint is not a known push service' });
        return true;
      }
      const result = service.resubscribe(typeof body.oldEndpoint === 'string' ? body.oldEndpoint : '', { endpoint, keys: subscription.keys as WebPushKeys });
      if (result.ok) send(res, 200, { ok: true });
      else send(res, result.reason === 'unknown' ? 404 : result.reason === 'full' ? 503 : 400, { error: result.error });
      return true;
    }

    const result = await service.sendTest(typeof body.endpoint === 'string' ? body.endpoint : '');
    if (result.ok) send(res, 200, { ok: true });
    else if (result.reason === 'unknown') send(res, 404, { error: result.error });
    else if (result.reason === 'cooldown') send(res, 429, { error: result.error }, { 'retry-after': String(result.retryAfterSeconds) });
    else send(res, result.reason === 'gone' ? 410 : 502, { error: result.error });
    return true;
  };
}
