import { expect, test } from '@playwright/test';
import { liveCards, openReplay } from './helpers';

test.describe('slate', () => {
  test('lists live games first, then upcoming and final, clearly labeled as a replay @cross', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await expect(page.locator('.replay-bar')).toContainText('Captured real games, not live');
    const headings = await page.locator('.slate-section h2').allInnerTexts();
    expect(headings[0]).toBe('Live now');
    expect(headings.indexOf('Live now')).toBeLessThan(Math.max(headings.indexOf('Up next'), headings.indexOf('Final')));
    await expect(liveCards(page).first().locator('.status-pill')).toContainText(/Q\d|OT|Halftime|End/);
  });

  test('says plainly when nothing is live, with next kickoffs and a labeled demo', async ({ page }) => {
    await openReplay(page, { at: 0 });
    await expect(page.getByRole('heading', { name: 'No games are live right now.' })).toBeVisible();
    await expect(page.locator('.quiet-block').filter({ hasText: 'Next kickoffs' }).locator('.mini-row').first()).toBeVisible();
    await expect(page.locator('.section-live')).toHaveCount(0);
    await expect(page.locator('.quiet-demo')).toContainText('Replay');
  });

  test('filters by league, search text and live-only', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    const league = page.getByRole('group', { name: 'League' });
    await league.getByRole('button', { name: 'College' }).click();
    await expect(page.locator('.card')).toHaveCount(0);
    await league.getByRole('button', { name: 'NFL' }).click();
    await expect(page.locator('.card').first()).toBeVisible();

    await page.getByPlaceholder('Filter games').fill('Bills');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('BUF');
    await page.getByPlaceholder('Filter games').fill('');

    await page.getByRole('button', { name: /Filters/ }).click();
    await page.getByRole('switch', { name: 'Live games only' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.section-upcoming, .section-final')).toHaveCount(0);
    await expect(liveCards(page).first()).toBeVisible();
  });

  test('draws twelve or more fields through one shared canvas', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 3200 });
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await expect.poll(async () => page.locator('.field-view').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(12);
    // Every field shares one canvas; the page atmosphere behind the interface is a separate, decorative one.
    await expect(page.locator('.field-canvas canvas')).toHaveCount(1);
    // The handle is registered when the renderer mounts, which can be a moment
    // after the views exist. Waiting for the views is not waiting for it.
    await expect.poll(async () => page.evaluate(() => window.__gridironGraphics?.info()?.views ?? null), { timeout: 20_000 }).toBeGreaterThanOrEqual(12);
    const info = await page.evaluate(() => window.__gridironGraphics?.info());
    expect(info?.views).toBeGreaterThanOrEqual(12);
    expect(info?.dpr).toBeLessThanOrEqual(1.25);
  });

  test('shows a field message instead of guessing when a spot is not reported', async ({ page }) => {
    await openReplay(page, { scenario: 'test-missing-spot', at: 0.5 });
    await expect(page.locator('.card').first()).toBeVisible();
    await expect(page.locator('.field-message', { hasText: 'Ball spot unavailable' }).first()).toBeVisible({ timeout: 45_000 });
  });

  /**
   * A team's logo used to flick between two addresses every few seconds, because
   * each report erased what the other had found, and the light disc a logo
   * without a dark variant sits on came and went with it. The summaries keep a
   * team's branding now, and no logo is ever sat on a disc.
   */
  test('a team logo settles on one image and stays there', async ({ page }) => {
    await openReplay(page, { at: 0.4, paused: false, speed: 30 });
    await expect(liveCards(page).first()).toBeVisible();
    const logo = liveCards(page).first().locator('.logo-frame img').first();
    await expect(logo).toBeVisible();

    const seen = await page.evaluate(async () => {
      const img = document.querySelector('.card .logo-frame img')!;
      const srcs: string[] = [];
      const end = performance.now() + 14_000;
      while (performance.now() < end) {
        const src = img.getAttribute('src') ?? '';
        if (srcs[srcs.length - 1] !== src) srcs.push(src);
        await new Promise((r) => setTimeout(r, 250));
      }
      return srcs;
    });
    expect(seen.length, `the logo changed image: ${JSON.stringify(seen)}`).toBe(1);

    // and nothing wears the light disc any more
    expect(await page.locator('.logo-frame.on-chip').count()).toBe(0);
    expect(await page.locator('.logo-frame').count()).toBeGreaterThan(4);
  });
});
