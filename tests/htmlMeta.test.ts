/**
 * Open Graph requires an absolute URL, and no major unfurler resolves a relative
 * one: Facebook, LinkedIn, Slack and iMessage all gave the deployed build a
 * preview with no picture, because the shell shipped `content="/og.png"`.
 *
 * The transform is tested directly, and the built shell is checked when one has
 * been built, so a build that loses the plugin fails here rather than in a paste
 * into Slack.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { absoluteMeta, normalizeOrigin } from '../scripts/html-meta';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHELL = `${ROOT}dist/index.html`;

/** Every meta whose content is a URL, as the built shell carries them. */
const urlMeta = (html: string): Array<{ key: string; value: string }> =>
  [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((m) => m[0])
    .map((tag) => ({ key: /\b(?:property|name)\s*=\s*"([^"]+)"/i.exec(tag)?.[1] ?? '', value: /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '' }))
    .filter((m) => /^(og:(image|image:secure_url|url)|twitter:(image|url))$/.test(m.key));

describe('the shell metadata', () => {
  it('makes a root-relative image absolute', () => {
    const out = absoluteMeta('<meta property="og:image" content="/og.png" />', 'https://example.com');
    expect(out).toContain('content="https://example.com/og.png"');
  });

  it('adds og:url, which the shell never had', () => {
    const out = absoluteMeta('<meta property="og:image" content="/og.png" />', 'https://example.com');
    expect(out).toContain('<meta property="og:url" content="https://example.com/" />');
  });

  it('leaves an absolute URL alone, and never doubles a slash', () => {
    const already = '<meta property="og:image" content="https://cdn.example.com/a.png" />';
    expect(absoluteMeta(already, 'https://example.com/')).toContain('https://cdn.example.com/a.png');
    expect(absoluteMeta('<meta property="og:image" content="/og.png" />', 'https://example.com///')).toContain('content="https://example.com/og.png"');
  });

  it('touches nothing but the metadata that holds a URL', () => {
    const html = '<meta name="description" content="/not-a-url" /><link rel="icon" href="/favicon.svg" /><meta property="og:title" content="/x" />';
    expect(absoluteMeta(html, 'https://example.com')).toContain('content="/not-a-url"');
    expect(absoluteMeta(html, 'https://example.com')).toContain('href="/favicon.svg"');
    expect(absoluteMeta(html, 'https://example.com')).toContain('<meta property="og:title" content="/x" />');
  });

  it('leaves the shell exactly as written when no origin is configured', () => {
    const html = '<meta property="og:image" content="/og.png" />';
    expect(absoluteMeta(html, '')).toBe(html);
    expect(absoluteMeta(html, undefined)).toBe(html);
    expect(normalizeOrigin(undefined)).toBe('');
  });

  it.runIf(existsSync(SHELL))('no URL in the built shell is relative', () => {
    const metas = urlMeta(readFileSync(SHELL, 'utf8'));
    expect(metas.length, 'the built shell has no social metadata at all').toBeGreaterThan(1);
    const relative = metas.filter((m) => m.value.startsWith('/'));
    expect(relative, `relative URLs in dist/index.html: ${relative.map((m) => `${m.key}=${m.value}`).join(', ')}`).toEqual([]);
    expect(metas.some((m) => m.key === 'og:url')).toBe(true);
  });
});
