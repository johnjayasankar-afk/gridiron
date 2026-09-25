import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { liveCards, openMenuItem, openReplay, seedPrefs } from './helpers';

/**
 * Automated accessibility audit with axe-core against WCAG 2.1 A and AA rules.
 * Serious and critical violations fail the test. Axe checks the DOM only: the 3D
 * fields are canvas pixels, so their text equivalents (the card links and the
 * field descriptions) are what gets audited.
 */

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('canvas').analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = blocking.map((v) => {
    const first = v.nodes[0];
    const why = first?.failureSummary ? ` (${first.failureSummary.replace(/\s+/g, ' ').trim()})` : '';
    return `${v.id} (${v.impact}): ${v.help}. ${v.nodes.length} element(s), first: ${first?.target.join(' ')}${why}`;
  });
  expect(report, `${label}: accessibility violations`).toEqual([]);
}

test.describe('accessibility audit', () => {
  test('the slate', async ({ page }) => {
    await openReplay(page, { at: 0.5 });
    await expect(liveCards(page).first()).toBeVisible();
    await audit(page, 'slate');
  });

  test('the slate in the Day theme', async ({ page }) => {
    // Chosen before the page loads: auditing during the theme cross-fade would measure colours halfway between themes.
    await seedPrefs(page, { theme: 'light' });
    await openReplay(page, { at: 0.5 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(liveCards(page).first()).toBeVisible();
    await audit(page, 'slate, Day theme');
  });

  test('the tape', async ({ page }) => {
    await openReplay(page, { at: 0.3, paused: false, speed: 60 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.keyboard.press('4');
    await expect.poll(() => page.locator('.tape-lane').count(), { timeout: 30_000 }).toBeGreaterThan(1);
    await audit(page, 'the tape');
  });

  test('the tape in the Day theme', async ({ page }) => {
    await seedPrefs(page, { theme: 'light' });
    await openReplay(page, { at: 0.3, paused: false, speed: 60 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('4');
    await expect.poll(() => page.locator('.tape-lane').count(), { timeout: 30_000 }).toBeGreaterThan(1);
    await audit(page, 'the tape, Day theme');
  });

  test('a game page', async ({ page }) => {
    await openReplay(page, { path: '/game/nfl-401872926', at: 0.55 });
    await expect(page.locator('.dchart')).toBeVisible();
    await audit(page, 'game page');
  });

  /*
   * A game page under a sky: the situation panel gains a sentence about what the
   * field is lit by, and the field itself gains a layer of falling snow. Both are
   * new text and new drawing on a page that is already audited, so they are
   * audited too rather than assumed to be inert.
   */
  test('a game page under weather', async ({ page }) => {
    await openReplay(page, { path: '/game/nfl-401872925', scenario: 'test-weather', at: 0.4 });
    await expect(page.locator('.dchart')).toBeVisible();
    await expect(page.locator('.sit-note')).toContainText('Reported at the venue');
    await audit(page, 'game page under weather');
  });

  test('a team page', async ({ page }) => {
    await openReplay(page, { path: '/team/nfl-2', at: 0.5 });
    await expect(page.getByRole('table')).toBeVisible();
    await audit(page, 'team page');
  });

  test('the alert, watch party and display dialogs', async ({ page }) => {
    await openReplay(page, { at: 0.5 });
    await page.getByRole('banner').getByRole('button', { name: 'Alert settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Alerts' })).toBeVisible();
    await audit(page, 'alert settings');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Start a watch party' }).click();
    await expect(page.getByRole('dialog', { name: 'Watch party' })).toBeVisible();
    await audit(page, 'watch party');
    await page.keyboard.press('Escape');
    await openMenuItem(page, 'Display settings');
    await expect(page.getByRole('dialog', { name: 'Display' })).toBeVisible();
    await audit(page, 'display settings');
  });

  /*
   * A Content Security Policy that blocks something the app needs is a policy
   * somebody will weaken rather than debug, so it is checked against the real
   * page rather than reasoned about: the browser reports every refusal, and
   * there should be none of them anywhere the app actually goes.
   */
  test('the policy blocks nothing the app needs', async ({ page }) => {
    const refusals: string[] = [];
    page.on('console', (m) => {
      if (/content security policy|refused to (load|execute|connect|apply)/i.test(m.text())) refusals.push(m.text());
    });
    await openReplay(page, { at: 0.55 });
    await expect(liveCards(page).first()).toBeVisible();
    // A card carries a team image from the provider, which is the one cross-origin thing the policy allows.
    await expect(liveCards(page).first().locator('img').first()).toBeVisible();
    await liveCards(page).first().locator('.card-link').click();
    await expect(page.locator('.scoreboard')).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!window.__gridironField), { timeout: 20_000 }).toBe(true);
    await page.keyboard.press('4');
    await expect(page.getByRole('heading', { name: 'The tape' })).toBeVisible();
    expect(refusals, 'the browser refused something the app asked for').toEqual([]);
  });

  test('the not-found page', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { name: 'There is no page at this address.' })).toBeVisible();
    await audit(page, 'not found');
  });
});
