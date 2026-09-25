/**
 * Gridiron's HTTP surface for the persistent server: JSON endpoints, the
 * server-sent event stream, optional routes (watch parties, push alerts), and
 * (in production) the built client.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { anyFeedUnknown, feedUnknown } from '../shared/availability.js';
import type { Division, LeagueId } from '../shared/model.js';
import { parseGameId } from '../shared/model.js';
import { teamPageAtReplay } from '../shared/team.js';
import { isDateKey } from '../shared/util.js';
import type { ClientInterest, EngineMessage, GridironEngine } from './engine.js';
import { noteAcceptEncoding, readBody, SECURITY_HEADERS, send, type ApiRoute } from './respond.js';
import type { TeamService } from './teams.js';

export { COMPRESS_MIN_BYTES } from './respond.js';

export interface ReplaySessionInfo {
  id: string;
  scenario: string;
  label: string;
}

/** The replay lab, when the server offers it. Each session has its own engine and clock. */
export interface ReplayHub {
  scenarios(): Array<{ id: string; label: string; description: string; synthetic: boolean; date: string }>;
  create(scenario: string, options?: { progress?: number; playing?: boolean; speed?: number }): ReplaySessionInfo | { error: string };
  engine(sessionId: string): GridironEngine | null;
  control(sessionId: string, command: ReplayCommand): Record<string, unknown> | { error: string };
  status(sessionId: string): Record<string, unknown> | null;
}

export type ReplayCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; speed: number }
  | { type: 'step'; seconds: number }
  | { type: 'seek'; progress: number }
  | { type: 'outage'; seconds: number };

export interface AppOptions {
  engine: GridironEngine;
  replay: ReplayHub | null;
  staticDir: string | null;
  maxStreams: number;
  version: string;
  fetcherStats: () => Record<string, unknown>;
  startedAt: number;
  /** 'sse' for the persistent server; 'poll' for serverless deployments that cannot hold streams open. */
  transport?: 'sse' | 'poll';
  /** Team pages; absent where the server does not offer them. */
  teams?: TeamService | null;
  /** Routes outside the engine API (watch parties, push alerts), tried in order before it. */
  routes?: ApiRoute[];
  /** Extra health fields from optional subsystems. */
  health?: () => Record<string, unknown>;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://a.espncdn.com",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Text types the build precompresses (see scripts/compress-assets.mjs). */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt']);
/** Paths that only ever hold real files: a miss is a 404, never the app shell. */
const STATIC_PREFIXES = ['/assets/', '/fonts/', '/icons/'];

/**
 * Files a deploy does not change. The build hashes what it emits into /assets,
 * so those are immutable; the fonts and icons are checked in and replaced only
 * when somebody replaces them, which in practice is never. They were on
 * `no-cache` with no validator to revalidate against, so every visit downloaded
 * 78kB of fonts again in full. A week is the compromise: no request at all for
 * a week, and a week of the old file in the rare event one is swapped.
 */
const LONG_CACHE = ['/fonts/', '/icons/'];
const LONG_CACHE_FILES = new Set(['/favicon.svg', '/og.png']);
const WEEK = 7 * 24 * 60 * 60;

/** A validator, so a revalidation costs a round trip rather than the whole file. */
function etagFor(file: string): string {
  const stat = statSync(file);
  return `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
}

const DIVISIONS: Division[] = ['FBS', 'FCS', 'D2', 'D3'];

export function parseInterest(value: unknown, fallbackDate: string): ClientInterest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string' && parseGameId(i) !== null).slice(0, 64) : []);
  return {
    date: isDateKey(v.date) ? v.date : fallbackDate,
    divisions: Array.isArray(v.divisions) ? v.divisions.filter((d): d is Division => DIVISIONS.includes(d as Division)) : ['FBS', 'FCS'],
    focus: ids(v.focus).slice(0, 4),
    visible: ids(v.visible),
    monitored: ids(v.monitored),
    alertsAllGames: v.alertsAllGames === true,
  };
}

/** The football season a moment belongs to: January and February games finish the previous season. */
export function seasonAt(ms: number): number {
  const d = new Date(ms);
  return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

export function createApp(options: AppOptions) {
  let streams = 0;

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, engine: GridironEngine, base: string, replaySession: string | null) {
    const path = url.pathname.slice(base.length) || '/';

    // Polled deployments let a CDN share each response briefly, so concurrent viewers reuse one provider request.
    // A response the provider never answered for is shared for 2 seconds without stale reuse, so a recovery shows at once.
    const pollCache = (seconds: number, unknown = false): Record<string, string> =>
      options.transport === 'poll' && !replaySession
        ? { 'cache-control': unknown ? 'public, max-age=0, s-maxage=2' : `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 3}` }
        : {};
    if (options.transport === 'poll' && (path === '/interest' || path === '/stream')) {
      return send(res, 404, { error: 'This deployment is polled; the live stream is not available' });
    }

    if (req.method === 'GET' && path === '/slate') {
      const date = url.searchParams.get('date');
      const key = isDateKey(date) ? date : engine.today();
      const slate = await engine.getSlate(key);
      return send(res, 200, slate, pollCache(10, anyFeedUnknown(slate.freshness)));
    }

    const game = /^\/game\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && game) {
      const id = decodeURIComponent(game[1]);
      if (!parseGameId(id)) return send(res, 400, { error: 'Invalid game id' });
      const detail = await engine.getDetail(id);
      return send(res, 200, detail, pollCache(8, !detail.detail && feedUnknown(detail.freshness)));
    }

    const team = /^\/team\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && team) {
      const match = /^(nfl|cfb)-(\d{1,10})$/.exec(decodeURIComponent(team[1]));
      if (!match) return send(res, 400, { error: 'Invalid team id' });
      if (!options.teams) return send(res, 404, { error: 'Team pages are not available on this server' });
      const replay = engine.mode === 'replay';
      const clock = engine.clock();
      const result = await options.teams.get(match[1] as LeagueId, match[2], replay ? { season: seasonAt(clock), saved: true } : {});
      if (!result.ok) return send(res, result.status, { error: result.error });
      // A replay never shows a result before its clock reaches the game.
      const asOf = replay ? new Date(clock).toISOString() : null;
      const page = replay ? teamPageAtReplay(result.page, clock, (gameId) => engine.knownSummary(gameId)) : result.page;
      return send(res, 200, { page, source: result.source, asOf }, pollCache(60));
    }

    if (req.method === 'POST' && path === '/interest') {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
      const b = (body ?? {}) as Record<string, unknown>;
      const clientId = typeof b.clientId === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(b.clientId) ? b.clientId : null;
      const interest = parseInterest(b.interest, engine.today());
      if (!clientId || !interest) return send(res, 400, { error: 'clientId and interest are required' });
      const known = engine.setInterest(clientId, interest);
      return known ? send(res, 200, { ok: true }) : send(res, 409, { error: 'Unknown client; reconnect the stream' });
    }

    if (req.method === 'GET' && path === '/stream') {
      if (streams >= options.maxStreams) return send(res, 503, { error: 'Too many live connections' });
      const requested = url.searchParams.get('clientId');
      const clientId = requested && /^[a-zA-Z0-9-]{8,64}$/.test(requested) ? requested : randomUUID();
      const date = url.searchParams.get('date');
      const interest = parseInterest(
        {
          date,
          divisions: (url.searchParams.get('divisions') ?? 'FBS,FCS').split(','),
          focus: (url.searchParams.get('focus') ?? '').split(',').filter(Boolean),
          visible: (url.searchParams.get('visible') ?? '').split(',').filter(Boolean),
          monitored: (url.searchParams.get('monitored') ?? '').split(',').filter(Boolean),
          alertsAllGames: url.searchParams.get('alertsAll') === '1',
        },
        engine.today(),
      )!;
      streams++;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...SECURITY_HEADERS,
      });
      res.write('retry: 4000\n\n');
      const write = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      write('hello', {
        clientId,
        mode: engine.mode,
        replayLabel: engine.replayLabel,
        replaySession,
        provider: engine.providerInfo,
        today: engine.today(),
        serverTime: new Date().toISOString(),
      });
      const disconnect = engine.connect(clientId, interest, (message: EngineMessage) => write(message.type, message));
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
      }, 15_000);
      const close = () => {
        clearInterval(heartbeat);
        disconnect();
        streams = Math.max(0, streams - 1);
      };
      req.on('close', close);
      return;
    }

    return send(res, 404, { error: 'Not found' });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    const dir = options.staticDir;
    if (!dir) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Gridiron API server. Run the client with `npm run dev`, or build it with `npm run build`.');
      return;
    }
    const root = resolve(dir);
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const exists = existsSync(file) && !statSync(file).isDirectory();
    if (!exists && STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      // A missing hashed file (a chunk from before a deploy, say) must fail as a 404, not load the page in its place.
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
      res.end('Not found');
      return;
    }
    if (!exists) file = join(root, 'index.html'); // client-side routes
    const ext = extname(file);
    const immutable = url.pathname.startsWith('/assets/');
    const longLived = LONG_CACHE.some((prefix) => url.pathname.startsWith(prefix)) || LONG_CACHE_FILES.has(url.pathname);
    const compressible = COMPRESSIBLE.has(ext);
    const accept = String(req.headers['accept-encoding'] ?? '');
    // Checked per request, not cached, so a rebuild under a running server never serves a stale length.
    const encoding = compressible && /\bbr\b/.test(accept) && existsSync(`${file}.br`) ? 'br' : compressible && /\bgzip\b/.test(accept) && existsSync(`${file}.gz`) ? 'gzip' : null;
    const served = encoding === 'br' ? `${file}.br` : encoding === 'gzip' ? `${file}.gz` : file;
    // Per representation, because `vary: accept-encoding` means the compressed file is a different one.
    const etag = etagFor(served);
    const cacheControl = immutable ? 'public, max-age=31536000, immutable' : longLived ? `public, max-age=${WEEK}` : 'no-cache';
    const validators = {
      etag,
      'cache-control': cacheControl,
      ...(compressible ? { vary: 'accept-encoding' } : {}),
      ...SECURITY_HEADERS,
    };
    /*
     * The shell and the service worker stay on `no-cache`, which means revalidate
     * rather than never cache. Without a validator there was nothing to
     * revalidate against and every one of them came back in full.
     */
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, validators);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': String(statSync(served).size),
      ...validators,
      ...(encoding ? { 'content-encoding': encoding } : {}),
      ...(ext === '.html' ? { 'content-security-policy': CSP } : {}),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(served).pipe(res);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    noteAcceptEncoding(req, res);
    try {
      if (url.pathname === '/api/health') {
        return send(res, 200, {
          ok: true,
          version: options.version,
          mode: options.engine.mode,
          transport: options.transport ?? 'sse',
          provider: options.engine.providerInfo,
          today: options.engine.today(),
          serverTime: new Date().toISOString(),
          startedAt: new Date(options.startedAt).toISOString(),
          replayAvailable: options.replay !== null,
          teamsAvailable: !!options.teams,
          fetcher: options.fetcherStats(),
          engine: options.engine.stats(),
          ...options.health?.(),
        });
      }

      for (const route of options.routes ?? []) if (await route(req, res, url)) return;

      if (url.pathname === '/api/replay/scenarios' && req.method === 'GET') {
        return send(res, 200, { scenarios: options.replay?.scenarios() ?? [] });
      }
      if (url.pathname === '/api/replay/sessions' && req.method === 'POST') {
        if (!options.replay) return send(res, 404, { error: 'Replay lab is not available on this server' });
        const body = ((await readBody(req).catch(() => null)) ?? {}) as Record<string, unknown>;
        const progress = typeof body.progress === 'number' && body.progress >= 0 && body.progress <= 1 ? body.progress : undefined;
        const speed = typeof body.speed === 'number' && body.speed >= 1 && body.speed <= 600 ? body.speed : undefined;
        const playing = typeof body.playing === 'boolean' ? body.playing : undefined;
        const created = options.replay.create(typeof body.scenario === 'string' ? body.scenario : '', { progress, speed, playing });
        return 'error' in created ? send(res, 400, created) : send(res, 201, created);
      }
      const session = /^\/api\/replay\/s\/([a-zA-Z0-9-]{8,64})(\/.*)?$/.exec(url.pathname);
      if (session && options.replay) {
        const id = session[1];
        const rest = session[2] ?? '/';
        if (rest === '/control' && req.method === 'POST') {
          const body = (await readBody(req).catch(() => null)) as ReplayCommand | null;
          if (!body || typeof body !== 'object') return send(res, 400, { error: 'Invalid command' });
          const result = options.replay.control(id, body);
          return 'error' in result ? send(res, 400, result) : send(res, 200, result);
        }
        if (rest === '/status' && req.method === 'GET') {
          const status = options.replay.status(id);
          return status ? send(res, 200, status) : send(res, 404, { error: 'Unknown replay session' });
        }
        const engine = options.replay.engine(id);
        if (!engine) return send(res, 404, { error: 'Unknown or expired replay session' });
        return await api(req, res, url, engine, `/api/replay/s/${id}`, id);
      }

      if (url.pathname.startsWith('/api/')) return await api(req, res, url, options.engine, '/api', null);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
      return send(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: 'Server error', detail: (e as Error).message });
      else res.end();
    }
  };
}
