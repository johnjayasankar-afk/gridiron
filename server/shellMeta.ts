/**
 * What a shared link says about itself.
 *
 * Every page of this deployment served one title, one description and one
 * picture, so a link to a specific game — the most shareable thing in the
 * product — unfurled as "Gridiron · Every game. Every drive. One view." with the
 * generic field artwork, whichever game it was. A crawler never runs the client,
 * so the client's own `document.title` cannot help it: the shell has to carry
 * the answer before it is sent.
 *
 * The same rule as everywhere else applies. A game with no reported score says
 * the two teams and nothing more, a clock nobody reported is absent rather than
 * zero, and nothing here describes a state the provider did not report.
 */
import { kickoffLabel, scoreText, statusShort } from '../shared/format.js';
import { isOver, type GameSummary } from '../shared/model.js';

export interface ShellMeta {
  title: string;
  description: string;
  /** Absolute, when an origin is known; a crawler cannot resolve a relative one. */
  url?: string;
}

/** The two routes worth describing. Everything else keeps the shell's own words. */
export function shellRoute(pathname: string): { kind: 'game' | 'team'; id: string } | null {
  const game = /^\/game\/([^/]+)\/?$/.exec(pathname);
  if (game) return { kind: 'game', id: decodeURIComponent(game[1]) };
  const team = /^\/team\/([^/]+)\/?$/.exec(pathname);
  if (team) return { kind: 'team', id: decodeURIComponent(team[1]) };
  return null;
}

/** Collapses whitespace and trims to a length unfurlers will actually show. */
function tidy(parts: Array<string | null | undefined>, limit = 200): string {
  const s = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
}

export function gameMeta(game: GameSummary): ShellMeta {
  const teams = `${game.away.displayName} at ${game.home.displayName}`;
  const status = statusShort(game.status);
  const scored = game.score.away !== null && game.score.home !== null;
  // The headline is the score where there is one, and the fixture where there is not.
  const title = scored ? `${scoreText(game)} · ${status} · Gridiron` : `${game.away.abbreviation} at ${game.home.abbreviation} · ${status} · Gridiron`;

  const where = game.venue?.name ? `at ${game.venue.name}` : null;
  const when = game.status.kind === 'scheduled' ? `Kickoff ${kickoffLabel(game.startTime)}.` : null;
  const now = scored ? `${scoreText(game)}, ${status}.` : `${status}.`;
  const coverage = game.coverage.level === 'score-only' ? 'The provider reports the score only for this game: no play-by-play, drives or win probability.' : 'A 3D field with the reported ball spot, beside the score, win probability and odds from named sources.';
  const closing = isOver(game.status.kind) ? 'Drive replay, game flow and play-by-play, as reported.' : null;

  return { title, description: tidy([teams, where ? `${where}.` : null, when, when ? null : now, coverage, closing]) };
}

export function teamMeta(team: { displayName: string; abbreviation: string; record?: string | null }): ShellMeta {
  return {
    title: `${team.displayName} · Gridiron`,
    description: tidy([`${team.displayName}${team.record ? ` (${team.record})` : ''} on Gridiron:`, 'their schedule and results, each game with a 3D field of the reported ball spot, win probability and odds from named sources.']),
  };
}

/** Escapes a value for an HTML attribute. */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Replaces the shell's title and description with this page's, in the three
 * places that matter: the document title, the plain description and the Open
 * Graph and Twitter pair. Anything the shell has that is not named here, the
 * picture and the site name among them, is left alone.
 */
export function injectShellMeta(html: string, meta: ShellMeta): string {
  const title = attr(meta.title);
  const description = attr(meta.description);
  let out = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);

  const setMeta = (key: string, value: string) => {
    const re = new RegExp(`(<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*"${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"[^>]*\\bcontent\\s*=\\s*")[^"]*(")`, 'i');
    if (re.test(out)) out = out.replace(re, `$1${value}$2`);
  };
  setMeta('description', description);
  setMeta('og:title', title);
  setMeta('og:description', description);
  setMeta('twitter:title', title);
  setMeta('twitter:description', description);
  if (meta.url) setMeta('og:url', attr(meta.url));
  return out;
}
