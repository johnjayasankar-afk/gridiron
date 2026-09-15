import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GridironEngine } from '../server/engine';
import { COMPRESS_MIN_BYTES, createApp } from '../server/http';

let server: Server;
let base = '';
let dir = '';
const bigSlate = { games: Array.from({ length: 120 }, (_, i) => ({ id: `nfl-${i}`, name: `Game ${i}`, note: 'reported by the provider' })) };

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gridiron-http-'));
  mkdirSync(join(dir, 'assets'));
  const js = `console.log(${JSON.stringify('gridiron '.repeat(400))});`;
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Gridiron</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), js);
  writeFileSync(join(dir, 'assets', 'app.js.br'), brotliCompressSync(js));
  writeFileSync(join(dir, 'assets', 'app.js.gz'), gzipSync(js));
  const engine = { mode: 'live', providerInfo: { id: 'test' }, today: () => '20260913', stats: () => ({}), getSlate: async () => bigSlate } as unknown as GridironEngine;
  const handler = createApp({ engine, replay: null, staticDir: dir, maxStreams: 4, version: 'test', fetcherStats: () => ({}), startedAt: Date.now() });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('http compression and static files', () => {
  it('serves a precompressed asset by preference, with Vary and the compressed length', async () => {
    const br = await get('/assets/app.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('accept-encoding');
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    expect(brotliDecompressSync(br.body).toString()).toContain('gridiron');

    const gz = await get('/assets/app.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toContain('gridiron');

    const plain = await get('/assets/app.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers['cache-control']).toContain('immutable');
    expect(plain.body.toString()).toContain('gridiron');
  });

  it('answers a missing hashed asset with 404 and a client route with the app shell', async () => {
    const missing = await get('/assets/chunk-from-an-old-deploy.js');
    expect(missing.status).toBe(404);
    const route = await get('/game/nfl-401772834');
    expect(route.status).toBe(200);
    expect(route.headers['content-type']).toContain('text/html');
    expect(route.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('gzips large JSON for clients that accept it and leaves small responses alone', async () => {
    expect(JSON.stringify(bigSlate).length).toBeGreaterThan(COMPRESS_MIN_BYTES);
    const zipped = await get('/api/slate', { 'accept-encoding': 'gzip, br' });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.headers.vary).toBe('accept-encoding');
    expect(JSON.parse(gunzipSync(zipped.body).toString())).toEqual(bigSlate);

    const plain = await get('/api/slate');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(plain.body.toString())).toEqual(bigSlate);

    const small = await get('/api/game/not-a-game', { 'accept-encoding': 'gzip' });
    expect(small.status).toBe(400);
    expect(small.headers['content-encoding']).toBeUndefined();
  });
});

describe('polled deployments and the CDN', () => {
  let pollServer: Server;
  let pollBase = '';
  const refused = { lastAttemptAt: '2026-09-15T00:10:00.000Z', lastSuccessAt: null, lastChangeAt: null, health: 'unavailable', error: 'NFL scoreboard: HTTP 403', consecutiveFailures: 1 };
  const answered = { lastAttemptAt: '2026-09-15T00:10:00.000Z', lastSuccessAt: '2026-09-15T00:10:00.000Z', lastChangeAt: null, health: 'connected', error: null, consecutiveFailures: 0 };

  beforeAll(async () => {
    const engine = {
      mode: 'live',
      providerInfo: { id: 'test' },
      today: () => '20260914',
      stats: () => ({}),
      getSlate: async (date: string) => ({ date, games: [], freshness: date === '20260914' ? { nfl: refused, cfb: refused } : { nfl: answered, cfb: answered } }),
      getDetail: async (id: string) => (id === 'nfl-401872931' ? { version: 0, detail: null, freshness: refused } : { version: 3, detail: { gameId: id }, freshness: answered }),
    } as unknown as GridironEngine;
    const handler = createApp({ engine, replay: null, staticDir: null, maxStreams: 0, version: 'test', fetcherStats: () => ({}), startedAt: Date.now(), transport: 'poll' });
    pollServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => pollServer.listen(0, '127.0.0.1', resolve));
    const address = pollServer.address();
    pollBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => {
    pollServer?.close();
  });

  const cacheControl = (path: string) =>
    new Promise<string | undefined>((resolve, reject) => {
      const req = request(`${pollBase}${path}`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers['cache-control']));
      });
      req.on('error', reject);
      req.end();
    });

  it('lets the CDN share an answered slate or game for its full lifetime, with stale reuse', async () => {
    expect(await cacheControl('/api/slate?date=20260913')).toBe('public, max-age=0, s-maxage=10, stale-while-revalidate=30');
    expect(await cacheControl('/api/game/nfl-401872926')).toBe('public, max-age=0, s-maxage=8, stale-while-revalidate=24');
  });

  it('shares a slate or game the provider never answered for only briefly, so a recovery shows at once', async () => {
    expect(await cacheControl('/api/slate?date=20260914')).toBe('public, max-age=0, s-maxage=2');
    expect(await cacheControl('/api/game/nfl-401872931')).toBe('public, max-age=0, s-maxage=2');
  });
});
