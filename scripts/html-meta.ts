/**
 * Absolute URLs in the shell's social metadata.
 *
 * The Open Graph protocol requires `og:image` and `og:url` to be absolute, and
 * Facebook, LinkedIn, Slack and iMessage do not resolve a relative one: the
 * deployed build shipped `content="/og.png"` and every shared link previewed
 * without a picture. The origin comes from one place, so a build for another
 * host is one environment variable rather than an edit to the shell.
 *
 * It rewrites, rather than requiring absolute URLs in index.html, so the file
 * stays readable and the dev server keeps serving its own origin.
 */

/** Metadata whose content must be a URL. Everything else is left alone. */
const URL_META = new Set(['og:image', 'og:image:secure_url', 'og:url', 'twitter:image', 'twitter:url']);

/** Strips trailing slashes so joining never doubles one. */
export function normalizeOrigin(origin: string | undefined): string {
  return String(origin || '').replace(/\/+$/, '');
}

/** One `<meta>` tag's name, whichever attribute carries it. */
function metaKey(tag: string): string | null {
  const m = /\b(?:property|name)\s*=\s*"([^"]+)"/i.exec(tag);
  return m ? m[1] : null;
}

/**
 * Rewrites root-relative URLs in social metadata to absolute ones, and adds
 * `og:url` when the shell has none. Anything already absolute is untouched.
 */
export function absoluteMeta(html: string, origin: string | undefined): string {
  const base = normalizeOrigin(origin);
  if (!base) return html;

  let out = html.replace(/<meta\b[^>]*>/gi, (tag: string) => {
    const key = metaKey(tag);
    if (!key || !URL_META.has(key)) return tag;
    return tag.replace(/\bcontent\s*=\s*"(\/[^"]*)"/i, (_m: string, path: string) => `content="${base}${path}"`);
  });

  if (!/\b(?:property|name)\s*=\s*"og:url"/i.test(out)) {
    // Beside og:image, which every shell that has one also has.
    out = out.replace(/([ \t]*)<meta\s+property="og:image"/i, (_line: string, indent: string) => `${indent}<meta property="og:url" content="${base}/" />\n${indent}<meta property="og:image"`);
  }
  return out;
}

/** The Vite plugin. `origin` empty leaves the shell exactly as written, which is what the dev server wants. */
export function absoluteMetaPlugin(origin: string | undefined) {
  return {
    name: 'gridiron-absolute-meta',
    transformIndexHtml: {
      order: 'post',
      handler: (html: string) => absoluteMeta(html, origin),
    },
  };
}
