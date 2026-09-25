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
  /*
   * Which game the first live card is decides whether this number includes a
   * roof, which is three draws on its own. Recorded beside the count so the
   * figure can be compared with another run rather than guessed at.
   */
  const field = await page.evaluate(() => {
    const f = window.__gridironField?.();
    return { venue: document.title, roof: f?.roof ?? null, indoor: f?.sky?.indoor ?? null };
  });
  writeFileSync('docs/perf-game.json', `${JSON.stringify({ recordedAt: new Date().toISOString(), environment: 'Production build, replay mode, game page at 1440x900 with drive replay playing and camera presets cycling', field, info }, null, 2)}\n`);
  expect(info?.views).toBe(1);
  /*
   * The arena around the field is decoration, and decoration has to stay cheap.
   * These are ceilings with room above what is there, not a snapshot of it: they
   * are here to catch a change that doubles the cost of the bowl, not to make
   * every tweak to it fail.
   */
  expect(info!.calls, 'draw calls on the game page').toBeLessThanOrEqual(45);
  expect(info!.triangles, 'triangles on the game page').toBeLessThanOrEqual(6500);
});

/**
 * Weather is the one thing on the field that never stops.
 *
 * Everything else is drawn on demand: a still page renders no frames at all. Snow
 * falling has to keep asking for them, so a game the provider reports snow for is
 * a game page rendering continuously, and that cost is measured rather than
 * assumed. It is one draw call, and what it is being watched for is the frame it
 * takes and the frames it asks for.
 */
test('weather on the field costs one draw call and keeps its frame cheap', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { path: '/game/nfl-401872925', scenario: 'test-weather', at: 0.4 });
  await expect.poll(() => page.evaluate(() => window.__gridironField?.()?.sky?.kind ?? null), { timeout: 20_000 }).toBe('snow');
  await page.waitForTimeout(3000);

  const frames = await page.evaluate(
    () =>
      new Promise<{ count: number; p50: number; p99: number }>((resolve) => {
        const times: number[] = [];
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          if (times.length < 240) requestAnimationFrame(tick);
          else {
            const sorted = [...times].sort((a, b) => a - b);
            resolve({ count: times.length, p50: sorted[Math.floor(sorted.length * 0.5)], p99: sorted[Math.floor(sorted.length * 0.99)] });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  const info = await page.evaluate(() => window.__gridironGraphics?.info());
  writeFileSync(
    'docs/perf-weather.json',
    `${JSON.stringify({ recordedAt: new Date().toISOString(), environment: 'Production build, replay mode, game page at 1440x900 with snow falling (test-weather synthetic scenario)', info, frames }, null, 2)}
`,
  );
  // One more draw call than the same page in the dry, and one geometry.
  expect(info!.calls, 'draw calls with weather on the field').toBeLessThanOrEqual(46);
  // Snow moves entirely in the vertex shader, so a frame is not doing work per drop on the CPU.
  expect(frames.p99, 'the slowest frames while it snows').toBeLessThanOrEqual(34);
});

/**
 * How long each address takes to put its own content on screen, from the
 * production build. Cold is a fresh browser context with nothing cached, which
 * is a first visit; warm is the same context again, which is a reopened tab.
 *
 * It is a local server, so there is no network in these numbers: they are the
 * app's own work, not what a real connection would add.
 */
test('every address puts its content on screen', async ({ browser }) => {
  test.setTimeout(180_000);
  const ROUTES = [
    { name: 'slate', path: '/', shows: '.section-live .card, .state-block' },
    { name: 'focus', path: '/focus', shows: '.focus-slot, .state-block' },
    { name: 'wall', path: '/wall', shows: '.wall-grid, .state-block' },
    // The tape's own frame, not a lane: a lane needs a recording, and the recorder accumulates over the afternoon rather than on load.
    { name: 'tape', path: '/tape', shows: '.tape, .state-block' },
    { name: 'game', path: '/game/nfl-401872925', shows: '.scoreboard' },
    { name: 'team', path: '/team/nfl-2', shows: 'table, .state-block' },
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const route of ROUTES) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const timed = async () => {
      const started = Date.now();
      await page.goto(`${route.path}?replay=nfl-week1-sunday&at=0.85&paused=1`);
      await page.locator(route.shows).first().waitFor({ state: 'visible', timeout: 30_000 });
      return Date.now() - started;
    };
    const cold = await timed();
    const warm = await timed();
    const bytes = await page.evaluate(() => {
      const list = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return Math.round(list.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024);
    });
    rows.push({ route: route.name, coldMs: cold, warmMs: warm, warmTransferKB: bytes });
    await context.close();
  }
  writeFileSync(
    'docs/perf-routes.json',
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        environment: 'Production build over a local server, so no network latency is included. Cold is a fresh context with an empty cache; warm is the same context a second time. Replay mode, paused, 1440x900.',
        rows,
      },
      null,
      2,
    )}\n`,
  );
  // Nothing here should take anything like this long; it is a ceiling, not a target.
  for (const row of rows) expect(row.coldMs as number, `${row.route} cold`).toBeLessThan(20_000);
});

/**
 * Dragging the scrubber right across a game, which is the heaviest thing a
 * pointer can ask this page for: every step re-reads the play, rebuilds the
 * drive, moves the ball, and rewinds the board, the bug and the odds with it.
 *
 * Measured here rather than in a browser pane, because a pane that is not on
 * screen throttles requestAnimationFrame to about once a second and every
 * reading taken in one says the page is janky when it is not being painted.
 */
test('scrubbing a whole game stays smooth', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { path: '/game/nfl-401872925', scenario: 'nfl-week1-sunday', at: 0.9 });
  await expect(page.locator('.scoreboard')).toBeVisible();
  await expect(page.locator('.rp-scrub input')).toBeEnabled();

  const scrub = async () => page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('.rp-scrub input')!;
    const max = Number(input.max);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const gaps: number[] = [];
    let last = performance.now();
    let stop = false;
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    for (let i = 0; i <= 40; i++) {
      setValue.call(input, String(Math.round((i / 40) * max)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 400));
    stop = true;
    const measured = gaps.slice(1);
    const sorted = [...measured].sort((a, b) => a - b);
    const at = (q: number) => Math.round(sorted[Math.floor(sorted.length * q)] * 10) / 10;
    // Where the rough ones fall, because one hitch at the start of a drag is a different thing from one in the middle.
    const rough = measured.map((g, i) => ({ at: i, ms: Math.round(g * 10) / 10 })).filter((f) => f.ms > 32);
    return { count: sorted.length, median: at(0.5), p95: at(0.95), p99: at(0.99), worst: Math.round(sorted[sorted.length - 1] * 10) / 10, over32: sorted.filter((g) => g > 32).length, rough };
  });

  // Twice, because the first drag through a game pays for whatever it builds on the way.
  const first = await scrub();
  const second = await scrub();
  const frames = second;
  const info = await page.evaluate(() => window.__gridironGraphics?.info());
  writeFileSync('docs/perf-scrub.json', `${JSON.stringify({ recordedAt: new Date().toISOString(), environment: 'Production build, game page at 1440x900, the scrubber dragged across a 149 play game in 41 steps at 60ms apart, twice', first, second, info }, null, 2)}\n`);
  // The page still has to be a page at the end of it.
  await expect(page.locator('.view-error')).toHaveCount(0);
  /*
   * Asserted on the second drag. The first pays a one-off of about 135ms around
   * its third frame, every run, for whatever the first historical play builds;
   * the second has had no frame over 32ms in any run measured. Holding the first
   * to the same bound would be holding warm-up to the price of steady state.
   */
  expect(frames.median, 'the median frame while scrubbing').toBeLessThanOrEqual(20);
  expect(frames.worst, 'the worst frame on a second drag').toBeLessThanOrEqual(60);
  expect(first.median, 'the median frame on the first drag').toBeLessThanOrEqual(20);
});
