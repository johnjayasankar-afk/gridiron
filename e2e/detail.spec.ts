import { expect, test, type Page } from '@playwright/test';
import { control, liveCards, openReplay } from './helpers';

async function openLiveGame(page: Page, at = 0.35) {
  const session = await openReplay(page, { at });
  await liveCards(page).first().locator('.card-link').click();
  await expect(page).toHaveURL(/\/game\/nfl-\d+/);
  await expect(page.locator('.scoreboard')).toBeVisible();
  await expect(page.locator('.pbp-row').first()).toBeVisible();
  return session;
}

test.describe('game page', () => {
  test('opens directly from a shareable URL @cross', async ({ page }) => {
    await openReplay(page, { at: 0.4, path: '/game/nfl-401872660' });
    await expect(page.locator('.scoreboard')).toContainText('Bills');
    await expect(page.locator('.scoreboard')).toContainText('Texans');
    await expect(page).toHaveTitle(/BUF \d+, HOU \d+/);
  });

  test('switches camera presets and resets the camera', async ({ page }) => {
    await openLiveGame(page);
    const presets = page.getByRole('group', { name: 'Camera view' });
    await presets.getByRole('button', { name: 'Broadcast' }).click();
    await expect(presets.getByRole('button', { name: 'Broadcast' })).toHaveAttribute('aria-pressed', 'true');
    await presets.getByRole('button', { name: 'Top-down' }).click();
    await expect(presets.getByRole('button', { name: 'Top-down' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Reset camera' }).click();
    await expect(presets.getByRole('button', { name: 'Isometric' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('filters and searches plays, opens a historical view and returns to live', async ({ page }) => {
    await openLiveGame(page);
    await page.getByRole('group', { name: 'Filter plays' }).getByRole('button', { name: 'Scoring' }).click();
    const rows = page.locator('button.pbp-row');
    await expect(rows.first()).toBeVisible();
    for (const text of await rows.allInnerTexts()) expect(text).toMatch(/Score/);
    await page.getByRole('group', { name: 'Filter plays' }).getByRole('button', { name: 'All' }).click();
    await page.getByPlaceholder('Search plays').fill('pass');
    await expect(rows.first()).toContainText(/pass/i);

    await rows.first().click();
    await expect(page.locator('.field-tag', { hasText: 'Historical view' })).toBeVisible();
    await expect(page).toHaveURL(/[?&]play=\d+/);
    await page.getByRole('button', { name: /Back to (live|latest)/ }).click();
    await expect(page.locator('.field-tag', { hasText: 'Historical view' })).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]play=/);
  });

  test('replays plays with play, pause, step and scrub, and flags new live plays', async ({ page }) => {
    const session = await openLiveGame(page, 0.3);
    await page.locator('.rp-play').click();
    const readout = page.locator('.rp-readout');
    await expect(readout).toContainText(/Play 1 of \d+/);
    await expect(readout).toContainText(/Play [2-9] of \d+/, { timeout: 10_000 });
    await page.locator('.rp-play').click();
    const before = await readout.innerText();
    await page.getByRole('button', { name: 'Next play' }).click();
    await expect(readout).not.toHaveText(before);

    await page.getByLabel('Scrub through plays').fill('5');
    await expect(readout).toContainText('Play 6 of');

    await control(page, session, { type: 'speed', speed: 240 });
    await control(page, session, { type: 'play' });
    await expect(page.getByText(/new plays? available/)).toBeVisible({ timeout: 45_000 });
  });

  test('replays a drive from the drive explorer and jumps from the scoring timeline', async ({ page }) => {
    await openLiveGame(page, 0.4);
    await page.getByRole('tab', { name: 'Drives' }).click();
    await page.locator('.drive').first().getByRole('button', { name: 'Replay' }).click();
    await expect(page.getByRole('group', { name: 'Replay scope' }).getByRole('button', { name: 'This drive' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.field-tag', { hasText: 'Historical view' })).toBeVisible();

    await page.getByRole('tab', { name: 'Scoring' }).click();
    const viewPlay = page.locator('.timeline-item').getByRole('button', { name: 'View play' }).first();
    await viewPlay.click();
    await expect(page.locator('.situation-panel')).toContainText('Historical view');
  });

  test('opens a historical play straight from a shared link', async ({ page }) => {
    await openReplay(page, { at: 0.45, path: '/game/nfl-401872660', extra: { play: '40187266086' } });
    await expect(page.locator('.field-tag', { hasText: 'Historical view' })).toBeVisible();
    await expect(page.locator('.pbp-item.is-selected')).toHaveCount(1);
  });

  test('nothing between a field and the page forms a stacking context, so field controls stay above the 3D view', async ({ page }) => {
    // The shared WebGL canvas is fixed at z-index 5 and field overlays sit at 6 to 8. An ancestor that forms a stacking
    // context (sticky, transform, filter, opacity, containment and so on) would put the overlays under the canvas.
    const offenders = () =>
      page.evaluate(() => {
        const found = new Set<string>();
        const set = (v: string) => v !== '' && v !== 'none' && v !== 'normal' && v !== 'auto';
        for (const slot of document.querySelectorAll('.field-slot')) {
          for (let n: Element | null = slot; n && n !== document.body; n = n.parentElement) {
            const s = getComputedStyle(n);
            const parentDisplay = n.parentElement ? getComputedStyle(n.parentElement).display : '';
            const reasons = [
              (s.position === 'sticky' || s.position === 'fixed') && `position ${s.position}`,
              (s.position !== 'static' || /flex|grid/.test(parentDisplay)) && s.zIndex !== 'auto' && `z-index ${s.zIndex}`,
              s.opacity !== '1' && 'opacity',
              s.isolation === 'isolate' && 'isolation',
              ...['transform', 'filter', 'backdrop-filter', 'perspective', 'clip-path', 'mask-image', 'mix-blend-mode', 'container-type', 'view-transition-name'].map(
                (p) => set(s.getPropertyValue(p)) && p,
              ),
              /layout|paint|strict|content/.test(s.getPropertyValue('contain')) && 'contain',
              /transform|opacity|filter|perspective|clip-path|mask|contain|isolation|position/.test(s.getPropertyValue('will-change')) && 'will-change',
            ].filter(Boolean);
            if (reasons.length) found.add(`${n.className}: ${reasons.join(', ')}`);
          }
        }
        return [...found];
      });
    await openReplay(page, { at: 0.35 });
    await expect(liveCards(page).first().locator('.field-slot')).toBeVisible();
    expect(await offenders()).toEqual([]);
    await openReplay(page, { at: 0.35, path: '/game/nfl-401872660' });
    await expect(page.locator('.field-detail .camera-bar')).toBeVisible();
    expect(await offenders()).toEqual([]);
  });
});
