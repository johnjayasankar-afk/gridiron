import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPushRoutes } from '../server/push/routes';
import { PushService, type PushEngine } from '../server/push/service';
import { PushStore } from '../server/push/store';
import { generateVapidKeys, isAllowedPushEndpoint } from '../server/push/webpush';
import { send } from '../server/respond';
import { EMPTY_FRESHNESS } from '../shared/model';

const servers: Server[] = [];
const services: PushService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const idleEngine = {
  mode: 'live',
  today: () => '20260914',
  clock: () => Date.parse('2026-09-14T18:00:00Z'),
  connect: () => () => {},
  setInterest: () => true,
  peekDetail: () => ({ version: 0, detail: null, freshness: EMPTY_FRESHNESS }),
} as unknown as PushEngine;

async function start(available = true) {
  const received: number[] = [];
  const pushHost = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push(Date.now());
      res.writeHead(201).end();
    });
  });
  let service: PushService | null = null;
  if (available) {
    const store = new PushStore({ cacheDir: null, allowEndpoint: (endpoint) => isAllowedPushEndpoint(endpoint, [pushHost]) });
    service = new PushService({ engine: idleEngine, store, vapid: generateVapidKeys(), subject: 'mailto:alerts@gridiron.example', allowHosts: [pushHost] });
    services.push(service);
    service.start();
  }
  const route = createPushRoutes({ service, reason: 'Push alerts need the persistent Gridiron server' });
  const apiHost = await listen((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => {
      if (!handled) send(res, 404, { error: 'Not found' });
    });
  });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://${apiHost}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const subscription = (name: string, host = pushHost) => ({ endpoint: `http://${host}/push/${name}`, keys: { p256dh: generateVapidKeys().publicKey, auth: randomBytes(16).toString('base64url') } });
  return { call, subscription, received, service };
}

describe('push routes', () => {
  it('says why push alerts are unavailable', async () => {
    const { call } = await start(false);
    const key = await call('/api/push/key');
    expect(await key.json()).toMatchObject({ available: false, reason: 'Push alerts need the persistent Gridiron server' });
    expect((await call('/api/push/subscribe', {})).status).toBe(503);
  });

  it('subscribes only known push services with valid keys, and unsubscribes', async () => {
    const { call, subscription, service } = await start();
    const key = (await (await call('/api/push/key')).json()) as { available: boolean; publicKey: string; defaults: string[] };
    expect(key.available).toBe(true);
    expect(key.publicKey).toBe(service?.publicKey);
    expect(key.defaults).toContain('touchdown');

    const choice = { teams: ['nfl-2'], kinds: ['touchdown'] };
    for (const endpoint of ['http://169.254.169.254/latest/meta-data', 'https://localhost/push/x', 'https://user:pass@fcm.googleapis.com/fcm/send/x', 'ftp://fcm.googleapis.com/x']) {
      expect((await call('/api/push/subscribe', { subscription: { ...subscription('x'), endpoint }, ...choice })).status).toBe(403);
    }
    expect((await call('/api/push/subscribe', { subscription: { ...subscription('x'), keys: { p256dh: 'nope', auth: 'nope' } }, ...choice })).status).toBe(400);
    expect((await call('/api/push/subscribe', { subscription: subscription('x'), teams: [], kinds: ['touchdown'] })).status).toBe(400);

    const fan = subscription('fan');
    const ok = await call('/api/push/subscribe', { subscription: fan, ...choice });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, teams: 1, kinds: 1 });
    expect(await (await call('/api/push/unsubscribe', { endpoint: fan.endpoint })).json()).toEqual({ ok: true, removed: true });
    expect(await (await call('/api/push/unsubscribe', { endpoint: fan.endpoint })).json()).toEqual({ ok: true, removed: false });
  });

  it('sends a test notification, then refuses a repeat within the cooldown', async () => {
    const { call, subscription, received } = await start();
    const fan = subscription('fan');
    await call('/api/push/subscribe', { subscription: fan, teams: ['nfl-2'], kinds: ['touchdown'] });
    expect((await call('/api/push/test', { endpoint: fan.endpoint })).status).toBe(200);
    expect(received).toHaveLength(1);
    const again = await call('/api/push/test', { endpoint: fan.endpoint });
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call('/api/push/test', { endpoint: subscription('stranger').endpoint })).status).toBe(404);
  });

  it('moves a replaced subscription for the service worker', async () => {
    const { call, subscription } = await start();
    const first = subscription('first');
    const second = subscription('second');
    expect((await call('/api/push/resubscribe', { oldEndpoint: first.endpoint, subscription: second })).status).toBe(404);
    await call('/api/push/subscribe', { subscription: first, teams: ['nfl-2', 'cfb-333'], kinds: ['final'] });
    expect((await call('/api/push/resubscribe', { oldEndpoint: first.endpoint, subscription: second })).status).toBe(200);
    expect(await (await call('/api/push/unsubscribe', { endpoint: second.endpoint })).json()).toEqual({ ok: true, removed: true });
  });

  it('refuses cross-site writes, bad bodies, wrong methods and floods', async () => {
    const { call } = await start();
    expect((await call('/api/push/unsubscribe', { endpoint: 'x' }, { origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await call('/api/push/subscribe', '{ not json')).status).toBe(400);
    expect((await call('/api/push/subscribe')).status).toBe(405);
    expect((await call('/api/push/everything', {})).status).toBe(404);
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) limited = (await call('/api/push/unsubscribe', { endpoint: `https://fcm.googleapis.com/fcm/send/${i}` })).status === 429;
    expect(limited).toBe(true);
  });
});
