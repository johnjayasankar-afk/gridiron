import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, liveCards, openMenuItem, openReplay, seedPrefs } from './helpers';

test.describe('preferences, graphics, layout and accessibility', () => {
  test('appearance starts at Night and a change persists across reloads @cross', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light appearance' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('alert settings persist, and sound stays off until turned on', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await page.getByRole('banner').getByRole('button', { name: 'Alert settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Alerts' });
    await expect(dialog.getByRole('switch', { name: 'Sound' })).toHaveAttribute('aria-checked', 'false');
    await expect(dialog.getByRole('switch', { name: 'Browser notifications' })).toHaveAttribute('aria-checked', 'false');
    await dialog.getByRole('switch', { name: 'Turnover' }).click();
    await expect(dialog.getByRole('switch', { name: 'Turnover' })).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('banner').getByRole('button', { name: 'Alert settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Alerts' }).getByRole('switch', { name: 'Turnover' })).toHaveAttribute('aria-checked', 'false');
  });

  test('muting a game is remembered', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    const card = liveCards(page).first();
    await card.getByRole('button', { name: 'Mute alerts for this game' }).click();
    await expect(card.getByRole('button', { name: 'Unmute alerts for this game' })).toHaveAttribute('aria-pressed', 'true');
    const muted = await page.evaluate(() => (JSON.parse(localStorage.getItem('gridiron.prefs.v1') ?? '{}') as { state?: { mutedGames?: string[] } }).state?.mutedGames ?? []);
    expect(muted).toHaveLength(1);
  });

  test('a spoiler delay buffers before showing anything, then shows the delayed timeline', async ({ page }) => {
    await seedPrefs(page, { delaySeconds: 15 });
    await openReplay(page, { at: 0.3 });
    await expect(page.getByRole('heading', { name: 'Buffering' })).toBeVisible();
    await expect(page.locator('.page-banners')).toContainText('Spoiler delay 15s');
    await expect(liveCards(page).first()).toBeVisible({ timeout: 40_000 });
  });

  test('2D mode draws SVG fields and no WebGL canvas', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await openMenuItem(page, 'Display settings');
    await page.getByRole('dialog', { name: 'Display' }).getByRole('group', { name: 'Effects' }).getByRole('button', { name: '2D' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.field-svg').first()).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  });

  test('a lost graphics context falls back to 2D, says so, and recovers', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await expect(page.locator('.field-canvas canvas')).toHaveCount(1);
    // The 3D layer loads as its own chunk: wait for the renderer, not just the canvas element.
    await page.waitForFunction(() => !!window.__gridironGraphics);
    expect(await page.evaluate(() => window.__gridironGraphics?.loseContext())).toBe(true);
    await expect(page.getByText('3D fields paused because the graphics context was lost')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry 3D' })).toBeVisible();
    await expect(page.locator('.field-svg').first()).toBeVisible();
    await expect(page.locator('.field-canvas canvas')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('.field-view').first()).toBeVisible();
  });

  test('boards save, rename, duplicate, delete with undo, and share', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await liveCards(page).first().getByRole('button', { name: 'Pin game to the top' }).click();
    await openMenuItem(page, 'Boards');
    const dialog = page.getByRole('dialog', { name: 'Boards' });
    await dialog.getByPlaceholder('Board name').fill('Sunday early');
    await dialog.getByRole('button', { name: 'Save board' }).click();
    await expect(dialog.locator('.board-name')).toContainText('Sunday early');

    await dialog.getByRole('button', { name: 'Rename Sunday early' }).click();
    await dialog.getByLabel('New name for Sunday early').fill('Sunday slate');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.locator('.board-name').first()).toContainText('Sunday slate');

    await dialog.getByRole('button', { name: 'Duplicate Sunday slate' }).click();
    await expect(dialog.locator('.board')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Delete Sunday slate copy' }).click();
    await expect(dialog.locator('.board')).toHaveCount(1);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(dialog.locator('.board')).toHaveCount(2);

    await dialog.getByRole('button', { name: 'Copy a share link for Sunday slate' }).first().click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/\?board=[A-Za-z0-9_-]+$/);
    await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
    await expect(page.getByText('Shared board: Sunday slate.')).toBeVisible();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Applied “Sunday slate”' })).toBeVisible();
  });

  test('a broken board link changes nothing and says so', async ({ page }) => {
    await page.goto('/?board=not-a-real-board');
    await expect(page.getByText('This board link is not valid, so nothing was changed.')).toBeVisible();
  });

  test('phone, tablet and wide layouts never scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: /^Moments/ }).click();
    await expect(page.getByRole('dialog', { name: 'Moments' })).toBeVisible();
    await page.keyboard.press('Escape');
    await liveCards(page).first().locator('.card-link').click();
    await expect(page.locator('.scoreboard')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    for (const width of [768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectNoHorizontalOverflow(page);
    }
  });

  test('reduced motion removes decorative animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    const duration = await page.locator('.live-dot').first().evaluate((el) => getComputedStyle(el).animationDuration);
    expect(parseFloat(duration)).toBeLessThanOrEqual(0.001);
  });

  test('skip link, modal focus trap, Escape and focus return', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

    const trigger = page.getByRole('banner').getByRole('button', { name: 'Alert settings' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Alerts' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    for (let i = 0; i < 60; i++) await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
