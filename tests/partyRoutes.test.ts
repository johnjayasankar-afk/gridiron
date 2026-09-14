import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PartyHub } from '../server/party';
import { createPartyRoutes, type PartyRoutesOptions } from '../server/partyRoutes';
import { send } from '../server/respond';

const STATE = { route: { name: 'slate', id: null }, focusGames: [], source: { kind: 'live' }, inspection: null, delaySeconds: 0, date: null, league: 'all' };

const servers: Server[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
  aborts.splice(0).forEach((a) => a.abort());
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function start(options: Partial<PartyRoutesOptions> = {}) {
  const hub = options.hub === undefined ? new PartyHub() : options.hub;
  const route = createPartyRoutes({ ...options, hub });
  const server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => {
      if (!handled) send(res, 404, { error: 'Not found' });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${base}${path}`, { ...init, body: init.json === undefined ? init.body : JSON.stringify(init.json), headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { hub, base, call };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function follow(url: string) {
  const abort = new AbortController();
  aborts.push(abort);
  const res = await fetch(url, { signal: abort.signal });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const state = { closed: false };
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      } catch {
        // aborted by the test
      }
      state.closed = true;
    })();
  }
  const nth = (type: string, n = 1) => waitFor(() => events.filter((e) => e.event === type)[n - 1]);
  return { status: res.status, events, nth, state };
}

describe('watch party routes', () => {
  it('starts a party, streams host changes to followers, and ends it', async () => {
    const { base, call } = await start();
    const created = await call('/api/party', { method: 'POST', json: { state: STATE } });
    expect(created.status).toBe(201);
    const { id, hostToken, view } = (await created.json()) as { id: string; hostToken: string; view: { rev: number } };
    expect(view.rev).toBe(0);

    const guest = await follow(`${base}/api/party/${id}/stream`);
    expect(guest.status).toBe(200);
    expect((await guest.nth('state')).data).toMatchObject({ type: 'state', view: { id, rev: 0 } });
    expect((await guest.nth('members')).data).toEqual({ type: 'members', members: 1 });

    const next = { ...STATE, route: { name: 'game', id: 'nfl-401872926' }, focusGames: ['nfl-401872926'] };
    expect((await call(`/api/party/${id}`, { method: 'PUT', json: { state: next }, headers: { authorization: 'Bearer wrong' } })).status).toBe(403);
    const updated = await call(`/api/party/${id}`, { method: 'PUT', json: { state: next }, headers: { authorization: `Bearer ${hostToken}` } });
    expect(updated.status).toBe(200);
    expect((await guest.nth('state', 2)).data).toMatchObject({ view: { rev: 1, state: { route: { name: 'game', id: 'nfl-401872926' } } } });

    const current = (await (await call(`/api/party/${id}`)).json()) as { members: number; state: { focusGames: string[] } };
    expect(current).toMatchObject({ members: 1, state: { focusGames: ['nfl-401872926'] } });

    expect((await call(`/api/party/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${hostToken}` } })).status).toBe(200);
    expect((await guest.nth('ended')).data).toEqual({ type: 'ended' });
    await waitFor(() => (guest.state.closed ? true : undefined));
    expect((await call(`/api/party/${id}`)).status).toBe(404);
    expect((await follow(`${base}/api/party/${id}/stream`)).status).toBe(404);
  });

  it('refuses invalid states, bad ids and cross-site writes', async () => {
    const { call } = await start();
    expect((await call('/api/party', { method: 'POST', json: { state: { ...STATE, extra: 1 } } })).status).toBe(400);
    expect((await call('/api/party', { method: 'POST', body: '{not json' })).status).toBe(400);
    expect((await call('/api/party', { method: 'POST', json: { state: STATE }, headers: { origin: 'https://elsewhere.example' } })).status).toBe(403);
    expect((await call('/api/party/..%2Fsecret')).status).toBe(404);
    expect((await call('/api/party', { method: 'GET' })).status).toBe(405);
  });

  it('limits how many parties one address can start', async () => {
    const { call } = await start();
    for (let i = 0; i < 12; i++) expect((await call('/api/party', { method: 'POST', json: { state: STATE } })).status).toBe(201);
    const limited = await call('/api/party', { method: 'POST', json: { state: STATE } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('says so when watch parties are unavailable', async () => {
    const { call } = await start({ hub: null, reason: 'Watch parties need the persistent server' });
    const res = await call('/api/party', { method: 'POST', json: { state: STATE } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Watch parties need the persistent server' });
  });
});
