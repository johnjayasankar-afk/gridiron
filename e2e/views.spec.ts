import { expect, test } from '@playwright/test';
import { liveCards, openReplay } from './helpers';

test.describe('focus, wall, palette and shortcuts', () => {
  test('focus holds 1, 2 or 4 games that can be replaced, moved and removed', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.keyboard.press('2');
    await expect(page.getByRole('heading', { name: 'Focus' })).toBeVisible();
    await page.getByRole('group', { name: 'Games in focus' }).getByRole('button', { name: '2' }).click();
    await page.getByLabel('Choose a game for slot 1').selectOption({ index: 1 });
    await page.getByLabel('Choose a game for slot 1').waitFor({ state: 'detached' });
    await page.getByLabel('Choose a game for slot 2').selectOption({ index: 2 });
    await expect(page.locator('.focus-slot .card')).toHaveCount(2);

    const first = await page.locator('.focus-slot .card').first().getAttribute('data-game');
    await page.locator('.focus-slot').first().getByRole('button', { name: 'Move to the next slot' }).click();
    await expect(page.locator('.focus-slot .card').nth(1)).toHaveAttribute('data-game', first!);

    await page.getByLabel('Replace the game in slot 1').selectOption({ index: 3 });
    await expect(page.locator('.focus-slot .card').first()).not.toHaveAttribute('data-game', first!);
    await page.locator('.focus-slot').first().getByRole('button', { name: 'Remove from focus' }).first().click();
    await expect(page.locator('.focus-slot.is-empty')).toHaveCount(1);
  });

  test('the wall shows 4, 9 or 16 games and exits with Escape', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.keyboard.press('3');
    await expect(page.locator('.wall')).toBeVisible();
    const size = page.getByRole('group', { name: 'Wall size' });
    await size.getByRole('button', { name: '4' }).click();
    await expect(page.locator('.wall-grid .card')).toHaveCount(4);
    await size.getByRole('button', { name: '16' }).click();
    await expect.poll(() => page.locator('.wall-grid .card').count()).toBeGreaterThan(4);
    expect(await page.locator('.wall-grid .card').count()).toBeLessThanOrEqual(16);
    await page.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
    await expect(page.locator('.wall-grid .card-compact').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.wall')).toHaveCount(0);
    await expect(page).toHaveURL(/\/\?/);
  });

  test('the command palette finds a game and opens it; shortcuts are listed', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.keyboard.press('ControlOrMeta+K');
    const input = page.getByRole('dialog', { name: 'Search games, teams and commands' }).getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill('texans');
    await expect(page.getByRole('listbox', { name: 'Results' }).getByRole('option').first()).toContainText(/Texans/);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/game\//);

    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('1');
    await expect(page.locator('.strip')).toBeVisible();
  });

  test('a team favorited from the palette drives the favorites filter', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.keyboard.press('ControlOrMeta+K');
    await page.getByPlaceholder('Search games, teams or commands').fill('Buffalo');
    const team = page.getByRole('option', { name: /Buffalo Bills \(BUF\)/ });
    // Enter or a click opens the team page; with Shift, the team is starred instead.
    await expect(team).toContainText('Shift+Enter stars');
    await team.click({ modifiers: ['Shift'] });
    await expect(page.getByRole('status').filter({ hasText: 'Added BUF to favorites' })).toBeVisible();
    await page.getByRole('button', { name: 'Show favorite teams only' }).click();
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('BUF');
  });
});
