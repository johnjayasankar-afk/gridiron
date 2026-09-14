import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('../../fixtures/espn/', import.meta.url));

export function fixture<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8')) as T;
}

export function fixtureNames(dir: string): string[] {
  return readdirSync(join(FIXTURES, dir)).filter((f) => f.endsWith('.json'));
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fetch that answers ESPN URLs from captured fixtures. `fail` can make chosen
 * URLs return an error, to exercise partial outages.
 */
export function fixtureFetch(opts: { fail?: (url: string) => number | null; log?: string[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    opts.log?.push(url);
    const failStatus = opts.fail?.(url);
    if (failStatus) return new Response('provider error', { status: failStatus });
    const file = fixtureFileFor(url);
    if (!file || !existsSync(join(FIXTURES, file))) return new Response('not found', { status: 404 });
    return json(fixture(file));
  }) as typeof fetch;
}

export function fixtureFileFor(url: string): string | null {
  let m = /\/football\/nfl\/scoreboard\?dates=(\d{8})/.exec(url);
  if (m) return `scoreboard/nfl-${m[1]}.json`;
  m = /\/football\/college-football\/scoreboard\?dates=(\d{8})[^#]*?groups=(\d+)/.exec(url);
  if (m) return `scoreboard/cfb-${m[1]}-g${m[2]}.json`;
  m = /\/football\/college-football\/scoreboard\?dates=(\d{8})/.exec(url);
  if (m) return `scoreboard/cfb-${m[1]}-g80.json`; // the default college scoreboard is the FBS list
  m = /\/(nfl|college-football)\/summary\?event=(\d+)/.exec(url);
  if (m) return `summary/${m[1] === 'nfl' ? 'nfl' : 'cfb'}-${m[2]}.json`;
  if (/\/seasons\/2026\/types\/2\/groups\?/.test(url)) return 'core/groups-2026-2.json';
  m = /\/groups\/(\d+)\/children/.exec(url);
  if (m) return `core/group-${m[1]}-children.json`;
  m = /\/groups\/(\d+)(?:\?|$)/.exec(url);
  if (m) return `core/group-${m[1]}.json`;
  return null;
}
