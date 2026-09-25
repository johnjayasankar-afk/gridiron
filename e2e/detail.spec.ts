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
  /*
   * Reported from a screenshot of a finished game: stepping back to play 5 of
   * 158 left the scoreboard and the scorebug reading 35 to 14 beside a clock of
   * Q1 13:33, a final score and a first quarter presented as one moment.
   */
  test('the scrubber marks where the points landed, on the scale the thumb travels', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReplay(page, { path: '/game/nfl-401872925', scenario: 'nfl-week1-sunday', at: 0.9 });
    await expect(page.locator('.rp-scrub')).toBeVisible();

    // One mark per scoring play, which the jump menu counts in its own label.
    const jump = page.getByLabel('Jump to a scoring play');
    const counted = Number((await jump.locator('option').first().innerText()).match(/\((\d+)\)/)![1]);
    expect(counted).toBeGreaterThan(1);
    await expect(page.locator('.rp-mark')).toHaveCount(counted);

    /*
     * And a mark is where the thumb stops for that score. Both are placed on the
     * travel a range input has rather than on its full width, so this is what
     * says they were placed on the same scale: get one of them wrong and the
     * ticks drift away from the thumb across the game.
     */
    const lefts = await page.locator('.rp-mark').evaluateAll((els) => els.map((e) => parseFloat((e as HTMLElement).style.left)));
    const values = await jump.locator('option').evaluateAll((els) => els.slice(1).map((e) => (e as HTMLOptionElement).value));
    const track = await page.locator('.rp-scrub').evaluate((e) => {
      const box = e.getBoundingClientRect();
      return { thumb: parseFloat(getComputedStyle(e).getPropertyValue('--rp-thumb')), left: box.x, width: box.width };
    });
    for (const nth of [0, Math.floor(lefts.length / 2), lefts.length - 1]) {
      await jump.selectOption(values[nth]);
      await expect(page.locator('.situation-panel')).toContainText('Historical view');
      const at = await page.locator('.rp-scrub').evaluate((e) => Number(getComputedStyle(e).getPropertyValue('--at')));
      expect(at * 100, `mark ${nth + 1} of ${lefts.length} is not the play the thumb is on`).toBeCloseTo(lefts[nth], 3);
      /*
       * And in pixels, against the travel a range input has: half a thumb of
       * dead space at each end. The marks, the thumb and the filled part of the
       * track are all placed off one variable, so this is what catches a change
       * that moves one of them and not the others.
       */
      const box = (await page.locator('.rp-mark').nth(nth).boundingBox())!;
      const onTheThumb = track.left + track.thumb / 2 + at * (track.width - track.thumb);
      expect(box.x + box.width / 2, `mark ${nth + 1} of ${lefts.length} is not where the thumb stops`).toBeCloseTo(onTheThumb, 0);
    }
  });

  test('the score, the clock and the period are all as of the play being looked at', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReplay(page, { path: '/game/nfl-401872926', at: 0.95 });
    const board = page.locator('.scoreboard');
    await expect(board).toBeVisible();
    const first = page.getByRole('button', { name: 'First play of the game' });
    await expect(first).toBeEnabled();

    const scores = async () => (await page.locator('.scoreboard .sb-score').allInnerTexts()).join('-');
    const atTheEnd = await scores();

    // To the first play of the game, which nobody has scored in yet.
    await first.click();
    await expect(page.locator('.situation-panel')).toContainText('Historical view');
    await expect.poll(scores, { timeout: 15_000 }).not.toBe(atTheEnd);
    expect(await scores()).toBe('0-0');

    // The bug on the field agrees with the board above it, because both read one game.
    const bug = page.locator('.score-bug');
    const bugScores = (await bug.locator('.bug-score').allInnerTexts()).join('-');
    expect(bugScores).toBe('0-0');

    // And the game is not called final while it is being watched from the first quarter.
    await expect(board).not.toContainText('Final');
    await expect(bug.locator('.bug-period')).toContainText('Q1');

    /*
     * And the two things in that corner do not sit on top of each other. Both
     * were pinned to the bottom left independently, so the bug covered the
     * "Historical view" tag exactly when a play was being looked at.
     */
    const tag = page.locator('.field-tag', { hasText: 'Historical view' });
    await expect(tag).toBeVisible();
    const [tagBox, bugBox] = [await tag.boundingBox(), await bug.boundingBox()];
    expect(tagBox!.y + tagBox!.height).toBeLessThanOrEqual(bugBox!.y + 1);

    /*
     * And the one thing on the page that cannot rewind says so. Team totals are
     * reported once, as they stand, rather than per play, so a total shown
     * beside a first quarter clock would otherwise be read as the total then.
     */
    await page.getByRole('tab', { name: 'Team stats' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('not as they were at the play being looked at');

    // Back to live, and the finished score returns.
    await page.getByRole('button', { name: 'Back to latest' }).click();
    await expect.poll(scores, { timeout: 15_000 }).toBe(atTheEnd);
  });

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
