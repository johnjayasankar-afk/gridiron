/**
 * Response helpers shared by every HTTP route: JSON with security headers,
 * bounded request bodies, the client address and a same-origin check.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'fullscreen=(self), geolocation=(), microphone=(), camera=()',
  'cross-origin-opener-policy': 'same-origin',
};

/** JSON bodies at least this large are gzipped for clients that accept it. */
export const COMPRESS_MIN_BYTES = 1400;

/** A route outside the engine API: it answers and resolves true, or resolves false to pass the request on. */
export type ApiRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

const acceptEncoding = new WeakMap<ServerResponse, string>();

/** Remember what the request accepts, so `send` can compress a larger body. */
export function noteAcceptEncoding(req: IncomingMessage, res: ServerResponse) {
  acceptEncoding.set(res, String(req.headers['accept-encoding'] ?? ''));
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  const head: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers };
  if (Buffer.byteLength(json) < COMPRESS_MIN_BYTES) {
    res.writeHead(status, head);
    res.end(json);
    return;
  }
  head.vary = 'accept-encoding';
  if (!/\bgzip\b/.test(acceptEncoding.get(res) ?? '')) {
    res.writeHead(status, head);
    res.end(json);
    return;
  }
  gzip(json, { level: 6 }, (error, compressed) => {
    if (res.headersSent || res.writableEnded) return;
    if (error) res.writeHead(status, head).end(json);
    else res.writeHead(status, { ...head, 'content-encoding': 'gzip' }).end(compressed);
  });
}

/** Reads a JSON body of at most `limit` bytes. Throws on an oversized or malformed body. */
export async function readBody(req: IncomingMessage, limit = 16_384): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The address to rate-limit by. Behind a reverse proxy that sets
 * x-forwarded-for, pass `trustProxy` so every visitor is not counted as the proxy.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')[0]
      ?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * State-changing requests must come from this site. Browsers send Origin on
 * cross-site POSTs; a request without one (curl, a test) is allowed. The host a
 * development proxy forwards from counts as this site.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [req.headers.host, req.headers['x-forwarded-host']].flatMap((h) => String(h ?? '').split(',')).map((h) => h.trim()).filter(Boolean);
  return hosts.includes(host);
}
