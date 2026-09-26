/**
 * Two deployments, two copies of the Content Security Policy: the Node server
 * builds one in server/http.ts, Vercel serves one from vercel.json. They are the
 * same policy and nothing keeps them that way, so a host added to one and not
 * the other is silently blocked on whichever deployment was forgotten.
 *
 * And a new image host is the same failure one step earlier: the code fetches
 * it, `img-src` does not name it, and the picture never appears in production
 * while looking fine in development, where the policy is the same but the host
 * is usually already allowed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${ROOT}${p}`, 'utf8');

/** The policy the Node server sends, read out of its own source. */
function nodeCsp(): string {
  const src = read('server/http.ts');
  const block = /const CSP = \[([\s\S]*?)\]\.join\('; '\);/.exec(src);
  if (!block) throw new Error('server/http.ts no longer builds CSP from an array');
  const quoted = [...block[1].matchAll(/["`]([^"`]+)["`]/g)].map((m) => m[1]);
  return quoted.map((d) => d.replace('${FRAME_ANCESTORS}', frameAncestors())).join('; ');
}
/**
 * The array entries, with `${FRAME_ANCESTORS}` resolved from shared/embed.ts.
 * The allowlist lives there because the Node server, vercel.json and the
 * embedding page all have to agree on it; resolving it here means this test
 * still reads the real policy rather than a template.
 */
function frameAncestors(): string {
  const src = readFileSync(`${ROOT}shared/embed.ts`, 'utf8');
  const parents = [...src.matchAll(/^\s+'(https:\/\/[^']+)',$/gm)].map((m) => m[1]);
  if (!parents.length) throw new Error('shared/embed.ts no longer lists EMBED_PARENTS');
  return ["'self'", ...parents].join(' ');
}


/** The policy Vercel sends, read out of vercel.json. */
function vercelCsp(): string {
  const config = JSON.parse(read('vercel.json')) as { headers: Array<{ headers: Array<{ key: string; value: string }> }> };
  for (const rule of config.headers) {
    const found = rule.headers.find((h) => h.key.toLowerCase() === 'content-security-policy');
    if (found) return found.value;
  }
  throw new Error('vercel.json sends no Content-Security-Policy');
}

const directive = (csp: string, name: string): string[] => {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  return found ? found.split(/\s+/).slice(1) : [];
};

describe('the two policies', () => {
  it('say exactly the same thing', () => {
    expect(vercelCsp()).toBe(nodeCsp());
  });

  it('still hold the directives worth having', () => {
    const csp = nodeCsp();
    for (const name of ['default-src', 'script-src', 'img-src', 'connect-src', 'object-src', 'base-uri', 'frame-ancestors', 'form-action']) {
      expect(directive(csp, name).length, name).toBeGreaterThan(0);
    }
    expect(directive(csp, 'script-src')).toEqual(["'self'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
  });

  /*
   * This one is not hardening in the usual direction, and it is here so that a
   * pass that tightens the policy has to read this comment before loosening it
   * back. johnjayasankar.com shows a live preview of this product inside its
   * case study. If frame-ancestors goes back to 'none', that preview renders as
   * an empty black rectangle under a caption reading "the working app, not a
   * mock", which is exactly the kind of claim this repository refuses to make.
   * It has happened once already, on a sibling product, and nothing caught it.
   */
  it('lets the portfolio frame the product, which is the whole point of the preview', () => {
    for (const csp of [nodeCsp(), vercelCsp()]) {
      const fa = directive(csp, 'frame-ancestors');
      expect(fa).toContain("'self'");
      expect(fa).toContain('https://johnjayasankar.com');
      expect(fa).not.toContain("'none'");
    }
  });

  it('sends no X-Frame-Options, which would override frame-ancestors where it is not read', () => {
    const config = JSON.parse(read('vercel.json')) as { headers: Array<{ headers: Array<{ key: string }> }> };
    const keys = config.headers.flatMap((g) => g.headers).map((h) => h.key.toLowerCase());
    expect(keys).not.toContain('x-frame-options');
  });
});

describe('every image host the browser is asked to load', () => {
  /*
   * The client only ever loads a picture from a host these three name: the
   * regex the normalizer filters provider images through, the resizer the
   * headshots go via, and the one the team marks are asked for at their drawn
   * size. Anything else the provider hands out is dropped rather than fetched.
   */
  const HOST = /https:\\?\/\\?\/([a-z0-9.-]+\.[a-z]{2,})/gi;
  const hostsIn = (text: string) => [...text.matchAll(HOST)].map((m) => m[1].replace(/\\/g, ''));

  it('is named in img-src', () => {
    const allowed = directive(nodeCsp(), 'img-src');
    const hosts = new Set<string>();

    /*
     * The filter every provider image passes through. Read as one line, because
     * the same file names the API hosts the server fetches from, and those are
     * not loaded by a browser and have no business in img-src.
     */
    const filter = /const PROVIDER_IMAGE = ([^;]+);/.exec(read('server/providers/espn/normalize.ts'));
    expect(filter, 'PROVIDER_IMAGE has moved or been renamed').toBeTruthy();
    hostsIn(filter![1]).forEach((h) => hosts.add(h));

    // The browser-side files that build an image URL of their own.
    for (const file of ['shared/logo.ts', 'src/views/detail/parts.tsx']) hostsIn(read(file)).forEach((h) => hosts.add(h));

    expect(hosts.size, 'no image host was found at all; has one of these moved?').toBeGreaterThan(0);
    const missing = [...hosts].filter((h) => !allowed.includes(`https://${h}`));
    expect(missing, `image hosts in the code that img-src does not allow: ${missing.join(', ')}`).toEqual([]);
  });
});
