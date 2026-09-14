import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_PAYLOAD_BYTES,
  buildPushRequest,
  decryptPayload,
  encryptPayload,
  generateVapidKeys,
  isAllowedPushEndpoint,
  sendPush,
  vapidHeaders,
  type PushMessageOptions,
  type PushUrgency,
  type SendPushOptions,
  type WebPushReceiver,
  type WebPushSubscription,
} from '../server/push/webpush';

/** RFC 8291, section 5 and appendix A: the example's inputs, and the exact message they must produce. */
const RFC8291 = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const subject = 'mailto:alerts@gridiron.example';
const vapid = generateVapidKeys();
const AUTHORIZATION_SHAPE = /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/;

/** A browser's side of a new subscription. Its keys have the same raw P-256 form as VAPID keys. */
function browserSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/test-token'): { subscription: WebPushSubscription; receiver: WebPushReceiver } {
  const keys = generateVapidKeys();
  const auth = randomBytes(16).toString('base64url');
  return { subscription: { endpoint, keys: { p256dh: keys.publicKey, auth } }, receiver: { privateKey: keys.privateKey, publicKey: keys.publicKey, auth } };
}

function decodeJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Splits "vapid t=<jwt>, k=<key>" into its parts, or null when the header does not have that shape. */
function parseVapid(header: string | undefined) {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header ?? '');
  return match ? { header: match[1], claims: match[2], signature: match[3], key: match[4] } : null;
}

describe('web push encryption', () => {
  it('reproduces the RFC 8291 example message byte for byte and decrypts it', () => {
    const plaintext = Buffer.from(RFC8291.plaintext, 'base64url');
    const body = encryptPayload(plaintext, { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret }, {
      salt: Buffer.from(RFC8291.salt, 'base64url'),
      localPrivateKey: RFC8291.asPrivate,
    });
    expect(body.toString('base64url')).toBe(RFC8291.message);
    expect(body.subarray(21, 86).toString('base64url')).toBe(RFC8291.asPublic);

    const receiver = { privateKey: RFC8291.uaPrivate, publicKey: RFC8291.uaPublic, auth: RFC8291.authSecret };
    const decrypted = decryptPayload(Buffer.from(RFC8291.message, 'base64url'), receiver);
    expect(decrypted.equals(plaintext)).toBe(true);
    expect(decrypted.toString('ascii')).toBe('When I grow up, I want to be a watermelon');
  });

  it('round-trips a UTF-8 payload with fresh keys, a new salt and a new ephemeral key every time', () => {
    const { subscription, receiver } = browserSubscription();
    const payload = JSON.stringify({ title: 'Touchdown', body: 'Señor Müller, 12 yards in 東京 \u{1F3C8}' });
    const first = encryptPayload(payload, subscription.keys);
    const second = encryptPayload(payload, subscription.keys);
    expect(decryptPayload(first, receiver).toString('utf8')).toBe(payload);
    expect(decryptPayload(second, receiver).toString('utf8')).toBe(payload);
    expect(first.length).toBe(86 + Buffer.byteLength(payload) + 1 + 16);
    expect(first.readUInt32BE(16)).toBe(4096);
    expect(first[20]).toBe(65);
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false);
  });

  it('refuses an altered body and keys that do not match', () => {
    const { subscription, receiver } = browserSubscription();
    const body = encryptPayload('score update', subscription.keys);
    const altered = Buffer.from(body);
    altered[altered.length - 20] ^= 0x01;
    expect(() => decryptPayload(altered, receiver)).toThrow(/failed authentication/);
    const stranger = browserSubscription().receiver;
    expect(() => decryptPayload(body, { ...stranger, auth: receiver.auth })).toThrow(/failed authentication/);
    expect(() => decryptPayload(body, { ...receiver, publicKey: stranger.publicKey })).toThrow(/does not belong/);
  });

  it('rejects payloads that do not fit in one record or a 4096-byte body', () => {
    const { subscription, receiver } = browserSubscription();
    expect(MAX_PAYLOAD_BYTES).toBe(3993);
    const largest = encryptPayload('x'.repeat(MAX_PAYLOAD_BYTES), subscription.keys);
    expect(largest.length).toBe(4096);
    expect(decryptPayload(largest, receiver).length).toBe(MAX_PAYLOAD_BYTES);
    expect(() => encryptPayload('x'.repeat(MAX_PAYLOAD_BYTES + 1), subscription.keys)).toThrow(/too large/);
    // The limit counts bytes, not characters: 2000 two-byte characters are 4000 bytes.
    expect(() => encryptPayload('é'.repeat(2000), subscription.keys)).toThrow(/too large/);
    expect(encryptPayload('x'.repeat(47), subscription.keys, { recordSize: 64 }).length).toBe(86 + 64);
    expect(() => encryptPayload('x'.repeat(48), subscription.keys, { recordSize: 64 })).toThrow(/does not fit/);
    expect(() => buildPushRequest(subscription, 'x'.repeat(MAX_PAYLOAD_BYTES + 1), { vapid, subject })).toThrow(/too large/);
  });

  it('rejects malformed subscription keys', () => {
    const { subscription } = browserSubscription();
    expect(() => encryptPayload('hi', { ...subscription.keys, p256dh: subscription.keys.p256dh.slice(0, 40) })).toThrow(/p256dh key must be 65 bytes/);
    const offCurve = Buffer.concat([Buffer.of(0x04), Buffer.alloc(64)]).toString('base64url');
    expect(() => encryptPayload('hi', { ...subscription.keys, p256dh: offCurve })).toThrow(/not a point on the P-256 curve/);
    expect(() => encryptPayload('hi', { ...subscription.keys, auth: 'not base64url!' })).toThrow(/auth secret must be a base64url string/);
  });
});

describe('VAPID', () => {
  it('generates raw P-256 keys in the forms PushManager.subscribe expects', () => {
    const keys = generateVapidKeys();
    const publicKey = Buffer.from(keys.publicKey, 'base64url');
    expect(publicKey.length).toBe(65);
    expect(publicKey[0]).toBe(0x04);
    expect(Buffer.from(keys.privateKey, 'base64url').length).toBe(32);
    expect(generateVapidKeys().privateKey).not.toBe(keys.privateKey);
  });

  it('signs an ES256 JWT with aud, exp and sub that verifies against the public key', () => {
    const now = 1_790_000_000;
    const parts = parseVapid(vapidHeaders('https://fcm.googleapis.com/fcm/send/abc:123', vapid, subject, now).Authorization);
    expect(parts).not.toBeNull();
    const { header, claims, signature, key } = parts!;
    expect(key).toBe(vapid.publicKey);
    expect(decodeJson(header)).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(decodeJson(claims)).toEqual({ aud: 'https://fcm.googleapis.com', exp: now + 12 * 3600, sub: subject });

    const point = Buffer.from(key, 'base64url');
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const raw = Buffer.from(signature, 'base64url');
    expect(raw.length).toBe(64);
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
    const forged = Buffer.from(JSON.stringify({ aud: 'https://fcm.googleapis.com', exp: now + 48 * 3600, sub: subject })).toString('base64url');
    expect(verify('sha256', Buffer.from(`${header}.${forged}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(false);
  });

  it('keeps exp within 24 hours of now and refuses longer lifetimes', () => {
    const before = Math.floor(Date.now() / 1000);
    const parts = parseVapid(vapidHeaders('https://updates.push.services.mozilla.com/wpush/v2/abc', vapid, subject).Authorization);
    const { aud, exp } = decodeJson(parts!.claims) as { aud: string; exp: number };
    expect(aud).toBe('https://updates.push.services.mozilla.com');
    expect(exp).toBeGreaterThan(before);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 24 * 3600);
    expect(() => vapidHeaders('https://web.push.apple.com/abc', vapid, subject, before, 24 * 3600 + 1)).toThrow(/lifetime/);
    expect(() => vapidHeaders('https://web.push.apple.com/abc', vapid, subject, before, 0)).toThrow(/lifetime/);
  });

  it('accepts only a mailto: address or an https: URL as the subject', () => {
    const endpoint = 'https://web.push.apple.com/abc';
    expect(() => vapidHeaders(endpoint, vapid, 'https://gridiron.example/contact')).not.toThrow();
    for (const bad of ['alerts@gridiron.example', 'mailto:', 'mailto:alerts', 'mailto: alerts@gridiron.example', 'http://gridiron.example', 'https://', '']) {
      expect(() => vapidHeaders(endpoint, vapid, bad), bad).toThrow(/subject/);
    }
  });

  it('refuses a public key that belongs to a different private key', () => {
    const other = generateVapidKeys();
    expect(() => vapidHeaders('https://web.push.apple.com/abc', { publicKey: other.publicKey, privateKey: vapid.privateKey }, subject)).toThrow(/does not belong/);
  });
});

describe('buildPushRequest', () => {
  it('sets the encryption, TTL, urgency, topic and VAPID headers', () => {
    const { subscription, receiver } = browserSubscription();
    const request = buildPushRequest(subscription, 'hello', { vapid, subject, ttlSeconds: 120, urgency: 'high', topic: 'game-401772834' });
    expect(request.url).toBe(subscription.endpoint);
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '120',
      Urgency: 'high',
      Topic: 'game-401772834',
      Authorization: expect.stringMatching(AUTHORIZATION_SHAPE),
    });
    expect(decryptPayload(request.body, receiver).toString()).toBe('hello');

    const defaults = buildPushRequest(subscription, 'hello', { vapid, subject });
    expect(defaults.headers.TTL).toBe('3600');
    expect(defaults.headers.Urgency).toBe('normal');
    expect(defaults.headers.Topic).toBeUndefined();
  });

  it('validates the topic, TTL, urgency and subject', () => {
    const { subscription } = browserSubscription();
    const build = (over: Partial<PushMessageOptions>) => () => buildPushRequest(subscription, 'hi', { vapid, subject, ...over });
    expect(build({ topic: 'a'.repeat(32) })).not.toThrow();
    for (const topic of ['', 'a'.repeat(33), 'has space', 'padded==', 'plus+slash/']) expect(build({ topic }), topic).toThrow(/topic/);
    expect(build({ ttlSeconds: -1 })).toThrow(/TTL/);
    expect(build({ ttlSeconds: 1.5 })).toThrow(/TTL/);
    expect(build({ urgency: 'urgent' as PushUrgency })).toThrow(/urgency/);
    expect(build({ subject: 'gridiron' })).toThrow(/subject/);
  });
});

describe('isAllowedPushEndpoint', () => {
  it('accepts https endpoints on the known push services', () => {
    const endpoints = [
      'https://fcm.googleapis.com/fcm/send/abc:APA91b',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
      'https://web.push.apple.com/QGuQyavXutnMH',
      'https://sandbox.push.apple.com/abc',
      'https://db5p.notify.windows.com/w/?token=abc',
    ];
    for (const endpoint of endpoints) expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true);
  });

  it('rejects http, other hosts, lookalikes, odd ports and credentials in the URL', () => {
    const endpoints = [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://example.com/push/abc',
      'https://fcm.googleapis.com.evil.example/fcm/send/abc',
      'https://evil.example/fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com@evil.example/fcm/send/abc',
      'https://user:secret@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://fcm.googleapis.com./fcm/send/abc',
      'https://notify.windows.com.evil.example/w/',
      'https://evilpush.apple.com/abc',
      'https://push.apple.com/abc',
      'wss://fcm.googleapis.com/fcm/send/abc',
      'not a url',
      '',
    ];
    for (const endpoint of endpoints) expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
  });

  it('allows exact host:port entries from extraHosts, over http or https', () => {
    const extra = ['127.0.0.1:8123'];
    expect(isAllowedPushEndpoint('http://127.0.0.1:8123/push/abc')).toBe(false);
    expect(isAllowedPushEndpoint('http://127.0.0.1:8123/push/abc', extra)).toBe(true);
    expect(isAllowedPushEndpoint('https://127.0.0.1:8123/push/abc', extra)).toBe(true);
    expect(isAllowedPushEndpoint('http://127.0.0.1:9999/push/abc', extra)).toBe(false);
    expect(isAllowedPushEndpoint('http://127.0.0.1/push/abc', extra)).toBe(false);
    expect(isAllowedPushEndpoint('ftp://127.0.0.1:8123/push/abc', extra)).toBe(false);
  });
});

/** A fetch stand-in that records its calls and answers with the given response, or fails with the given error. */
function fakeFetch(outcome: Response | Error) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
}

describe('sendPush', () => {
  const { subscription } = browserSubscription();
  const send = (impl: unknown, over: Partial<SendPushOptions> = {}) =>
    sendPush(subscription, 'score update', { vapid, subject, fetch: impl as typeof fetch, ...over });

  it('posts the encrypted message and reports a 201 as delivered', async () => {
    const impl = fakeFetch(new Response(null, { status: 201 }));
    expect(await send(impl)).toEqual({ ok: true, status: 201 });
    expect(impl).toHaveBeenCalledTimes(1);
    const [url, init] = impl.mock.calls[0];
    expect(url).toBe(subscription.endpoint);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '3600', Authorization: expect.stringMatching(AUTHORIZATION_SHAPE) });
    expect((init?.body as Uint8Array).byteLength).toBe(86 + 'score update'.length + 1 + 16);
  });

  it('marks 404 and 410 as gone', async () => {
    expect(await send(fakeFetch(new Response('', { status: 410 })))).toEqual({ ok: false, status: 410, retryable: false, gone: true });
    expect(await send(fakeFetch(new Response(null, { status: 404 })))).toEqual({ ok: false, status: 404, retryable: false, gone: true });
  });

  it('marks 429 and 5xx as retryable, with Retry-After in seconds', async () => {
    const throttled = await send(fakeFetch(new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } })));
    expect(throttled).toEqual({ ok: false, status: 429, retryable: true, retryAfterSeconds: 120 });
    expect(await send(fakeFetch(new Response(null, { status: 500 })))).toEqual({ ok: false, status: 500, retryable: true });

    const dated = await send(fakeFetch(new Response(null, { status: 503, headers: { 'Retry-After': new Date(Date.now() + 90_000).toUTCString() } })));
    const wait = 'retryAfterSeconds' in dated ? dated.retryAfterSeconds : undefined;
    expect(dated).toMatchObject({ ok: false, status: 503, retryable: true });
    expect(wait).toBeGreaterThanOrEqual(85);
    expect(wait).toBeLessThanOrEqual(90);
  });

  it('reports any other rejection with the reason the service gave, as not retryable', async () => {
    expect(await send(fakeFetch(new Response('invalid JWT provided', { status: 403 })))).toEqual({
      ok: false,
      status: 403,
      retryable: false,
      error: 'HTTP 403: invalid JWT provided',
    });
  });

  it('reports network failures and timeouts as status 0, retryable', async () => {
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });
    expect(await send(fakeFetch(refused))).toEqual({ ok: false, status: 0, retryable: true, error: 'Network error: fetch failed (ECONNREFUSED)' });

    const hung = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    expect(await send(hung, { timeoutMs: 25 })).toEqual({ ok: false, status: 0, retryable: true, error: 'Timed out after 25ms' });
  });

  it('refuses endpoints that are not allowed push services without calling fetch', async () => {
    const impl = fakeFetch(new Response(null, { status: 201 }));
    const attempt = (endpoint: string, allowHosts?: string[]) =>
      sendPush({ ...subscription, endpoint }, 'score update', { vapid, subject, fetch: impl as unknown as typeof fetch, allowHosts });
    await expect(attempt('https://fcm.googleapis.com.evil.example/fcm/send/abc')).rejects.toThrow(/Refusing to send a push to fcm\.googleapis\.com\.evil\.example/);
    await expect(attempt('http://127.0.0.1:8123/push/abc')).rejects.toThrow(/Refusing/);
    await expect(attempt('http://127.0.0.1:8123/push/abc', ['127.0.0.1:9999'])).rejects.toThrow(/Refusing/);
    // The endpoint path is a credential for the subscription, so the error names only the host.
    const error = await attempt('https://evil.example/push/secret-token').catch((e: unknown) => e);
    expect(String(error)).toContain('evil.example');
    expect(String(error)).not.toContain('secret-token');
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('sendPush against a local push service', () => {
  const { subscription: browser, receiver } = browserSubscription();
  const deliveries: Array<{ headers: IncomingHttpHeaders; plaintext: string }> = [];
  let server: Server;
  let host = '';

  /** What a push service checks before it accepts a message. Returns the decrypted plaintext, or throws the problem. */
  function accept(method: string | undefined, headers: IncomingHttpHeaders, body: Buffer): string {
    if (method !== 'POST' || headers['content-encoding'] !== 'aes128gcm') throw new Error('expected an aes128gcm POST');
    const parts = parseVapid(headers.authorization);
    if (!parts || parts.key !== vapid.publicKey) throw new Error('Authorization is not "vapid t=<jwt>, k=<key>" for the expected key');
    if ((decodeJson(parts.claims) as { aud?: unknown }).aud !== `http://${host}`) throw new Error('the token audience is not this service');
    if (headers.ttl !== '60') throw new Error(`TTL was ${String(headers.ttl)}`);
    return decryptPayload(body, receiver).toString('utf8');
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const plaintext = accept(req.method, req.headers, Buffer.concat(chunks));
          deliveries.push({ headers: req.headers, plaintext });
          res.writeHead(201, { location: `/messages/${deliveries.length}` }).end();
        } catch (e) {
          res.writeHead(400, { 'content-type': 'text/plain' }).end((e as Error).message);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    host = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => {
    server?.close();
  });

  it('delivers a message the service can authenticate and decrypt', async () => {
    const payload = JSON.stringify({ title: 'Touchdown', body: 'Muñoz, 12 yard run' });
    const subscription = { ...browser, endpoint: `http://${host}/push/subscription-token` };
    const result = await sendPush(subscription, payload, { vapid, subject, ttlSeconds: 60, urgency: 'high', allowHosts: [host] });
    expect(result).toEqual({ ok: true, status: 201 });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].plaintext).toBe(payload);
    expect(deliveries[0].headers.authorization).toMatch(AUTHORIZATION_SHAPE);
    expect(deliveries[0].headers.ttl).toBe('60');
    expect(deliveries[0].headers.urgency).toBe('high');
  });
});
