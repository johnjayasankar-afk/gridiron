/**
 * Watch party routes. A host starts a party and replaces its view with the host
 * token; anyone holding the link follows over server-sent events. The hub keeps
 * only view state (see server/party.ts) and nothing is written to disk.
 *
 *   POST   /api/party              start a party            201 { id, hostToken, view }
 *   GET    /api/party/:id          the current view         200 PartyView
 *   PUT    /api/party/:id          replace the view (host)  200 PartyView
 *   DELETE /api/party/:id          end the party (host)     200 { ok: true }
 *   GET    /api/party/:id/stream   follow: state, members and ended events
 */
import type { IncomingMessage } from 'node:http';
import type { PartyEvent, PartyHub } from './party.js';
import { RateLimiter } from './rateLimit.js';
import { clientAddress, readBody, sameOrigin, SECURITY_HEADERS, send, type ApiRoute } from './respond.js';

export interface PartyRoutesOptions {
  hub: PartyHub | null;
  /** Why parties are unavailable, when there is no hub. */
  reason?: string;
  trustProxy?: boolean;
  maxStreams?: number;
  now?: () => number;
}

const PARTY_ID = /^[a-zA-Z0-9-]{8,64}$/;
const BODY_LIMIT = 8_192;

function bearer(req: IncomingMessage): string {
  return /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
}

async function stateFrom(req: IncomingMessage): Promise<{ state: unknown } | null> {
  try {
    const body = await readBody(req, BODY_LIMIT);
    return { state: body && typeof body === 'object' ? (body as { state?: unknown }).state : undefined };
  } catch {
    return null;
  }
}

export function createPartyRoutes(options: PartyRoutesOptions): ApiRoute {
  const creates = new RateLimiter(12, 10 * 60_000, options.now);
  // Hosts send at most a few updates a second; the hub also limits each party.
  const writes = new RateLimiter(600, 60_000, options.now);
  const maxStreams = options.maxStreams ?? 1_000;
  let streams = 0;

  return async (req, res, url) => {
    if (url.pathname !== '/api/party' && !url.pathname.startsWith('/api/party/')) return false;
    const hub = options.hub;
    if (!hub) {
      send(res, 503, { error: options.reason ?? 'Watch parties are not available on this server' });
      return true;
    }
    const address = clientAddress(req, options.trustProxy === true);
    const writing = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (writing && !sameOrigin(req)) {
      send(res, 403, { error: 'Cross-site requests are not allowed' });
      return true;
    }

    if (url.pathname === '/api/party') {
      if (req.method !== 'POST') {
        send(res, 405, { error: 'Method not allowed' });
        return true;
      }
      const wait = creates.take(address);
      if (wait) {
        send(res, 429, { error: 'Too many watch parties started from here; try again later' }, { 'retry-after': String(wait) });
        return true;
      }
      const body = await stateFrom(req);
      if (!body) {
        send(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      const created = hub.create(body.state);
      if (created.ok) send(res, 201, created.value);
      else send(res, created.status, { error: created.error });
      return true;
    }

    const match = /^\/api\/party\/([^/]+)(\/stream)?$/.exec(url.pathname);
    if (!match || !PARTY_ID.test(match[1])) {
      send(res, 404, { error: 'Unknown or ended watch party' });
      return true;
    }
    const id = match[1];

    if (match[2]) {
      if (req.method !== 'GET') {
        send(res, 405, { error: 'Method not allowed' });
        return true;
      }
      if (streams >= maxStreams) {
        send(res, 503, { error: 'Too many live connections' });
        return true;
      }
      // Joining happens before the stream opens, so an unknown party still answers with a JSON 404.
      let open = false;
      const pending: PartyEvent[] = [];
      const write = (event: PartyEvent) => {
        if (!open) {
          pending.push(event);
          return;
        }
        if (res.writableEnded) return;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'ended') res.end();
      };
      const joined = hub.subscribe(id, write);
      if (!joined.ok) {
        send(res, joined.status, { error: joined.error });
        return true;
      }
      streams++;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...SECURITY_HEADERS,
      });
      res.write('retry: 4000\n\n');
      open = true;
      for (const event of pending.splice(0)) write(event);
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
      }, 15_000);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        joined.value();
        streams = Math.max(0, streams - 1);
      };
      req.on('close', close);
      res.on('close', close);
      return true;
    }

    if (req.method === 'GET') {
      const view = hub.view(id);
      if (view.ok) send(res, 200, view.value);
      else send(res, view.status, { error: view.error });
      return true;
    }

    if (req.method === 'PUT' || req.method === 'DELETE') {
      const wait = writes.take(address);
      if (wait) {
        send(res, 429, { error: 'Too many requests; try again shortly' }, { 'retry-after': String(wait) });
        return true;
      }
      if (req.method === 'DELETE') {
        const ended = hub.end(id, bearer(req));
        if (ended.ok) send(res, 200, { ok: true });
        else send(res, ended.status, { error: ended.error });
        return true;
      }
      const body = await stateFrom(req);
      if (!body) {
        send(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      const updated = hub.update(id, bearer(req), body.state);
      if (updated.ok) send(res, 200, updated.value);
      else send(res, updated.status, { error: updated.error });
      return true;
    }

    send(res, 405, { error: 'Method not allowed' });
    return true;
  };
}
