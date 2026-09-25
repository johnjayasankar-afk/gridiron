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
import { openMenuItem, openReplay } from './helpers';

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

test('team logos are asked for at the size they are drawn', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { scenario: 'nfl-week1-sunday', at: 0.85 });
  await expect(page.locator('.section-live .card, .state-block').first()).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => page.locator('.logo-frame img').count(), { timeout: 20_000 }).toBeGreaterThan(4);
  await page.waitForTimeout(1500);

  const logos = await page.locator('.logo-frame img').evaluateAll((els) =>
    els.map((e) => {
      const img = e as HTMLImageElement;
      return { src: img.src, drawn: Math.round(img.getBoundingClientRect().width), natural: img.naturalWidth, broken: img.complete && img.naturalWidth === 0 };
    }),
  );
  expect(logos.length).toBeGreaterThan(4);

  /*
   * The provider serves every logo at 500 by 500, and a slate of thirteen games
   * drew them at twenty-two to thirty pixels: about a megabyte of pictures for
   * marks the size of a thumbnail. They are asked for at their drawn size now.
   */
  for (const logo of logos) {
    expect(logo.broken, `${logo.src} did not load`).toBe(false);
    expect(logo.src, 'a logo was asked for at whatever size the provider felt like').toContain('combiner/i?img=');
    const asked = Number(/[?&]w=(\d+)/.exec(logo.src)?.[1]);
    expect(asked, `${logo.src} has no size`).toBeGreaterThan(0);
    // Twice the drawn size covers a retina screen; four times is bytes nobody can see.
    expect(asked, `${logo.src} is ${asked}px for a ${logo.drawn}px mark`).toBeLessThanOrEqual(Math.max(64, logo.drawn * 4));
  }
  // And they are the provider's own addresses, rewritten rather than invented.
  for (const logo of logos) expect(logo.src).toMatch(/^https:\/\/a\.espncdn\.com\/combiner\/i\?img=\/i\/teamlogos\//);
});

test('the shared canvas is built where there is a field and nowhere else', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  /*
   * The tape is drawn in DOM and SVG and has no field at all, and it was still
   * building a WebGL context and pulling three.js for it: 191kB for something it
   * never draws. The canvas follows the field slots on the page now.
   */
  await openReplay(page, { path: '/tape', scenario: 'nfl-week1-sunday', at: 0.85 });
  await expect(page.locator('.tape, .state-block').first()).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('.field-slot')).toHaveCount(0);
  await page.waitForTimeout(1200);
  // Scoped to the field's own canvas: the atmosphere behind the page has one of its own, which is not this.
  await expect(page.locator('.field-canvas canvas'), 'the tape built a field canvas it has nothing to draw in').toHaveCount(0);

  // And the slate, which is thirteen fields, still gets one.
  await openReplay(page, { scenario: 'nfl-week1-sunday', at: 0.85 });
  await expect(page.locator('.section-live .card, .state-block').first()).toBeVisible({ timeout: 25_000 });
  await expect.poll(() => page.locator('.field-slot').count(), { timeout: 20_000 }).toBeGreaterThan(1);
  await expect(page.locator('.field-canvas canvas'), 'the slate has fields and no canvas to draw them in').toHaveCount(1);
  await expect.poll(async () => (await page.evaluate(() => window.__gridironGraphics?.info()))?.views ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
});

test('a canvas built after the page has laid out still draws', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  /*
   * The two ways the shared canvas is built into a page that is already on
   * screen rather than with it: walking to a field from the tape, which has
   * none, and turning effects from 2D back to Full. Both have to end with a
   * renderer that is actually drawing, not just a canvas element in the DOM.
   */
  await openReplay(page, { path: '/tape', scenario: 'nfl-week1-sunday', at: 0.85 });
  await expect(page.locator('.tape, .state-block').first()).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('.field-canvas canvas')).toHaveCount(0);
  await page.getByRole('link', { name: 'Gridiron' }).first().click();
  await expect.poll(() => page.locator('.field-slot').count(), { timeout: 25_000 }).toBeGreaterThan(1);
  await expect(page.locator('.field-canvas canvas')).toHaveCount(1, { timeout: 25_000 });
  await expect.poll(async () => (await page.evaluate(() => window.__gridironGraphics?.info()))?.views ?? 0, { timeout: 25_000 }).toBeGreaterThan(0);

  const effects = () => page.getByRole('dialog', { name: 'Display' }).getByRole('group', { name: 'Effects' });
  await openMenuItem(page, 'Display settings');
  await effects().getByRole('button', { name: '2D' }).click();
  await expect(page.locator('.field-svg').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.field-canvas canvas')).toHaveCount(0);
  await effects().getByRole('button', { name: 'Full 3D' }).click();
  await expect(page.locator('.field-canvas canvas')).toHaveCount(1, { timeout: 25_000 });
  await expect.poll(async () => (await page.evaluate(() => window.__gridironGraphics?.info()))?.views ?? 0, { timeout: 25_000 }).toBeGreaterThan(0);
});
