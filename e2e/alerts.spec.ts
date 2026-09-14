import { expect, test } from '@playwright/test';
import { control, liveCards, openReplay } from './helpers';

test.describe('alerts, corrections and outages', () => {
  test('arriving mid-game is a baseline; new moments appear as play continues', async ({ page }) => {
    const session = await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.waitForTimeout(4000);
    await expect(page.locator('.moment')).toHaveCount(0);
    await expect(page.locator('.rail')).toContainText('Nothing yet');

    await control(page, session, { type: 'speed', speed: 60 });
    await control(page, session, { type: 'play' });
    await expect(page.locator('.moment').first()).toBeVisible({ timeout: 60_000 });
  });

  test('a touchdown reversed on review is withdrawn, not celebrated again', async ({ page }) => {
    // The synthetic scenario spans 3 minutes before the touchdown to 4 minutes after; the reversal lands 1 minute after it.
    const session = await openReplay(page, { scenario: 'test-overturned-touchdown', at: 0.36 });
    await expect(page.locator('.card').first()).toBeVisible();
    await page.waitForTimeout(3000);
    await control(page, session, { type: 'speed', speed: 8 });
    await control(page, session, { type: 'play' });

    const touchdown = page.locator('.moment.kind-touchdown').first();
    await expect(touchdown).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.moment.kind-touchdown.status-withdrawn')).toHaveCount(1, { timeout: 75_000 });
    await expect(page.locator('.moment.kind-touchdown')).toHaveCount(1);
    await expect(page.locator('.moment.kind-touchdown').first()).toContainText('Withdrawn by a correction');
  });

  test('a provider outage is shown as delayed data and recovers, with nothing invented', async ({ page }) => {
    // Outage from 3 to 5 minutes into a 30-minute replay window.
    const session = await openReplay(page, { scenario: 'test-provider-outage', at: 0.06 });
    await expect(page.locator('.card').first()).toBeVisible();
    const scores = await page.locator('.card .score-num').allInnerTexts();
    await control(page, session, { type: 'speed', speed: 20 });
    await control(page, session, { type: 'play' });

    const notice = page.locator('.notices .banner');
    await expect(notice.first()).toContainText(/NFL (updates delayed|data unavailable)/, { timeout: 45_000 });
    await expect(page.locator('.fresh-btn')).toHaveClass(/state-(stale|unavailable)/);
    await expect(page.locator('.card').first()).toBeVisible();
    expect((await page.locator('.card .score-num').allInnerTexts()).length).toBe(scores.length);

    await expect(notice).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('.fresh-btn')).toHaveClass(/state-connected/);
  });

  test('simulating an outage from the replay bar marks cards as delayed', async ({ page }) => {
    const session = await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await control(page, session, { type: 'outage', seconds: 40 });
    await control(page, session, { type: 'play' });
    await expect(page.locator('.field-tag.tag-stale').first()).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.card.is-stale').first()).toBeVisible();
  });
});
