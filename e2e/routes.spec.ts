/**
 * Every route, opened straight from its own address with the chunks already
 * cached, which is what a typed link, a bookmark or a reopened tab does.
 *
 * This is the load order nothing tested, and a crash shipped in it: the game
 * page derived a value in a hook below its early returns, so the render that
 * arrived before the summary skipped the hook and the next one called it, and
 * React brought the whole view down. Every journey in this suite reached a game
 * by clicking the slate, where the chunk loads slowly enough that the data wins
 * the race, so every one of them passed.
 *
 * Each route is warmed once and then navigated to directly, and the page has to
 * come up with no crash, nothing logged to the console and its own content on
 * screen. `tests/hookOrder.test.ts` holds the same class statically; this holds
 * it where it actually happens.
 */
import { expect, test, type Page } from '@playwright/test';
import { openReplay } from './helpers';

/** A route, the address it lives at, and something only that view draws. */
const ROUTES = [
  { name: 'the slate', path: '/', shows: '.section-live .card, .state-block', title: /Gridiron/ },
  { name: 'focus', path: '/focus', shows: '.focus-slot, .state-block', title: /^Focus · Gridiron$/ },
  { name: 'the wall', path: '/wall', shows: '.wall-grid, .state-block', title: /^Wall · Gridiron$/ },
  { name: 'the tape', path: '/tape', shows: '.tape-lane, .state-block', title: /^Tape · Gridiron$/ },
  { name: 'a game', path: '/game/nfl-401872925', shows: '.scoreboard', title: /· Gridiron$/ },
  { name: 'a team', path: '/team/nfl-2', shows: 'table, .state-block', title: /· Gridiron$/ },
  { name: 'an unknown address', path: '/no-such-page', shows: '.state-block', title: /^Page not found · Gridiron$/ },
] as const;

/** Console errors worth failing on. A provider request that 404s is the page's business, not a defect here. */
function watchConsole(page: Page): string[] {
  const noise: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource|net::ERR_|favicon/.test(text)) return;
    noise.push(text);
  });
  page.on('pageerror', (e) => noise.push(`uncaught: ${e.message}`));
  return noise;
}

test.describe('every address', () => {
  for (const route of ROUTES) {
    test(`${route.name} opens from its own address with the chunks warm`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const noise = watchConsole(page);

      // Once to put the route's chunk in the cache, then again cold on data.
      await openReplay(page, { path: route.path, scenario: 'nfl-week1-sunday', at: 0.6 });
      await expect(page.locator(route.shows).first()).toBeVisible({ timeout: 25_000 });

      await page.goto(`${route.path}?replay=nfl-week1-sunday&at=0.85&paused=1`);
      await expect(page.locator(route.shows).first()).toBeVisible({ timeout: 25_000 });
      await expect(page.locator('.view-error'), 'the view boundary replaced the page').toHaveCount(0);
      /*
       * And it names itself in the tab. The tape did not, so opening it from a
       * game left the tab reading that game's score while the tape was on screen.
       */
      await expect(page).toHaveTitle(route.title, { timeout: 15_000 });
      expect(noise, `${route.name} logged an error`).toEqual([]);
    });
  }
});
