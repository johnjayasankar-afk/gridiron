import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKey } from '../server/providers/sportradar/config';
import { LineSplitter, parsePushMessage, SportradarPushStream, type PushClock, type PushStreamEvent } from '../server/providers/sportradar/push';

const KEY = new ApiKey('test-key-not-real');
const GAME = '0a000000-0000-4000-8000-000000000002';

const eventLine = (sequence: number) =>
  JSON.stringify({
    payload: {
      game: { id: GAME, status: 'inprogress', quarter: 1, clock: '12:59', summary: { home: { id: 'h', points: 0 }, away: { id: 'a', points: 7 } } },
      event: { type: 'play', id: `play-${sequence}`, sequence, play_type: 'rush', description: 'Rush for 3 yards.' },
    },
    metadata: { league: 'nfl', match: 'm', status: 'inprogress', event_type: 'rush', operation: 'add', version: '7' },
  });

/** Real timers, but every delay the stream asks for is recorded and can be shortened. */
function recordingClock(scale = (ms: number) => ms) {
  const delays: number[] = [];
  const clock: PushClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return setTimeout(fn, scale(ms));
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  return { clock, delays };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 4_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the condition');
    await wait(5);
  }
}

let server: Server | null = null;
afterEach(async () => {
  const s = server;
  server = null;
  if (!s) return;
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('push line parsing', () => {
  it('reassembles lines split across chunks, including inside a UTF-8 character', () => {
    const splitter = new LineSplitter();
    const bytes = new TextEncoder().encode('{"heartbeat":{"interval":5000}}\r\n{"payload":{"event":{"description":"Señor"}},"metadata":{}}\n{"par');
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "ñ"
    const lines = [...splitter.push(bytes.slice(0, 10)), ...splitter.push(bytes.slice(10, cut)), ...splitter.push(bytes.slice(cut))];
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ heartbeat: { interval: 5000 } });
    expect(JSON.parse(lines[1]).payload.event.description).toBe('Señor');
    expect(splitter.push(new TextEncoder().encode('tial":1}\n'))).toEqual(['{"partial":1}']);
    expect(splitter.flush()).toEqual([]);
  });

  it('refuses a line that grows past the limit', () => {
    const splitter = new LineSplitter(16);
    expect(() => splitter.push(new TextEncoder().encode('x'.repeat(40)))).toThrow(/exceeded 16 characters/);
  });

  it('classifies heartbeats, events and anything else', () => {
    expect(parsePushMessage({ heartbeat: { interval: 5000 } })).toEqual({ type: 'heartbeat', interval: 5000 });
    const event = parsePushMessage(JSON.parse(eventLine(1)));
    expect(event.type).toBe('event');
    if (event.type === 'event') {
      expect(event.game?.id).toBe(GAME);
      expect(event.event?.play_type).toBe('rush');
      expect(event.metadata).toEqual({ league: 'nfl', match: 'm', status: 'inprogress', eventType: 'rush', operation: 'add', version: '7' });
    }
    expect(parsePushMessage([1, 2])).toEqual({ type: 'unrecognized' });
    expect(parsePushMessage({ something: 'else' })).toEqual({ type: 'unrecognized' });
  });
});

describe('SportradarPushStream against a local server', () => {
  it('follows the redirect, parses heartbeats and split event lines, reconnects with back-off after a drop, and stops cleanly', async () => {
    const requests: Array<{ path: string; key: string | undefined }> = [];
    let streamConnections = 0;
    let lastStreamClosed = false;
    const base = await listen((req, res) => {
      requests.push({ path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });
      if (req.url === '/subscribe') {
        res.writeHead(302, { location: '/stream' });
        res.end();
        return;
      }
      streamConnections++;
      const n = streamConnections;
      if (n === 2 || n === 3) {
        res.writeHead(503);
        res.end('unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      if (n === 1) {
        const first = eventLine(1);
        const second = eventLine(2);
        const chunks = [
          '{"heartbeat":{"interval":5000}}\n',
          first.slice(0, 40),
          `${first.slice(40)}\n${second.slice(0, 25)}`,
          `${second.slice(25)}\n`,
        ];
        void (async () => {
          for (const c of chunks) {
            res.write(c);
            await wait(15);
          }
          req.socket.destroy(); // drop the connection without ending the response
        })();
        return;
      }
      res.write('{"heartbeat":{"interval":5000}}\n');
      req.on('close', () => {
        lastStreamClosed = true;
      });
    });

    const { clock, delays } = recordingClock();
    const events: PushStreamEvent[] = [];
    const stream = new SportradarPushStream({
      url: `${base}/subscribe`,
      apiKey: KEY,
      clock,
      random: () => 1, // jitter factor 1: each delay is the full exponential value
      silenceMs: 5_000,
      baseBackoffMs: 20,
      maxBackoffMs: 50,
    });
    stream.on((e) => events.push(e));
    stream.start();

    await until(() => events.filter((e) => e.type === 'open').length === 2 && events.some((e) => e.type === 'message' && e.message.type === 'heartbeat' && events.filter((x) => x.type === 'open').length === 2));
    const messages = events.filter((e): e is Extract<PushStreamEvent, { type: 'message' }> => e.type === 'message');
    const playEvents = messages.filter((m) => m.message.type === 'event');
    expect(playEvents).toHaveLength(2);
    expect(playEvents.map((m) => (m.message.type === 'event' ? m.message.event?.id : null))).toEqual(['play-1', 'play-2']);
    expect(events.some((e) => e.type === 'invalid-line')).toBe(false);

    // Every request carried the key, including the ones that followed the redirect.
    expect(requests.every((r) => r.key === 'test-key-not-real')).toBe(true);
    expect(requests.filter((r) => r.path === '/subscribe')).toHaveLength(4);
    expect(requests.filter((r) => r.path === '/stream')).toHaveLength(4);

    // The first connection delivered messages, so back-off started over: 20, then 40, then capped at 50.
    const disconnects = events.filter((e): e is Extract<PushStreamEvent, { type: 'disconnected' }> => e.type === 'disconnected');
    expect(disconnects.map((d) => d.retryInMs)).toEqual([20, 40, 50]);
    expect(disconnects[1].status).toBe(503);
    expect(disconnects[1].reason).toBe('HTTP 503');
    expect(delays).toEqual(expect.arrayContaining([20, 40, 50]));
    expect(stream.state).toBe('open');

    await stream.stop();
    expect(stream.state).toBe('stopped');
    expect(events[events.length - 1].type).toBe('stopped');
    await until(() => lastStreamClosed);
    const connectionsAtStop = streamConnections;
    await wait(150);
    expect(streamConnections).toBe(connectionsAtStop);
    expect(events.filter((e) => e.type === 'connecting')).toHaveLength(4);
  });

  it('reconnects after the configured silence and treats heartbeats as liveness', async () => {
    let connections = 0;
    const base = await listen((req, res) => {
      connections++;
      res.writeHead(200);
      res.flushHeaders();
      if (connections === 1) {
        // Heartbeats every 30ms keep a 100ms silence timer from firing; then the server goes quiet.
        let beats = 0;
        const timer = setInterval(() => {
          if (beats++ < 5) res.write('{"heartbeat":{"interval":5000}}\n');
          else clearInterval(timer);
        }, 30);
        req.on('close', () => clearInterval(timer));
      }
    });
    const events: PushStreamEvent[] = [];
    const { clock } = recordingClock();
    const stream = new SportradarPushStream({ url: base, apiKey: KEY, clock, random: () => 0, silenceMs: 100, baseBackoffMs: 10, maxBackoffMs: 10 });
    stream.on((e) => events.push(e));
    stream.start();
    await until(() => connections >= 2);
    const firstDrop = events.find((e): e is Extract<PushStreamEvent, { type: 'disconnected' }> => e.type === 'disconnected');
    expect(firstDrop?.reason).toBe('No data for 100ms');
    expect(firstDrop?.retryInMs).toBe(5); // jitter factor 0.5 of 10ms
    expect(events.filter((e) => e.type === 'message').length).toBeGreaterThanOrEqual(5);
    await stream.stop();
    expect(stream.state).toBe('stopped');
  });

  it('reports a line that is not JSON and keeps reading', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200);
      res.write('not json\n{"heartbeat":{"interval":5000}}\n');
    });
    const events: PushStreamEvent[] = [];
    const stream = new SportradarPushStream({ url: base, apiKey: KEY, silenceMs: 5_000 });
    stream.on((e) => events.push(e));
    stream.start();
    await until(() => events.some((e) => e.type === 'message'));
    expect(events.find((e) => e.type === 'invalid-line')).toMatchObject({ error: 'A push line was not valid JSON' });
    await stream.stop();
    expect(stream.state).toBe('stopped');
  });
});
