import { expect, test } from '@playwright/test';
import { liveCards, openReplay } from './helpers';

/** Journeys for the 0.3 features. Every test runs on its own replay session, so nothing depends on live games or the network. */

const GAME = 'nfl-401872926'; // ARI at LAC in the NFL Week 1 replay

test.describe('Drive tracker', () => {
  test('live cards carry the current drive, and the game page charts it play by play @cross', async ({ page }) => {
    await openReplay(page, { at: 0.55 });
    const strip = liveCards(page).first().locator('.dstrip');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText(/drive|Drive not reported|Scored|Punt|Touchdown|Field goal/i);

    await openReplay(page, { path: `/game/${GAME}`, at: 0.55 });
    const chart = page.getByRole('region', { name: /Current drive|Last drive/ });
    await expect(chart.locator('.dchart-row').first()).toBeVisible();
    await expect(chart).toContainText('Drawn from reported ball spots');
    await chart.locator('.dchart-row').first().click();
    await expect(page.getByRole('region', { name: 'Drive at this play' })).toBeVisible();
    await expect(page.locator('.field-tag', { hasText: 'Historical view' })).toBeVisible();
  });
});

test.describe('Team pages', () => {
  test('a scoreboard team name opens the team page, shown as of the replay clock @cross', async ({ page }) => {
    await openReplay(page, { at: 0.5 });
    await page.getByPlaceholder('Filter games').fill('Bills');
    await page.locator('.card .card-link').first().click();
    await page.getByRole('link', { name: 'Buffalo Bills team page' }).click();
    await expect(page).toHaveURL(/\/team\/nfl-2(\?|$)/);
    await expect(page.getByRole('heading', { level: 1, name: 'Buffalo Bills' })).toBeVisible();
    // The provider reports the record only as of today, so a replay hides it rather than spoil the season.
    await expect(page.getByText('Season record, rank and standing are hidden in the replay lab')).toBeVisible();
    await expect(page.locator('.season-node.is-bye')).toHaveCount(1);
    await expect(page.getByRole('table')).toContainText('Detroit Lions');
    await expect(page.locator('.team-source')).toContainText('saved documents');
  });
});

test.describe('Watch parties', () => {
  test('a guest follows the host into a game, explores alone, returns, and sees the party end', async ({ page: host, browser }) => {
    const guestContext = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: 'block' });
    const guest = await guestContext.newPage();
    try {
      await openReplay(host, { at: 0.5 });
      await expect(liveCards(host).first()).toBeVisible();
      await host.getByRole('button', { name: 'Start a watch party' }).click();
      await host.getByRole('dialog', { name: 'Watch party' }).getByRole('button', { name: 'Start a watch party' }).click();
      const link = await host.locator('#party-link').inputValue();
      await expect(host.getByRole('img', { name: 'QR code for the party link' })).toBeVisible();
      await host.keyboard.press('Escape');

      await guest.goto(link);
      await expect(guest.locator('.party-banner')).toContainText('Following the host');
      await expect(guest.locator('.replay-bar')).toContainText('The watch party host runs this replay');

      await host.locator('.section-live .card .card-link').first().click();
      await expect(host).toHaveURL(/\/game\//);
      const path = new URL(host.url()).pathname;
      await expect.poll(() => new URL(guest.url()).pathname).toBe(path);
      await expect(host.locator('.party-banner')).toContainText('2 in the party');

      await guest.locator('.brand').click();
      await expect(guest.locator('.party-banner')).toContainText('Exploring on your own');
      await guest.locator('.party-banner').getByRole('button', { name: 'Follow the host' }).click();
      await expect.poll(() => new URL(guest.url()).pathname).toBe(path);

      await host.locator('.party-banner').getByRole('button', { name: 'End party' }).click();
      await expect(guest.getByText('The watch party has ended.')).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });
});

test.describe('Push alerts', () => {
  test('alert settings say plainly when push alerts are unavailable', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await page.getByRole('banner').getByRole('button', { name: 'Alert settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Alerts' });
    await expect(dialog.getByRole('heading', { name: 'Push alerts on this device' })).toBeVisible();
    await expect(dialog.locator('.push-unavailable')).toBeVisible({ timeout: 10_000 });
    const key = await page.request.get('/api/push/key');
    expect(await key.json()).toMatchObject({ available: false, reason: 'Push alerts are sent for live games only' });
  });
});

test.describe('Pages and windows', () => {
  test('an unknown address shows a way back to the slate @cross', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { name: 'There is no page at this address.' })).toBeVisible();
    await page.getByRole('button', { name: 'Go to the slate' }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/(\?.*)?$/);
  });

  test('the game page pops out a live tracker window where the browser offers one', async ({ page, context }) => {
    // Headless browsers have no Document Picture-in-Picture, so a popup window stands in for it.
    await page.addInitScript(() => {
      (window as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = {
        requestWindow: async ({ width, height }: { width: number; height: number }) => window.open('', 'gridiron-tracker', `popup,width=${width},height=${height}`),
      };
    });
    await openReplay(page, { path: `/game/${GAME}`, at: 0.55 });
    await expect(page.locator('.scoreboard')).toBeVisible();
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Pop out a live tracker window' }).click();
    const tracker = await opened;
    await expect(tracker.locator('.popout-score')).toBeVisible();
    await expect(tracker.locator('.popout')).toContainText('LAC');
  });

  test('the lateral position test scenario is labelled synthetic and says how the ball is placed', async ({ page }) => {
    await openReplay(page, { scenario: 'test-lateral-position', path: '/game/nfl-401872925', at: 0.55 });
    await expect(page.locator('.replay-bar')).toContainText('Synthetic test scenario');
    await expect(page.locator('.sit-note')).toContainText('lateral position in the data');
  });
});
