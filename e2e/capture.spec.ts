/**
 * Design screenshots at the target widths, from the production build in replay
 * mode. Not assertions: run with GRIDIRON_CAPTURE=1 to write docs/screenshots.
 */
import { expect, test, type Page } from '@playwright/test';
import { control, liveCards, openMenuItem, openReplay, seedPrefs } from './helpers';

test.skip(!process.env.GRIDIRON_CAPTURE, 'Set GRIDIRON_CAPTURE=1 to capture design screenshots');
test.describe.configure({ mode: 'serial' });

const OUT = 'docs/screenshots';

async function settle(page: Page) {
  await expect(page.locator('.field-view, .field-svg').first()).toBeVisible();
  await page.waitForTimeout(1800);
}

for (const [name, width, height] of [
  ['1920', 1920, 1080],
  ['1440', 1440, 900],
  ['768', 768, 1024],
  ['390', 390, 844],
] as const) {
  test(`slate at ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const session = await openReplay(page, { at: 0.35 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page);
    await page.screenshot({ path: `${OUT}/slate-${name}.png` });

    // The pulse on a card is a recording of an afternoon, and a paused replay
    // never records a second reading, so the close up of the cards runs the
    // afternoon on for a moment and then stops it again. Without this the card
    // shots document a slate the feature is missing from.
    await control(page, session, { type: 'speed', speed: 60 });
    await control(page, session, { type: 'play' });
    await expect(page.locator('.tape-pulse').first()).toBeVisible({ timeout: 40_000 });
    await page.waitForTimeout(4000);
    await control(page, session, { type: 'pause' });

    await page.evaluate(() => document.querySelector('.section-live')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -80));
    await settle(page);
    await page.screenshot({ path: `${OUT}/slate-${name}-cards.png` });
  });
}

test('game page, light and dark, three cameras', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Night is the default; these captures start in the Day theme and switch.
  await seedPrefs(page, { theme: 'light' });
  await openReplay(page, { at: 0.35 });
  await liveCards(page).first().locator('.card-link').click();
  await expect(page.locator('.scoreboard')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/game-1440-isometric.png` });
  const presets = page.getByRole('group', { name: 'Camera view' });
  await presets.getByRole('button', { name: 'Broadcast' }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/game-1440-broadcast.png` });
  await presets.getByRole('button', { name: 'Top-down' }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/game-1440-top.png` });
  await page.getByRole('button', { name: 'Switch to dark appearance' }).click();
  await presets.getByRole('button', { name: 'Isometric' }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/game-1440-dark.png` });
  await page.locator('.replay-panel').scrollIntoViewIfNeeded();
  await page.locator('.rp-play').click();
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.scrollTo(0, 200));
  await settle(page);
  await page.screenshot({ path: `${OUT}/game-1440-dark-replay.png` });
});

test('game page on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReplay(page, { at: 0.35 });
  await liveCards(page).first().locator('.card-link').click();
  await expect(page.locator('.scoreboard')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/game-390.png` });
  await page.evaluate(() => window.scrollTo(0, 700));
  await settle(page);
  await page.screenshot({ path: `${OUT}/game-390-panels.png` });
});

test('focus, wall, empty day, 2D and dark slate', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedPrefs(page, { theme: 'light' });
  await openReplay(page, { at: 0.35 });
  await expect(liveCards(page).first()).toBeVisible();
  await page.keyboard.press('2');
  await page.getByRole('button', { name: 'Fill empty slots' }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/focus-1440.png` });

  await page.keyboard.press('3');
  await page.getByRole('group', { name: 'Wall size' }).getByRole('button', { name: '9' }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/wall-9-1440.png` });
  await page.getByRole('group', { name: 'Wall size' }).getByRole('button', { name: '16' }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/wall-16-1440.png` });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Switch to dark appearance' }).click();
  await page.evaluate(() => document.querySelector('.section-live')?.scrollIntoView({ block: 'start' }));
  await settle(page);
  await page.screenshot({ path: `${OUT}/slate-1440-dark.png` });

  await openMenuItem(page, 'Display settings');
  await page.getByRole('dialog', { name: 'Display' }).getByRole('group', { name: 'Effects' }).getByRole('button', { name: '2D' }).click();
  await page.keyboard.press('Escape');
  await settle(page);
  await page.screenshot({ path: `${OUT}/slate-1440-2d.png` });
});

test('v2: moments, while you were away, director, game flow and leaders', async ({ page }) => {
  const setVisibility = (state: 'hidden' | 'visible') =>
    page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.__gridironDigestMinAwayMs = 500;
  });
  const session = await openReplay(page, { at: 0.45 });
  await expect(liveCards(page).first()).toBeVisible();

  await control(page, session, { type: 'speed', speed: 60 });
  await control(page, session, { type: 'play' });
  await expect(page.locator('.rail .moment-field').first()).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(4000);
  await control(page, session, { type: 'pause' });
  await settle(page);
  await page.screenshot({ path: `${OUT}/moments-1440.png` });

  await setVisibility('hidden');
  await control(page, session, { type: 'seek', progress: 0.62 });
  await page.waitForTimeout(1500);
  await setVisibility('visible');
  await expect(page.getByRole('region', { name: 'While you were away' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  await page.screenshot({ path: `${OUT}/digest-1440.png` });

  await page.keyboard.press('2');
  await page.getByRole('button', { name: 'Director', exact: true }).click();
  await expect(page.locator('.director-slot .card')).toBeVisible();
  await page.getByRole('button', { name: 'Fill empty slots' }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/focus-director-1440.png` });

  await page.keyboard.press('3');
  await page.getByRole('group', { name: 'Wall size' }).getByRole('button', { name: '9' }).click();
  await page.locator('.wall .director-toggle').click();
  await expect(page.locator('.wall-hero .card')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/wall-director-1440.png` });
  await page.keyboard.press('Escape');

  await control(page, session, { type: 'seek', progress: 1 });
  await page.locator('.card[data-game="nfl-401872926"] .card-link').first().click();
  const leaders = page.getByRole('region', { name: 'Game leaders' });
  await expect(leaders).toBeVisible();
  await settle(page);
  await leaders.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/game-1440-leaders.png` });
  // The field is far above the chart here, so its 3D view is unmounted: wait on the chart, not the field.
  const flow = page.getByRole('region', { name: 'Game flow' });
  await flow.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await flow.locator('.flow-dot').nth(4).hover();
  await expect(flow.locator('.flow-tip')).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/game-1440-flow.png` });
});

test('v3: drive chart, team page and watch party', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { path: '/game/nfl-401872926', at: 0.55 });
  const chart = page.locator('.dchart');
  await expect(chart).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/game-1440-drive.png` });

  await openReplay(page, { path: '/team/nfl-2', at: 0.5 });
  await expect(page.getByRole('table')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/team-1440.png` });

  await openReplay(page, { at: 0.5 });
  await expect(liveCards(page).first()).toBeVisible();
  await page.getByRole('button', { name: 'Start a watch party' }).click();
  await page.getByRole('dialog', { name: 'Watch party' }).getByRole('button', { name: 'Start a watch party' }).click();
  await expect(page.getByRole('img', { name: 'QR code for the party link' })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/party-1440.png` });
});

test('v4: odds and win probability', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { path: '/game/nfl-401872926', at: 0.55 });
  const panel = page.getByRole('region', { name: 'Odds and win probability' });
  await expect(panel).toBeVisible();
  await settle(page);
  await panel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/game-1440-odds.png` });
  // The field is far above the chart here, so its 3D view is unmounted: wait on the chart, not the field.
  const flow = page.getByRole('region', { name: 'Game flow' });
  await flow.getByRole('group', { name: 'Chart' }).getByRole('button', { name: 'Win probability' }).click();
  await flow.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(flow.locator('.wp-line').first()).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/game-1440-win-probability.png` });
});

/**
 * The one way to photograph a sky: no captured replay carries weather, because
 * it lives on the live scoreboard and was not captured with these games, so this
 * is the synthetic scenario that says plainly that its snow did not happen.
 */
test('v5: the field under its own sky', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { path: '/game/nfl-401872925', scenario: 'test-weather', at: 0.4 });
  await expect.poll(() => page.evaluate(() => window.__gridironField?.()?.sky?.kind ?? null), { timeout: 20_000 }).toBe('snow');
  await settle(page);
  // Long enough for the snow to have fallen into the middle of its own descent rather than starting at the top.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/game-1440-weather.png` });
});

/** A venue the provider says has a roof, which no captured replay has. */
test('v5: a venue with a roof', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { path: '/game/nfl-401872925', scenario: 'test-indoors', at: 0.4 });
  await expect.poll(() => page.evaluate(() => window.__gridironField?.()?.sky?.indoor ?? null), { timeout: 20_000 }).toBe(true);
  await settle(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/game-1440-indoors.png` });
});

/**
 * Two bowls the same code drew from two real capacities: the biggest stadium in
 * the country and one of the smaller grounds on the same slate.
 */
for (const [name, game] of [
  ['big', 'nfl-401872930'], // MetLife Stadium, 82,500
  ['small', 'nfl-401872659'], // Lucas Oil Stadium, 62,421
] as const) {
  test(`v5: the bowl at a ${name} venue`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReplay(page, { path: `/game/${game}`, at: 0.5 });
    await expect.poll(() => page.evaluate(() => !!window.__gridironField), { timeout: 20_000 }).toBe(true);
    await settle(page);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/game-1440-bowl-${name}.png` });
  });
}

test('an empty day and the command palette', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { at: 0 });
  await expect(page.getByRole('heading', { name: 'No games are live right now.' })).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/empty-1440.png` });
  await page.keyboard.press('ControlOrMeta+K');
  await page.getByPlaceholder('Search games, teams or commands').fill('bills');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/palette-1440.png` });
});

/**
 * The tape needs a recording, and a recording is made by watching. So this one
 * runs the replay fast for a while and lets it write, which is the only way to
 * photograph a view whose subject is an afternoon.
 */
test('the tape, after an afternoon of it', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { at: 0.18, paused: false, speed: 120 });
  await expect(liveCards(page).first()).toBeVisible();
  await page.keyboard.press('4');
  await expect(page.getByRole('heading', { name: 'The tape' })).toBeVisible();
  // enough of the day recorded that the lanes have a shape to show
  await expect.poll(() => page.locator('.tape-lane').count(), { timeout: 60_000 }).toBeGreaterThan(6);
  await expect
    .poll(async () => (await page.locator('.tape-lane__movement').allInnerTexts()).filter((v) => v !== 'none').length, { timeout: 60_000 })
    .toBeGreaterThan(4);
  await page.waitForTimeout(45_000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${OUT}/tape-1440.png` });

  // and one moment read across every game at once
  const band = page.locator('.tape-lane__band').first();
  await band.hover();
  await expect(page.locator('.tape__scrub')).toBeVisible();
  const box = (await band.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/tape-1440-scrub.png` });
});
