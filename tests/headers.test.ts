/**
 * The response headers a browser is handed.
 *
 * The Content Security Policy is written down twice, once for the Node server
 * and once for Vercel, because the two serve the page by completely different
 * paths and neither can read the other's configuration. Two copies of a security
 * header is a thing that drifts: somebody relaxes one to unblock something and
 * the other deployment quietly keeps a policy the app no longer satisfies, or
 * worse, keeps a weaker one nobody reviewed. This holds them together.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../server/respond';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(new URL(rel, new URL(`file://${root}`)), 'utf8');

/** The policy the Node server puts on an HTML response. */
function nodePolicy(): string[] {
  const body = /const CSP = \[([\s\S]*?)\]\.join/.exec(read('server/http.ts'));
  if (!body) throw new Error('server/http.ts no longer declares CSP as an array this test can read');
  return [...body[1].matchAll(/["`]([^"`]+)["`]/g)]
    .map((m) => m[1].replace('${FRAME_ANCESTORS}', frameAncestors()))
    .sort();
}

/** The allowlist shared/embed.ts defines, which the CSP interpolates. */
function frameAncestors(): string {
  const src = read('shared/embed.ts');
  const parents = [...src.matchAll(/^\s+'(https:\/\/[^']+)',$/gm)].map((m) => m[1]);
  if (!parents.length) throw new Error('shared/embed.ts no longer lists EMBED_PARENTS');
  return ["'self'", ...parents].join(' ');
}

/** The policy Vercel puts on every response. */
function vercelPolicy(): string[] {
  const config = JSON.parse(read('vercel.json')) as { headers: Array<{ headers: Array<{ key: string; value: string }> }> };
  const header = config.headers.flatMap((g) => g.headers).find((h) => h.key.toLowerCase() === 'content-security-policy');
  if (!header) throw new Error('vercel.json no longer sets a Content-Security-Policy');
  return header.value
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .sort();
}

describe('the content security policy', () => {
  it('is the same on the Node server and on Vercel', () => {
    expect(nodePolicy()).toEqual(vercelPolicy());
  });

  it('keeps the directives that actually matter, whichever way the page is served', () => {
    for (const policy of [nodePolicy(), vercelPolicy()]) {
      const by = (name: string) => policy.find((d) => d.startsWith(`${name} `) || d === name);
      // Scripts are same-origin only: the built page has no inline script, so there is no reason to allow one.
      expect(by('script-src')).toBe("script-src 'self'");
      expect(by('default-src')).toBe("default-src 'self'");
      expect(by('object-src')).toBe("object-src 'none'");
      expect(by('base-uri')).toBe("base-uri 'none'");
      // Not 'none': the portfolio frames this product in its case study, and a
      // blocked frame renders as a black box under a caption promising a live
      // app. See tests/csp.test.ts and shared/embed.ts.
      expect(by('frame-ancestors')).toContain('https://johnjayasankar.com');
      // Every network call the client makes is same-origin; only team images come from the provider.
      expect(by('connect-src')).toBe("connect-src 'self'");
      expect(by('img-src')).toContain('https://a.espncdn.com');
      // Nothing may quietly become unsafe.
      expect(policy.join('; ')).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(policy.join('; ')).not.toContain('unsafe-eval');
    }
  });
});

describe('the other security headers', () => {
  it('are on every response the server writes', () => {
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(SECURITY_HEADERS['cross-origin-opener-policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['permissions-policy']).toContain('geolocation=()');
  });

  it('are matched by Vercel, which serves the same app by another path', () => {
    const config = JSON.parse(read('vercel.json')) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
    const all = config.headers.flatMap((g) => g.headers);
    const has = (key: string) => all.some((h) => h.key.toLowerCase() === key);
    for (const key of ['x-content-type-options', 'referrer-policy', 'permissions-policy', 'strict-transport-security']) {
      expect(has(key), key).toBe(true);
    }
  });
});
