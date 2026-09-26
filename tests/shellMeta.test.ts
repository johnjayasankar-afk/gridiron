/**
 * A shared link to a game used to unfurl as the site's own tagline and the
 * generic artwork, whichever game it was. A crawler never runs the client, so
 * the shell has to carry the answer before it is sent.
 *
 * Built from a real captured game, so the words are the provider's.
 */
import { describe, expect, it } from 'vitest';
import { normalizeScoreboardEvent } from '../server/providers/espn/normalize';
import { gameMeta, injectShellMeta, shellRoute, teamMeta } from '../server/shellMeta';
import type { GameSummary } from '../shared/model';
import { fixture } from './helpers/fixtures';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const denverAtKansasCity = (): GameSummary => normalizeScoreboardEvent(fixture<Raw>('odds/nfl-401872931-pregame-event.json'), 'nfl', ['NFL'])!;

const SHELL = `<!doctype html><html><head>
  <title>Gridiron · Every game. Every drive. One view.</title>
  <meta name="description" content="Gridiron is a live NFL and college football command center." />
  <meta property="og:title" content="Gridiron · Every game. Every drive. One view." />
  <meta property="og:description" content="A live command center." />
  <meta property="og:url" content="https://example.com/" />
  <meta property="og:image" content="https://example.com/og.png" />
  <meta name="twitter:title" content="Gridiron · Every game. Every drive. One view." />
  <meta name="twitter:description" content="A live command center." />
</head><body></body></html>`;

describe('which pages describe themselves', () => {
  it('knows a game and a team address, and nothing else', () => {
    expect(shellRoute('/game/nfl-401872931')).toEqual({ kind: 'game', id: 'nfl-401872931' });
    expect(shellRoute('/team/nfl-2/')).toEqual({ kind: 'team', id: 'nfl-2' });
    for (const other of ['/', '/tape', '/wall', '/focus', '/game/a/b', '/api/slate', '/assets/x.js']) {
      expect(shellRoute(other), other).toBeNull();
    }
  });
});

describe('what a shared game says', () => {
  it('names both teams and the state the provider reported', () => {
    const meta = gameMeta(denverAtKansasCity());
    expect(meta.title).toContain('Gridiron');
    expect(meta.description).toContain('Denver Broncos at Kansas City Chiefs');
    expect(meta.description).toContain('Kickoff');
  });

  it('gives the score the headline once there is one, and the fixture until then', () => {
    const scheduled = denverAtKansasCity();
    expect(gameMeta(scheduled).title).toMatch(/^DEN at KC · /);
    const live: GameSummary = { ...scheduled, status: { ...scheduled.status, kind: 'in_progress', period: 2, clock: '5:00' }, score: { away: 10, home: 17 } };
    expect(gameMeta(live).title).toBe('DEN 10, KC 17 · Q2 5:00 · Gridiron');
    expect(gameMeta(live).description).toContain('DEN 10, KC 17');
  });

  it('never invents a score for a game that has none', () => {
    const scheduled = denverAtKansasCity();
    expect(scheduled.score.away).toBeNull();
    const meta = gameMeta(scheduled);
    expect(meta.title).not.toMatch(/\b0\b/);
    expect(meta.description).not.toMatch(/\b0,|, 0\b/);
  });

  it('says so when the provider reports the score only', () => {
    const game = denverAtKansasCity();
    const scoreOnly: GameSummary = { ...game, coverage: { ...game.coverage, level: 'score-only' } };
    expect(gameMeta(scoreOnly).description).toContain('score only');
    expect(gameMeta(scoreOnly).description).not.toContain('3D field');
  });

  it('keeps a description short enough to be shown whole', () => {
    const game = denverAtKansasCity();
    for (const kind of ['scheduled', 'in_progress', 'final'] as const) {
      const meta = gameMeta({ ...game, status: { ...game.status, kind }, score: { away: 21, home: 24 } });
      expect(meta.description.length, `${kind}: ${meta.description.length}`).toBeLessThanOrEqual(200);
    }
  });
});

describe('what a shared team says', () => {
  it('names the team and its record where one is reported', () => {
    expect(teamMeta({ displayName: 'Kansas City Chiefs', abbreviation: 'KC', record: '1-0' }).title).toBe('Kansas City Chiefs · Gridiron');
    expect(teamMeta({ displayName: 'Kansas City Chiefs', abbreviation: 'KC', record: '1-0' }).description).toContain('(1-0)');
    expect(teamMeta({ displayName: 'Kansas City Chiefs', abbreviation: 'KC', record: null }).description).not.toContain('(');
  });
});

describe('putting it into the shell', () => {
  it('replaces the title and every description that mirrors it', () => {
    const out = injectShellMeta(SHELL, { title: 'DEN 10, KC 17 · Q2 5:00 · Gridiron', description: 'Denver Broncos at Kansas City Chiefs.', url: 'https://example.com/game/nfl-401872931' });
    expect(out).toContain('<title>DEN 10, KC 17 · Q2 5:00 · Gridiron</title>');
    expect(out).toContain('<meta property="og:title" content="DEN 10, KC 17 · Q2 5:00 · Gridiron" />');
    expect(out).toContain('<meta name="twitter:description" content="Denver Broncos at Kansas City Chiefs." />');
    expect(out).toContain('<meta property="og:url" content="https://example.com/game/nfl-401872931" />');
    // The picture and the site name are the shell's, and stay the shell's.
    expect(out).toContain('<meta property="og:image" content="https://example.com/og.png" />');
  });

  it('escapes anything that would break out of an attribute', () => {
    const out = injectShellMeta(SHELL, { title: 'A "quoted" <b>title</b> & more', description: 'x' });
    expect(out).toContain('&quot;quoted&quot;');
    expect(out).not.toContain('<b>title</b>');
  });

  it('leaves a shell that has none of those tags untouched', () => {
    expect(injectShellMeta('<html><body>hi</body></html>', { title: 'x', description: 'y' })).toBe('<html><body>hi</body></html>');
  });
});
