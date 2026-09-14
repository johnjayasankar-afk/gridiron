/**
 * Web Push delivery for Gridiron alerts, built on node:crypto alone.
 *
 * - VAPID (RFC 8292): every request carries an ES256 JWT signed with the server's key pair, whose public half is
 *   the applicationServerKey the browser subscribed with.
 * - Payload encryption (RFC 8291, using the aes128gcm content coding of RFC 8188): a fresh ephemeral key and salt
 *   for each message, sealed as a single record, and never a body over the 4096 bytes push services must accept.
 * - decryptPayload is the browser's half of the exchange, for tests and a local mock push service.
 * - sendPush only posts to known push services (or exact host:port entries a caller allows, such as a local mock),
 *   has a timeout, and reports each outcome as a result: delivered, gone (delete the subscription), retryable
 *   (429, 5xx, network failures and timeouts, with Retry-After when given) or rejected.
 * - An endpoint URL is effectively a credential for its subscription, so errors name its host, never the full URL.
 */
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type ECDH } from 'node:crypto';

/** A VAPID key pair in the raw base64url forms browsers use. */
export interface VapidKeys {
  /** The uncompressed P-256 point (65 bytes, 0x04 first): pass it to PushManager.subscribe as applicationServerKey. */
  publicKey: string;
  /** The raw 32-byte private scalar. It stays on the server. */
  privateKey: string;
}

/** The keys of a subscription, as PushSubscription.toJSON() gives them (base64url). */
export interface WebPushKeys {
  /** The browser's uncompressed P-256 public key. */
  p256dh: string;
  /** The browser's 16-byte authentication secret. */
  auth: string;
}

export interface WebPushSubscription {
  endpoint: string;
  keys: WebPushKeys;
}

/** The browser's half of a subscription: its key pair and auth secret, base64url. */
export interface WebPushReceiver {
  privateKey: string;
  publicKey: string;
  auth: string;
}

export interface EncryptOptions {
  /** 16 bytes, random by default. Fix it only to reproduce a test vector. */
  salt?: Uint8Array;
  /** The application server's ephemeral private scalar (base64url), new for every message by default. Fix it only to reproduce a test vector. */
  localPrivateKey?: string;
  /** The aes128gcm record size (4096 by default). The whole message must fit in one record. */
  recordSize?: number;
}

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface PushMessageOptions {
  vapid: VapidKeys;
  /** How the push service can reach the sender: a mailto: address or an https: URL. */
  subject: string;
  /** How long the push service may hold the message for a device that is offline (one hour by default). */
  ttlSeconds?: number;
  /** Lets the push service hold less urgent messages to save the device's battery ('normal' by default). */
  urgency?: PushUrgency;
  /** A newer message with the same topic replaces an older one still waiting. Up to 32 base64url characters. */
  topic?: string;
}

export interface SendPushOptions extends PushMessageOptions {
  fetch?: typeof fetch;
  /** Ten seconds by default. */
  timeoutMs?: number;
  /** Exact host:port entries to allow besides the known push services, over http or https (a local mock service). */
  allowHosts?: string[];
}

export interface PushRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  /** Backed by a plain ArrayBuffer, which is what fetch accepts as a request body. */
  body: Buffer<ArrayBuffer>;
}

/**
 * The outcome of one push.
 * - ok: a 2xx, so the push service accepted the message.
 * - gone: a 404 or 410, so the subscription expired or was removed. Delete it.
 * - retryable with no error: a 429 or 5xx. Try again later, and not before retryAfterSeconds when it is set.
 * - error with status 0: the request failed on the network or timed out. It is retryable.
 * - error with any other status: the service rejected this request (its VAPID credentials or headers, say),
 *   so resending it unchanged would fail again.
 */
export type PushResult =
  | { ok: true; status: number }
  | { ok: false; status: number; retryable: false; gone: true }
  | { ok: false; status: number; retryable: true; retryAfterSeconds?: number }
  | { ok: false; status: number; retryable: boolean; error: string };

const CURVE = 'prime256v1';
const PUBLIC_KEY_BYTES = 65;
const PRIVATE_KEY_BYTES = 32;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
/** salt(16) || rs(4) || idlen(1) || keyid(65), where keyid is the application server's public key. */
const HEADER_BYTES = SALT_BYTES + 4 + 1 + PUBLIC_KEY_BYTES;
/** A smaller record cannot hold the tag and the delimiter. */
const MIN_RECORD_SIZE = 18;
const MAX_RECORD_SIZE = 0xffff_ffff;
const DEFAULT_RECORD_SIZE = 4096;
/** Push services must accept bodies of up to 4096 bytes and may refuse anything larger. */
const MAX_BODY_BYTES = 4096;
/** The largest plaintext that fits: 4096 less the 86-byte header, the delimiter and the tag, which is 3993 bytes. */
export const MAX_PAYLOAD_BYTES = MAX_BODY_BYTES - HEADER_BYTES - 1 - TAG_BYTES;
/** Ends the plaintext of the last (here, the only) record. */
const LAST_RECORD_DELIMITER = 0x02;
/** RFC 8292 caps a VAPID token's exp at 24 hours after the request. */
const MAX_VAPID_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_VAPID_TTL_SECONDS = 12 * 60 * 60;
/** Live game alerts go stale quickly, so an undelivered message expires after an hour unless the caller says otherwise. */
const DEFAULT_MESSAGE_TTL_SECONDS = 60 * 60;
const DEFAULT_TIMEOUT_MS = 10_000;
const JWT_HEADER = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
/** HKDF info strings. Each ends with a zero byte. */
const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0');
const URGENCIES: readonly PushUrgency[] = ['very-low', 'low', 'normal', 'high'];
/** RFC 8030 limits a topic to 32 characters of the base64url alphabet. */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_SERVICE_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

/** Decodes base64url strictly: a stray character is an error rather than silently skipped. */
function fromBase64Url(value: unknown, label: string): Buffer {
  const text = typeof value === 'string' ? value.replace(/=+$/, '') : '';
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(`${label} must be a base64url string`);
  return Buffer.from(text, 'base64url');
}

function decodeFixed(value: unknown, bytes: number, label: string): Buffer {
  const decoded = fromBase64Url(value, label);
  if (decoded.length !== bytes) throw new Error(`${label} must be ${bytes} bytes, not ${decoded.length}`);
  return decoded;
}

function decodePublicKey(value: unknown, label: string): Buffer {
  const decoded = decodeFixed(value, PUBLIC_KEY_BYTES, label);
  if (decoded[0] !== 0x04) throw new Error(`${label} must be an uncompressed P-256 point (0x04 first)`);
  return decoded;
}

function newKeyPair(): ECDH {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return ecdh;
}

/** An ECDH instance for a raw private scalar, which also derives the matching public point. */
function keyPairFor(privateKey: Buffer, label: string): ECDH {
  const ecdh = createECDH(CURVE);
  try {
    ecdh.setPrivateKey(privateKey);
  } catch {
    throw new Error(`${label} is not a valid P-256 private key`);
  }
  return ecdh;
}

/** Node drops a private scalar's leading zero bytes (so roughly 1 key in 256 comes back short), but the raw form is always 32 bytes. */
function rawPrivateKey(ecdh: ECDH): Buffer {
  const scalar = ecdh.getPrivateKey();
  return scalar.length === PRIVATE_KEY_BYTES ? scalar : Buffer.concat([Buffer.alloc(PRIVATE_KEY_BYTES - scalar.length), scalar]);
}

function sharedSecret(ecdh: ECDH, peerPublicKey: Buffer, label: string): Buffer {
  try {
    return ecdh.computeSecret(peerPublicKey);
  } catch {
    throw new Error(`${label} is not a point on the P-256 curve`);
  }
}

/** Parses an endpoint, which must be http or https (http is only ever allowed for local test services). */
function parseEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Push endpoint must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Push endpoint must be an http or https URL');
  return url;
}

/** A new VAPID key pair. Generate it once, keep the private key on the server and give the public key to the client. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = newKeyPair();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: rawPrivateKey(ecdh).toString('base64url') };
}

function assertSubject(subject: unknown): void {
  const valid =
    typeof subject === 'string' &&
    (/^mailto:[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(subject) || (/^https:\/\/\S+$/.test(subject) && URL.canParse(subject)));
  if (!valid) throw new Error('VAPID subject must be a mailto: address or an https: URL');
}

/** The Authorization header for a push request to this endpoint (RFC 8292), valid for ttlSeconds (at most 24 hours). */
export function vapidHeaders(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = DEFAULT_VAPID_TTL_SECONDS,
): { Authorization: string } {
  assertSubject(subject);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_VAPID_TTL_SECONDS) {
    throw new Error(`VAPID token lifetime must be a whole number of seconds from 1 to ${MAX_VAPID_TTL_SECONDS}`);
  }
  const publicKey = decodePublicKey(keys.publicKey, 'VAPID public key');
  const privateKey = decodeFixed(keys.privateKey, PRIVATE_KEY_BYTES, 'VAPID private key');
  // Node imports a JWK whose x and y belong to a different key without complaint, so the pair is checked here.
  if (!keyPairFor(privateKey, 'VAPID private key').getPublicKey().equals(publicKey)) {
    throw new Error('VAPID public key does not belong to the private key');
  }
  const claims = { aud: parseEndpoint(endpoint).origin, exp: Math.floor(nowSeconds) + ttlSeconds, sub: subject };
  const signingInput = `${JWT_HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33).toString('base64url'),
      d: privateKey.toString('base64url'),
    },
    format: 'jwk',
  });
  // JOSE wants the raw r || s signature (64 bytes), not the DER encoding Node produces by default.
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return { Authorization: `vapid t=${signingInput}.${signature.toString('base64url')}, k=${publicKey.toString('base64url')}` };
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * The RFC 8291 key schedule. The auth secret and both public keys fold into the ECDH secret first, then the salt
 * yields the content encryption key and nonce. With one record, the nonce is used as derived (NONCE XOR 0).
 */
function contentKeys(ecdhSecret: Buffer, authSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer): { cek: Buffer; nonce: Buffer } {
  const ikm = hkdf(ecdhSecret, authSecret, Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]), 32);
  return { cek: hkdf(ikm, salt, CEK_INFO, 16), nonce: hkdf(ikm, salt, NONCE_INFO, 12) };
}

function recordHeader(salt: Buffer, recordSize: number, keyId: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, SALT_BYTES);
  header.writeUInt8(keyId.length, SALT_BYTES + 4);
  keyId.copy(header, SALT_BYTES + 5);
  return header;
}

/**
 * Encrypts one push message for a subscription as a single aes128gcm record:
 * salt(16) || rs(4) || idlen(1) || keyid(65) || AES-128-GCM(plaintext || 0x02) || tag(16).
 */
export function encryptPayload(plaintext: Uint8Array | string, subscription: WebPushKeys, options: EncryptOptions = {}): Buffer<ArrayBuffer> {
  const payload = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const recordSize = options.recordSize ?? DEFAULT_RECORD_SIZE;
  if (!Number.isInteger(recordSize) || recordSize < MIN_RECORD_SIZE || recordSize > MAX_RECORD_SIZE) {
    throw new Error(`Record size must be a whole number from ${MIN_RECORD_SIZE} to ${MAX_RECORD_SIZE}`);
  }
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Push payload of ${payload.length} bytes is too large; the limit is ${MAX_PAYLOAD_BYTES} bytes`);
  }
  if (payload.length + 1 + TAG_BYTES > recordSize) {
    throw new Error(`Push payload of ${payload.length} bytes does not fit in one ${recordSize}-byte record`);
  }
  const uaPublic = decodePublicKey(subscription.p256dh, 'Subscription p256dh key');
  const authSecret = decodeFixed(subscription.auth, AUTH_SECRET_BYTES, 'Subscription auth secret');
  const salt = options.salt === undefined ? randomBytes(SALT_BYTES) : Buffer.from(options.salt);
  if (salt.length !== SALT_BYTES) throw new Error(`Salt must be ${SALT_BYTES} bytes, not ${salt.length}`);
  const local =
    options.localPrivateKey === undefined
      ? newKeyPair()
      : keyPairFor(decodeFixed(options.localPrivateKey, PRIVATE_KEY_BYTES, 'Local private key'), 'Local private key');
  const asPublic = local.getPublicKey();
  const { cek, nonce } = contentKeys(sharedSecret(local, uaPublic, 'Subscription p256dh key'), authSecret, uaPublic, asPublic, salt);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.update(Buffer.of(LAST_RECORD_DELIMITER)), cipher.final()]);
  return Buffer.concat([recordHeader(salt, recordSize, asPublic), ciphertext, cipher.getAuthTag()]);
}

/** A record's plaintext ends with its delimiter, then zero or more zero bytes of padding. */
function withoutPadding(padded: Buffer): Buffer {
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (end === 0 || padded[end - 1] !== LAST_RECORD_DELIMITER) throw new Error('Push message does not end with a last-record delimiter');
  return padded.subarray(0, end - 1);
}

/**
 * The browser's half of encryptPayload: reads the header, derives the same keys from the receiver's private key,
 * authenticates and decrypts the single record, and strips the delimiter and any padding. Throws if anything is off.
 */
export function decryptPayload(body: Uint8Array, receiver: WebPushReceiver): Buffer {
  const data = Buffer.from(body);
  if (data.length < HEADER_BYTES + 1 + TAG_BYTES) throw new Error('Push message is too short');
  const salt = data.subarray(0, SALT_BYTES);
  const recordSize = data.readUInt32BE(SALT_BYTES);
  const keyIdLength = data.readUInt8(SALT_BYTES + 4);
  const asPublic = data.subarray(SALT_BYTES + 5, SALT_BYTES + 5 + keyIdLength);
  if (keyIdLength !== PUBLIC_KEY_BYTES || asPublic[0] !== 0x04) throw new Error('Push message key id must be an uncompressed P-256 public key');
  const record = data.subarray(HEADER_BYTES);
  if (recordSize < MIN_RECORD_SIZE || record.length > recordSize) throw new Error('Push message must be a single aes128gcm record');
  const uaPublic = decodePublicKey(receiver.publicKey, 'Receiver public key');
  const authSecret = decodeFixed(receiver.auth, AUTH_SECRET_BYTES, 'Receiver auth secret');
  const local = keyPairFor(decodeFixed(receiver.privateKey, PRIVATE_KEY_BYTES, 'Receiver private key'), 'Receiver private key');
  if (!local.getPublicKey().equals(uaPublic)) throw new Error('Receiver public key does not belong to the private key');
  const { cek, nonce } = contentKeys(sharedSecret(local, asPublic, 'Push message key id'), authSecret, uaPublic, asPublic, salt);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(record.subarray(record.length - TAG_BYTES));
  let padded: Buffer;
  try {
    padded = Buffer.concat([decipher.update(record.subarray(0, record.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error('Push message failed authentication: the keys are wrong or the body was altered');
  }
  return withoutPadding(padded);
}

/** Everything needed to POST one encrypted, VAPID-signed message to a subscription's push service. */
export function buildPushRequest(subscription: WebPushSubscription, payload: string, options: PushMessageOptions): PushRequest {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_MESSAGE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) throw new Error('Push TTL must be a whole number of seconds, 0 or more');
  const urgency = options.urgency ?? 'normal';
  if (!URGENCIES.includes(urgency)) throw new Error(`Push urgency must be one of: ${URGENCIES.join(', ')}`);
  if (options.topic !== undefined && !TOPIC.test(options.topic)) throw new Error('Push topic must be 1 to 32 base64url characters');
  const url = parseEndpoint(subscription.endpoint).href;
  const headers: Record<string, string> = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttlSeconds),
    Urgency: urgency,
    ...(options.topic === undefined ? {} : { Topic: options.topic }),
    ...vapidHeaders(url, options.vapid, options.subject),
  };
  return { url, method: 'POST', headers, body: encryptPayload(payload, subscription.keys) };
}

/**
 * Whether an endpoint is safe to POST to: https on a known push service (default port, no credentials in the URL),
 * or an exact host:port listed in extraHosts, over http or https. Checking it when a subscription is saved as well
 * keeps endpoints that point anywhere else out of storage.
 */
export function isAllowedPushEndpoint(endpoint: string, extraHosts: string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const { protocol, host, hostname, port } = url;
  if ((protocol === 'https:' || protocol === 'http:') && extraHosts.some((extra) => extra.toLowerCase() === host)) return true;
  if (protocol !== 'https:' || port !== '') return false;
  return PUSH_SERVICE_HOSTS.includes(hostname) || PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => hostname.length > suffix.length && hostname.endsWith(suffix));
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || 'an endpoint with no host';
  } catch {
    return 'an endpoint that is not a URL';
  }
}

/** Retry-After holds either whole seconds or an HTTP date. */
function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\s*\d+\s*$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** fetch reports most network failures as "fetch failed", with the useful part (ECONNREFUSED, say) in the cause. */
function describeFailure(error: unknown): string {
  const { message, cause } = (error ?? {}) as { message?: unknown; cause?: { code?: unknown; message?: unknown } | null };
  const text = typeof message === 'string' ? message : String(error);
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : '';
  return detail ? `${text} (${detail})` : text;
}

/** Releases the connection without reading a body nobody needs. */
async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function resultOf(res: Response): Promise<PushResult> {
  const { status } = res;
  if (status >= 200 && status < 300) {
    await discardBody(res);
    return { ok: true, status };
  }
  if (status === 404 || status === 410) {
    await discardBody(res);
    return { ok: false, status, retryable: false, gone: true };
  }
  if (status === 429 || status >= 500) {
    await discardBody(res);
    const wait = retryAfterSeconds(res.headers.get('retry-after'));
    return wait === undefined ? { ok: false, status, retryable: true } : { ok: false, status, retryable: true, retryAfterSeconds: wait };
  }
  // A rejection's body often says what was wrong (with the VAPID token, say), which is worth keeping for the log.
  const detail = (await res.text().catch(() => '')).trim().slice(0, 200);
  return { ok: false, status, retryable: false, error: detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}` };
}

/**
 * Encrypts, signs and POSTs one message. Inputs that can never succeed throw before any request is made: an endpoint
 * that is not an allowed push service, malformed keys, an oversized payload, or a bad subject, TTL, urgency or topic.
 * Every response, network failure and timeout comes back as a PushResult instead.
 */
export async function sendPush(subscription: WebPushSubscription, payload: string, options: SendPushOptions): Promise<PushResult> {
  if (!isAllowedPushEndpoint(subscription.endpoint, options.allowHosts)) {
    throw new Error(`Refusing to send a push to ${hostOf(subscription.endpoint)}: it is not a known push service`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Push timeout must be a positive number of milliseconds');
  const request = buildPushRequest(subscription, payload, options);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    // A redirect comes back as a rejection instead of being followed, so a message never leaves the allowed host.
    const res = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'manual', signal: controller.signal });
    return await resultOf(res);
  } catch (e) {
    return { ok: false, status: 0, retryable: true, error: controller.signal.aborted ? `Timed out after ${timeoutMs}ms` : `Network error: ${describeFailure(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
