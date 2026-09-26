/**
 * What a shared link says about itself, from the server that will serve it.
 *
 * A crawler never runs the client, so the answer has to be in the HTML. These
 * ask for the document the way an unfurler does: a plain GET, no JavaScript.
 */
import { expect, test } from '@playwright/test';

const meta = (html: string, key: string): string | null => {
  const re = new RegExp(`<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*"${key}"[^>]*\\bcontent\\s*=\\s*"([^"]*)"`, 'i');
  return re.exec(html)?.[1] ?? null;
};
const title = (html: string): string | null => /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;

test.describe('a shared link', () => {
  test('a game page carries that game in its title and description', async ({ request, baseURL }) => {
    // The engine polls on its own clock, so the first request can arrive before it has anything.
    const allGames = async () => {
      const slate = await (await request.get('/api/slate')).json();
      return (slate.games ?? []) as Array<{ id: string; away: { abbreviation: string; displayName: string }; home: { abbreviation: string; displayName: string } }>;
    };
    await expect.poll(async () => (await allGames()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const game = (await allGames())[0];

    const html = await (await request.get(`/game/${game.id}`)).text();
    const shown = title(html)!;
    expect(shown, 'the game page kept the shell title').not.toBe('Gridiron · Every game. Every drive. One view.');
    expect(shown).toContain(game.away.abbreviation);
    expect(shown).toContain(game.home.abbreviation);
    expect(shown).toContain('Gridiron');

    // The same words reach the unfurlers, which read og and twitter rather than the title.
    expect(meta(html, 'og:title')).toBe(shown);
    expect(meta(html, 'twitter:title')).toBe(shown);
    const description = meta(html, 'og:description')!;
    expect(description).toContain(game.away.displayName);
    expect(description).toContain(game.home.displayName);
    expect(meta(html, 'description')).toBe(description);
    // The picture is the shell's, and stays the shell's.
    expect(meta(html, 'og:image')).toBeTruthy();
    void baseURL;
  });

  test('a game nobody has polled keeps the shell, rather than inventing one', async ({ request }) => {
    const html = await (await request.get('/game/nfl-999999999')).text();
    expect(title(html)).toBe('Gridiron · Every game. Every drive. One view.');
  });

  test('the slate and the other views keep the shell they always had', async ({ request }) => {
    for (const path of ['/', '/tape', '/wall', '/focus']) {
      const html = await (await request.get(path)).text();
      expect(title(html), path).toBe('Gridiron · Every game. Every drive. One view.');
    }
  });
});
