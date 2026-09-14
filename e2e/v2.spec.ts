import { expect, test, type Page } from '@playwright/test';
import { control, openMenuItem, openReplay, seedPrefs } from './helpers';

/** Journeys for the v2 features. Like the rest of the suite, every test runs on its own replay session. */

const GAME = 'nfl-401872926'; // ARI at LAC in the NFL Week 1 replay

const setVisibility = (page: Page, state: 'hidden' | 'visible') =>
  page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

const storedPrefs = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('gridiron.prefs.v1') ?? '{}').state as { pinned: string[]; focusGames: string[] });

test.describe('Director', () => {
  test('a Focus slot follows a live game with its reason, and stays or skips on request', async ({ page }) => {
    await seedPrefs(page, { director: { focus: true, wall: false }, focusSize: 4 });
    await openReplay(page, { path: '/focus', at: 0.5 });
    const ribbon = page.getByRole('group', { name: 'Director' });
    const card = page.locator('.director-slot .card');
    await expect(card).toBeVisible();
    await expect(ribbon).toContainText(/[A-Z]{2,4} at [A-Z]{2,4}/);

    await ribbon.getByRole('button', { name: 'Stay on this game' }).click();
    await expect(ribbon.getByRole('button', { name: 'Let the director move on' })).toHaveAttribute('aria-pressed', 'true');
    await expect(ribbon).toContainText('staying');

    const followed = await card.getAttribute('data-game');
    await ribbon.getByRole('button', { name: 'Skip this game for 3 minutes' }).click();
    await expect.poll(() => card.getAttribute('data-game')).not.toBe(followed);
    // Three manual slots remain beside the director.
    await expect(page.locator('.focus-grid > .focus-slot:not(.director-slot)')).toHaveCount(3);
  });

  test('the wall gives the director a large tile and never repeats that game in the grid', async ({ page }) => {
    await seedPrefs(page, { director: { focus: false, wall: true }, wallSize: 9 });
    await openReplay(page, { path: '/wall', at: 0.5 });
    const hero = page.locator('.wall-hero .card');
    await expect(hero).toBeVisible();
    const heroId = await hero.getAttribute('data-game');
    await expect(page.locator('.wall-grid > .card')).toHaveCount(5);
    await expect(page.locator(`.wall-grid > .card[data-game="${heroId}"]`)).toHaveCount(0);
  });
});

test.describe('While you were away', () => {
  test('coming back after time away summarizes what was reported, and can be dismissed', async ({ page }) => {
    await page.addInitScript(() => {
      window.__gridironDigestMinAwayMs = 500;
    });
    const session = await openReplay(page, { at: 0.55 });
    await expect(page.locator('.card').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__gridironDigestState?.().key ?? null)).not.toBeNull();

    await setVisibility(page, 'hidden');
    expect(await page.evaluate(() => window.__gridironDigestState?.().memory ?? null)).not.toBeNull();
    await control(page, session, { type: 'seek', progress: 0.72 });
    await page.waitForTimeout(1500);
    await setVisibility(page, 'visible');

    const digest = page.getByRole('region', { name: 'While you were away' });
    await expect(digest).toBeVisible();
    await expect(digest).toContainText(/final/i);
    await expect(digest.locator('.digest-item').first()).toBeVisible();
    await digest.getByRole('button', { name: 'Dismiss the summary' }).click();
    await expect(digest).toHaveCount(0);
  });
});

test.describe('Game page', () => {
  test('game flow names each score, opens it on the field, and moves by arrow keys', async ({ page }) => {
    await openReplay(page, { path: `/game/${GAME}`, at: 1 });
    const flow = page.getByRole('region', { name: 'Game flow' });
    await expect(flow).toContainText('Largest lead');
    await expect(flow).toContainText('Final');
    const dots = flow.locator('.flow-dot');
    await expect(dots.first()).toBeVisible();
    expect(await dots.count()).toBeGreaterThan(3);

    const second = dots.nth(1);
    await second.hover();
    await expect(flow.locator('.flow-tip')).toBeVisible();
    await second.click();
    await expect(page).toHaveURL(/[?&]play=/);
    await expect(page.locator('.field-tag.tag-history')).toBeVisible();
    await expect(second).toHaveClass(/is-selected/);

    await second.focus();
    await page.keyboard.press('ArrowRight');
    await expect(dots.nth(2)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(dots.first()).toBeFocused();
  });

  test('leaders and attendance appear for a final game', async ({ page }) => {
    await openReplay(page, { path: `/game/${GAME}`, at: 1 });
    const leaders = page.getByRole('region', { name: 'Game leaders' });
    await expect(leaders).toContainText('Passing');
    await expect(leaders).toContainText('Rushing');
    await expect(leaders).toContainText('Receiving');
    await expect(leaders.locator('.leader')).toHaveCount(6);
    await expect(leaders.locator('.leader-line').first()).toContainText('YDS');
    await page.getByRole('tab', { name: 'Game info' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Attendance');
  });

  test('a replay does not show leaders before the game ends', async ({ page }) => {
    await openReplay(page, { path: `/game/${GAME}`, at: 0.5 });
    await expect(page.getByRole('region', { name: 'Game flow' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Game leaders' })).toHaveCount(0);
  });

  test('[ and ] move to the previous and next game in slate order', async ({ page }) => {
    await openReplay(page, { path: `/game/${GAME}`, at: 0.5 });
    const nav = page.getByRole('navigation', { name: 'Other games on the slate' });
    await expect(nav.locator('.game-nav-pos')).toHaveText(/^\d+\/\d+$/);
    const position = (await nav.locator('.game-nav-pos').textContent()) ?? '';
    await page.keyboard.press(']');
    await expect(page).not.toHaveURL(new RegExp(GAME));
    await expect(nav.locator('.game-nav-pos')).not.toHaveText(position);
    await page.keyboard.press('[');
    await expect(page).toHaveURL(new RegExp(GAME));
    await expect(nav.locator('.game-nav-pos')).toHaveText(position);
  });
});

test.describe('Keyboard and appearance', () => {
  test('J and K move across cards; F adds the focused game to Focus and P pins it', async ({ page }) => {
    await openReplay(page, { at: 0.5 });
    const links = page.locator('.card .card-link');
    await expect(links.first()).toBeVisible();
    await page.keyboard.press('j');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('j');
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press('k');
    await expect(links.first()).toBeFocused();

    const id = await page.locator('.card').first().getAttribute('data-game');
    await page.keyboard.press('f');
    await expect.poll(async () => (await storedPrefs(page)).focusGames).toContain(id);
    await page.keyboard.press('p');
    await expect.poll(async () => (await storedPrefs(page)).pinned).toContain(id);
  });

  test('System appearance follows the device setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await seedPrefs(page, { theme: 'system' });
    await openReplay(page, { at: 0.5 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await openMenuItem(page, 'Display settings');
    await expect(page.getByText('Follows the light or dark setting on this device')).toBeVisible();
  });
});

test.describe('Moments', () => {
  test('play moments carry a field strip of the reported start and end', async ({ page }) => {
    const session = await openReplay(page, { at: 0.5 });
    await expect(page.locator('.card').first()).toBeVisible();
    await control(page, session, { type: 'speed', speed: 60 });
    await control(page, session, { type: 'play' });
    await expect(page.locator('.rail .moment-field').first()).toBeVisible({ timeout: 45_000 });
  });
});

test.describe('Install and delivery', () => {
  test.use({ serviceWorkers: 'allow' });

  test('a web app manifest with icons, and a service worker that leaves live data alone', async ({ page, request }) => {
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBeTruthy();
    expect(manifest.headers()['content-type']).toContain('application/manifest+json');
    const json = (await manifest.json()) as { name: string; icons: Array<{ src: string }> };
    expect(json.name).toBe('Gridiron');
    for (const icon of json.icons) expect((await request.get(icon.src)).ok(), icon.src).toBeTruthy();

    await openReplay(page, { at: 0.5 });
    const script = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? null);
    expect(script).toContain('/sw.js');
    expect(await (await request.get('/sw.js')).text()).toContain("startsWith('/api/')");
  });

  test('precompressed assets, gzipped JSON, and a 404 for a missing chunk', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const entry = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(entry).toBeTruthy();
    const br = await request.get(entry!, { headers: { 'accept-encoding': 'br' } });
    expect(br.headers()['content-encoding']).toBe('br');
    expect(br.headers().vary).toBe('accept-encoding');
    const gz = await request.get('/api/slate', { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.ok()).toBeTruthy();
    expect(gz.headers()['content-encoding']).toBe('gzip');
    expect((await request.get('/assets/missing-chunk-abc123.js')).status()).toBe(404);
  });
});
