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

  /**
   * Looking at an earlier play should show what was known then. The provider's win
   * probability already moved with the play; the exchange's price did not, and the
   * record to do it with was already being drawn as a trend beside it.
   */
  test('the market rewinds to the play being looked at, and the sportsbook says it cannot', async ({ page }) => {
    await openReplay(page, { path: `/game/${GAME}`, at: 0.6 });
    const panel = page.getByRole('region', { name: 'Odds and win probability' });
    await expect(panel).toBeVisible();
    const market = panel.locator('.odds-block.is-market');
    test.skip((await market.count()) === 0, 'no Kalshi prices captured for this game');
    const nowText = await market.innerText();
    const nowWp = await panel.locator('.wp-read').innerText();

    // Walk back to early in the game.
    await page.getByRole('button', { name: 'First play of the game' }).click();
    const next = page.getByRole('button', { name: 'Next play' });
    for (let i = 0; i < 25; i++) await next.click();
    await expect(panel.locator('.odds-note')).toContainText(/after this play/);

    // The exchange's price is now the one that stood at that play, and says so.
    await expect(market).toContainText('As traded at this play');
    await expect(market).toContainText(/on this play/);
    expect((await market.innerText()) === nowText, 'the market moved with the play').toBe(false);
    expect((await panel.locator('.wp-read').innerText()) === nowWp, 'and so did the win probability').toBe(false);

    // The sportsbook has no line for a play and does not pretend otherwise.
    await expect(panel.locator('.odds-block').first()).toContainText('not play by play');

    // Back to the latest play and the market is the market again.
    await page.getByRole('button', { name: /Back to (live|latest)/ }).click();
    await expect(market).not.toContainText('As traded at this play');
  });

  test('turning odds off in Display settings removes them from cards and the game page', async ({ page }) => {
    await openReplay(page, { at: 0.55 });
    await expect(liveCards(page).first().locator('.card-odds')).toBeVisible();
    await openMenuItem(page, 'Display settings');
    await page.getByRole('dialog', { name: 'Display' }).getByRole('switch', { name: 'Show odds and win probability' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.card-odds')).toHaveCount(0);
    // The pulse is a reading of win probability too, so the preference has to
    // take it with them rather than leaving one drawing of the thing behind.
    await expect(page.locator('.tape-pulse')).toHaveCount(0);
    await openReplay(page, { path: `/game/${GAME}`, at: 0.55 });
    await expect(page.locator('.scoreboard')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Odds and win probability' })).toHaveCount(0);
  });
});
