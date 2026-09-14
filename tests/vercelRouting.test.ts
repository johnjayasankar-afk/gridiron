/**
 * Vercel sends every /api/... request to the one function in api/index.ts through a rewrite that
 * carries the original path. Without it, only single-segment paths reached the function, and game
 * detail and team pages got Vercel's own 404.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { originalApiUrl } from '../server/vercelRouting';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('Vercel routing', () => {
  it('restores the original API path the rewrite carried, keeping the request query', () => {
    expect(originalApiUrl('/api?__path=game/nfl-401872926')).toBe('/api/game/nfl-401872926');
    expect(originalApiUrl('/api?__path=slate&date=20260913')).toBe('/api/slate?date=20260913');
    expect(originalApiUrl('/api?date=20260913&__path=slate')).toBe('/api/slate?date=20260913');
    expect(originalApiUrl('/api?__path=game%2Fnfl-401872926')).toBe('/api/game/nfl-401872926');
    expect(originalApiUrl('/api/team/nfl-12?__path=team/nfl-12')).toBe('/api/team/nfl-12');
  });

  it('leaves a request without a carried path alone, and never guesses at an odd one', () => {
    expect(originalApiUrl('/api/health')).toBe('/api/health');
    expect(originalApiUrl(undefined)).toBe('/');
    expect(originalApiUrl('/api?__path=<script>')).toBe('/api/not-found');
  });

  it('rewrites every /api path to the one function and everything else to the app', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as { rewrites: Array<{ source: string; destination: string }>; functions: Record<string, unknown> };
    expect(config.rewrites[0]).toEqual({ source: '/api/:path*', destination: '/api?__path=:path*' });
    expect(config.rewrites[1]).toEqual({ source: '/((?!api/).*)', destination: '/index.html' });
    for (const file of Object.keys(config.functions)) expect(existsSync(join(ROOT, file))).toBe(true);
    expect(readdirSync(join(ROOT, 'api'))).toEqual(['index.ts']);
  });
});
