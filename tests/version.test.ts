import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../shared/version';

describe('version', () => {
  it('matches package.json and names the service worker cache', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')).toContain(`const VERSION = 'gridiron-${VERSION}';`);
  });
});
