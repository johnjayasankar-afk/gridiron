import { expect, test } from '@playwright/test';
import { liveCards, openMenuItem, openReplay } from './helpers';

/**
 * Odds and win probability, from captured data in the replay lab: ESPN's win probability
 * after each play, the closing DraftKings lines, and Kalshi's prices captured minute by
 * minute for the NFL Week 1 games.
 */

const GAME = 'nfl-401872926'; // Arizona at the Chargers in the NFL Week 1 replay (closing line LAC -8.5)
const MINUS = '−';

test.describe('Odds and win probability', () => {
  test('live cards carry a win probability meter and the sportsbook line @cross', async ({ page }) => {
    await openReplay(page, { at: 0.55 });
    const odds = liveCards(page).first().locator('.card-odds');
    await expect(odds.locator('.wp-meter')).toBeVisible();
    await expect(odds.locator('.wp-read')).toHaveText(/^[A-Z]{2,4} (<1|>99|\d{1,3})%$/);
    await expect(odds.locator('.odds-strip')).toContainText('DraftKings');
  });

  test('the game page shows win probability, the closing lines, and Kalshi prices as captured', async ({ page }) => {
    await openReplay(page, { path: `/game/${GAME}`, at: 0.55 });
    const panel = page.getByRole('region', { name: 'Odds and win probability' });
    await expect(panel.getByRole('img', { name: /^ESPN win probability: / })).toBeVisible();
    await expect(panel).toContainText('Closing lines, as captured');
    const kalshi = panel.getByRole('table', { name: 'Kalshi prices' });
    await expect(kalshi.getByRole('row', { name: /To win/ })).toBeVisible();
    await expect(panel).toContainText('As traded, captured each minute');
    await expect(panel.locator('.odds-trend')).toContainText(/LAC to win \d+(\.\d)?¢/);
    const moneyline = panel.getByRole('row', { name: /Moneyline/ });
    await expect(moneyline).toContainText(`${MINUS}485`);
    await panel.getByRole('group', { name: 'Odds format' }).getByRole('button', { name: 'Chance' }).click();
    await expect(moneyline).toContainText('83%');
    await expect(panel).toContainText('1-800-GAMBLER');
  });

  test('game flow switches to win probability, and a big swing opens its play on the field', async ({ page }) => {
    await openReplay(page, { path: `/game/${GAME}`, at: 0.7 });
    const flow = page.getByRole('region', { name: 'Game flow' });
    await flow.getByRole('group', { name: 'Chart' }).getByRole('button', { name: 'Win probability' }).click();
    await expect(flow.locator('.wp-line').first()).toBeVisible();
    await expect(flow.locator('.wp-market')).toBeVisible();
    await expect(flow).toContainText('Kalshi price, LAC to win');
    const swing = flow.locator('.wp-dot').first();
    await expect(swing).toHaveAttribute('aria-label', /win probability swing/);
    await swing.click();
    await expect(page.locator('.field-tag', { hasText: 'Historical view' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Odds and win probability' })).toContainText('ESPN win probability after this play');
  });

  test('turning odds off in Display settings removes them from cards and the game page', async ({ page }) => {
    await openReplay(page, { at: 0.55 });
    await expect(liveCards(page).first().locator('.card-odds')).toBeVisible();
    await openMenuItem(page, 'Display settings');
    await page.getByRole('dialog', { name: 'Display' }).getByRole('switch', { name: 'Show odds and win probability' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.card-odds')).toHaveCount(0);
    await openReplay(page, { path: `/game/${GAME}`, at: 0.55 });
    await expect(page.locator('.scoreboard')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Odds and win probability' })).toHaveCount(0);
  });
});
