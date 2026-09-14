import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientInterest, EngineMessage } from '../server/engine';
import { PushService, type PushEngine } from '../server/push/service';
import { PushStore } from '../server/push/store';
import { decryptPayload, generateVapidKeys, isAllowedPushEndpoint } from '../server/push/webpush';
import type { GameDetail, GameSummary } from '../shared/model';
import { EMPTY_FRESHNESS } from '../shared/model';
import { detail, game, play } from './helpers/builders';

const servers: Server[] = [];
const services: PushService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A local stand-in for a push service: records every message and answers with a chosen status. */
async function pushReceiver() {
  const received: Buffer[] = [];
  let status = 201;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push(Buffer.concat(chunks));
      res.writeHead(status).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { host, received, answer: (code: number) => (status = code) };
}

/** A browser's side of a subscription. */
function browser(host: string, name: string) {
  const pair = generateVapidKeys();
  const auth = randomBytes(16).toString('base64url');
  return { endpoint: `http://${host}/push/${name}`, keys: { p256dh: pair.publicKey, auth }, receiver: { privateKey: pair.privateKey, publicKey: pair.publicKey, auth } };
}

function fakeEngine(mode: 'live' | 'replay' = 'live') {
  const clients = new Map<string, { interest: ClientInterest; send: (m: EngineMessage) => void }>();
  const details = new Map<string, GameDetail>();
  const engine = {
    mode,
    today: () => '20260914',
    // Mid-afternoon US Eastern, so only today is watched.
    clock: () => Date.parse('2026-09-14T18:00:00Z'),
    connect(id: string, interest: ClientInterest, send: (m: EngineMessage) => void) {
      clients.set(id, { interest, send });
      return () => {
        clients.delete(id);
      };
    },
    setInterest(id: string, interest: ClientInterest) {
      const client = clients.get(id);
      if (!client) return false;
      client.interest = interest;
      return true;
    },
    peekDetail(id: string) {
      const held = details.get(id);
      return held ? { version: 1, detail: held, freshness: EMPTY_FRESHNESS } : null;
    },
  } as unknown as PushEngine;
  const emit = (message: EngineMessage) => {
    for (const client of [...clients.values()]) client.send(message);
  };
  const showDetail = (d: GameDetail) => {
    details.set(d.gameId, d);
    emit({ type: 'detail', gameId: d.gameId, version: 1, detail: d, freshness: EMPTY_FRESHNESS });
  };
  return { engine, clients, emit, showDetail };
}

const slate = (games: GameSummary[]): EngineMessage => ({
  type: 'slate',
  snapshot: {
    seq: 1,
    mode: 'live',
    replayLabel: null,
    date: '20260914',
    generatedAt: '2026-09-14T18:00:00Z',
    games,
    freshness: { nfl: EMPTY_FRESHNESS, cfb: EMPTY_FRESHNESS },
    coverage: { provider: 'test', date: '20260914', divisions: [], conferences: [], discovery: '', limitations: [] },
  },
});

/** Buffalo (nfl-2) at home against Miami (nfl-15). */
function billsGame(o: Parameters<typeof game>[0] = {}, id = 'nfl-401'): GameSummary {
  const g = game({ id, kind: 'in_progress', ...o });
  return { ...g, home: { ...g.home, key: 'nfl-2', abbreviation: 'BUF' }, away: { ...g.away, key: 'nfl-15', abbreviation: 'MIA' } };
}

const touchdown = (summary: GameSummary) =>
  detail(summary, [play({ n: 1, gameId: summary.id, kind: 'touchdown_pass', offense: 'home', startProgress: 80, endProgress: 100, scoring: true, scoringTeam: 'home', home: 7, away: 0 })]);

function setup(mode: 'live' | 'replay' = 'live') {
  return pushReceiver().then((receiver) => {
    const fake = fakeEngine(mode);
    const store = new PushStore({ cacheDir: null, allowEndpoint: (endpoint) => isAllowedPushEndpoint(endpoint, [receiver.host]) });
    const service = new PushService({ engine: fake.engine, store, vapid: generateVapidKeys(), subject: 'mailto:alerts@gridiron.example', allowHosts: [receiver.host], retryDelayMs: 5 });
    services.push(service);
    service.start();
    return { receiver, store, service, ...fake };
  });
}

/** Baseline observations: the game, then its play-by-play before anything new happens. */
function watchKickoff(fake: { emit: (m: EngineMessage) => void; showDetail: (d: GameDetail) => void }, summary: GameSummary) {
  fake.emit(slate([summary]));
  fake.showDetail(detail(summary, []));
}

describe('PushService', () => {
  it('watches only while subscribed, and monitors just the live games of subscribed teams', async () => {
    const t = await setup();
    expect(t.clients.size).toBe(0);
    const fan = browser(t.receiver.host, 'fan');
    expect(t.service.subscribe({ endpoint: fan.endpoint, keys: fan.keys, teams: ['nfl-2'], kinds: ['touchdown'] }).ok).toBe(true);
    expect(t.clients.size).toBe(1);

    const other = game({ id: 'nfl-402', kind: 'in_progress' });
    t.emit(slate([billsGame(), other]));
    const [watch] = [...t.clients.values()];
    expect(watch.interest.monitored).toEqual(['nfl-401']);

    t.service.unsubscribe(fan.endpoint);
    expect(t.clients.size).toBe(0);
  });

  it('sends a reported touchdown, encrypted, to a subscription that follows the team', async () => {
    const t = await setup();
    const fan = browser(t.receiver.host, 'fan');
    t.service.subscribe({ endpoint: fan.endpoint, keys: fan.keys, teams: ['nfl-2'], kinds: ['touchdown', 'final'] });
    watchKickoff(t, billsGame({ home: 0, away: 0 }));
    await t.service.idle();
    expect(t.receiver.received).toHaveLength(0);

    const scored = billsGame({ home: 7, away: 0 });
    t.showDetail(touchdown(scored));
    await t.service.idle();
    expect(t.receiver.received).toHaveLength(1);
    const payload = JSON.parse(decryptPayload(t.receiver.received[0], fan.receiver).toString('utf8')) as Record<string, unknown>;
    expect(payload).toMatchObject({ v: 1, kind: 'touchdown', url: '/game/nfl-401', gameId: 'nfl-401', replay: false });
    expect(String(payload.title)).not.toMatch(/^Replay/);
    expect(t.service.stats()).toMatchObject({ subscriptions: 1, sent: 1, failed: 0 });
  });

  it('sends nothing for kinds a subscription did not choose or teams it does not follow', async () => {
    const t = await setup();
    const fan = browser(t.receiver.host, 'fan');
    const other = browser(t.receiver.host, 'other');
    t.service.subscribe({ endpoint: fan.endpoint, keys: fan.keys, teams: ['nfl-2'], kinds: ['final'] });
    t.service.subscribe({ endpoint: other.endpoint, keys: other.keys, teams: ['nfl-7'], kinds: ['touchdown', 'final'] });
    watchKickoff(t, billsGame({ home: 0, away: 0 }));
    t.showDetail(touchdown(billsGame({ home: 7, away: 0 })));
    await t.service.idle();
    expect(t.receiver.received).toHaveLength(0);
  });

  it('removes a subscription the push service reports gone', async () => {
    const t = await setup();
    t.receiver.answer(410);
    const fan = browser(t.receiver.host, 'fan');
    t.service.subscribe({ endpoint: fan.endpoint, keys: fan.keys, teams: ['nfl-2'], kinds: ['touchdown'] });
    watchKickoff(t, billsGame({ home: 0, away: 0 }));
    t.showDetail(touchdown(billsGame({ home: 7, away: 0 })));
    await t.service.idle();
    expect(t.receiver.received).toHaveLength(1);
    expect(t.store.size).toBe(0);
    expect(t.clients.size).toBe(0);
    expect(t.service.stats()).toMatchObject({ sent: 0, failed: 1 });
  });

  it('labels alerts from a replay as replays', async () => {
    const t = await setup('replay');
    const fan = browser(t.receiver.host, 'fan');
    t.service.subscribe({ endpoint: fan.endpoint, keys: fan.keys, teams: ['nfl-2'], kinds: ['touchdown'] });
    watchKickoff(t, billsGame({ home: 0, away: 0 }));
    t.showDetail(touchdown(billsGame({ home: 7, away: 0 })));
    await t.service.idle();
    const payload = JSON.parse(decryptPayload(t.receiver.received[0], fan.receiver).toString('utf8')) as { title: string; replay: boolean };
    expect(payload.replay).toBe(true);
    expect(payload.title).toMatch(/^Replay: /);
  });

  it('sends a test notification at most once per cooldown', async () => {
    const t = await setup();
    const fan = browser(t.receiver.host, 'fan');
    t.service.subscribe({ endpoint: fan.endpoint, keys: fan.keys, teams: ['nfl-2'], kinds: ['touchdown'] });
    expect(await t.service.sendTest(fan.endpoint)).toEqual({ ok: true });
    const payload = JSON.parse(decryptPayload(t.receiver.received[0], fan.receiver).toString('utf8')) as { title: string; kind: string };
    expect(payload).toMatchObject({ title: 'Gridiron alerts are on', kind: 'test' });
    expect(await t.service.sendTest(fan.endpoint)).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(await t.service.sendTest('https://fcm.googleapis.com/fcm/send/unknown')).toMatchObject({ ok: false, reason: 'unknown' });
  });
});
