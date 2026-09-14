/**
 * Graphics measurements for docs/VERIFICATION.md, from the production build in
 * replay mode. Not assertions beyond sanity: run with GRIDIRON_PERF=1 to write
 * docs/perf.json.
 */
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { control, liveCards, openReplay } from './helpers';

test.skip(!process.env.GRIDIRON_PERF, 'Set GRIDIRON_PERF=1 to record graphics measurements');

test('thirteen live fields in one canvas while the replay plays', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 3200 });
  const session = await openReplay(page, { at: 0.35 });
  await expect(liveCards(page).first()).toBeVisible();
  await expect.poll(() => page.locator('.field-view').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(12);

  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => w.__longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false });
  });
  await control(page, session, { type: 'speed', speed: 60 });
  await control(page, session, { type: 'play' });

  const samples: unknown[] = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(5000);
    await page.mouse.wheel(0, i % 2 ? -600 : 600);
    samples.push(await page.evaluate(() => ({ at: Math.round(performance.now()), ...window.__gridironGraphics?.info() })));
  }
  const summary = await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    return {
      cards: document.querySelectorAll('.card').length,
      fieldViews: document.querySelectorAll('.field-view').length,
      canvases: document.querySelectorAll('.field-canvas canvas').length,
      atmosphereCanvases: document.querySelectorAll('canvas.atmosphere').length,
      longTasksOver50ms: w.__longTasks.length,
      longestTaskMs: Math.max(0, ...w.__longTasks),
      jsHeapMB: heap ? Math.round(heap / 1048576) : null,
      moments: document.querySelectorAll('.moment').length,
    };
  });

  const report = {
    recordedAt: new Date().toISOString(),
    environment: 'Production build, replay mode (nfl-week1-sunday from 35%, 60x), headless Chrome via Playwright, viewport 1920x3200',
    summary,
    samples,
  };
  writeFileSync('docs/perf.json', `${JSON.stringify(report, null, 2)}\n`);
  expect(summary.canvases).toBe(1);
  expect(summary.fieldViews).toBeGreaterThanOrEqual(12);
});

test('game page camera and replay stay within budget', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { at: 0.35 });
  await liveCards(page).first().locator('.card-link').click();
  await expect(page.locator('.scoreboard')).toBeVisible();
  await page.locator('.rp-play').click();
  const presets = page.getByRole('group', { name: 'Camera view' });
  for (const name of ['Broadcast', 'Top-down', 'Isometric']) {
    await presets.getByRole('button', { name }).click();
    await page.waitForTimeout(1500);
  }
  const info = await page.evaluate(() => window.__gridironGraphics?.info());
  writeFileSync('docs/perf-game.json', `${JSON.stringify({ recordedAt: new Date().toISOString(), environment: 'Production build, replay mode, game page at 1440x900 with drive replay playing and camera presets cycling', info }, null, 2)}\n`);
  expect(info?.views).toBe(1);
});
