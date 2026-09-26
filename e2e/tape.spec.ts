import { expect, test, type Page } from '@playwright/test';
import { control, expectNoHorizontalOverflow, liveCards, openReplay } from './helpers';

/**
 * The arithmetic the tape does is covered exactly in tests/tape.test.ts, against
 * hand written samples. These are the journeys: that a running card is recorded
 * into lanes on one clock, that pointing at it reads every game at that moment,
 * and that a lane opens the game it is a lane of.
 *
 * A seeded tape is deliberately not used. The view only draws games on the day
 * being presented, so invented ids are filtered out exactly as they should be.
 */
/*
 * A note on why this file is flaky in a parallel run, which it is and was before
 * these journeys were added.
 *
 * Every journey here opens its own replay session at sixty times speed and then
 * waits up to thirty seconds for the recording to produce lanes. Sessions are not
 * closed at the end of a test and live for fifteen idle minutes, so by the end of
 * a suite the server is advancing a dozen replays at sixty times speed at once
 * and the newest one starves. Measured across both browser projects at two
 * workers: four of these journeys failed with no lanes recorded, a different four
 * on the next run, and every one of them passes alone.
 *
 * Making the file serial was tried and is worse: the first failure then skips the
 * rest. The real fix is for `openReplay` to end its session when a test finishes,
 * which is a change to a helper every spec uses and is not made here.
 */
async function openTape(page: Page, at: number): Promise<string> {
  const session = await openReplay(page, { at, paused: false, speed: 60 });
  await expect(liveCards(page).first()).toBeVisible();
  await page.keyboard.press('4');
  await expect(page.getByRole('heading', { name: 'The tape' })).toBeVisible();
  // The recording is written as the world arrives, so lanes appear once it has.
  await expect.poll(() => page.locator('.tape-lane').count(), { timeout: 30_000 }).toBeGreaterThan(1);
  return session;
}

/**
 * Waits until the recording has two reported win probabilities for some game,
 * which is the first moment there is any movement to measure. A minute into a
 * recording every lane honestly reads "none", and a test that assumed otherwise
 * was testing how long it had been watching.
 */
async function waitForMovement(page: Page) {
  await expect
    .poll(async () => (await page.locator('.tape-lane__movement').allInnerTexts()).filter((v) => v !== 'none').length, { timeout: 40_000 })
    .toBeGreaterThan(0);
}

test.describe('the tape', () => {
  test('records a running card into lanes on one clock @cross', async ({ page }) => {
    await openTape(page, 0.3);
    await expect(page.locator('.tape-lane__chart').first()).toBeVisible();
    // every lane shares the one axis, so they are all the same width
    const widths = await page.locator('.tape-lane__chart').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeGreaterThan(100);
    await expectNoHorizontalOverflow(page);
  });

  test('measures movement, and never invents a value it was not given', async ({ page }) => {
    await openTape(page, 0.3);
    await waitForMovement(page);
    const values = await page.locator('.tape-lane__movement').allInnerTexts();
    expect(values.length).toBeGreaterThan(1);
    // a lane reports a whole number of probability points, or says it has none
    for (const v of values) expect(v).toMatch(/^(\d+|none)$/);
    // and the order is what it claims: most movement first among live games
    const numbers = values.filter((v) => v !== 'none').map(Number);
    expect([...numbers].sort((a, b) => b - a)).toEqual(numbers);

    // a lane with no reported win probability draws no ribbon rather than a flat line at nothing
    const lanes = page.locator('.tape-lane');
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== 'none') continue;
      await expect(lanes.nth(i).locator('.tape-lane__chart path')).toHaveCount(0);
    }
  });

  test('says what the day did, in measurements rather than verdicts', async ({ page }) => {
    await openTape(page, 0.3);
    await waitForMovement(page);
    const summary = page.locator('.tape__summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Most movement');
    await expect(summary).toContainText('points of reported win probability');
    // it names what it measured, and does not call anything the best game
    await expect(summary).not.toContainText(/best game/i);
  });

  test('reads every game at one moment', async ({ page }) => {
    await openTape(page, 0.3);
    await waitForMovement(page);
    const scores = page.locator('.tape-lane__score');
    const atLatest = await scores.allInnerTexts();

    // hover() puts a real pointer on the element, which is what the scrub listens
    // for; a bare mouse.move into the region is not reliably delivered as one
    const band = page.locator('.tape-lane__band').first();
    await band.hover();
    await expect(page.locator('.tape__scrub')).toBeVisible();
    await expect(page.locator('.tape__scrub-time')).toContainText(/\d/);

    // then step back to the start of the recording, where the games were younger
    const box = (await band.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await expect.poll(async () => (await scores.allInnerTexts()).join('|')).not.toBe(atLatest.join('|'));

    // and leaving it puts every lane back to the game as it is now. Not back to
    // the scores this test started with: the card is running at sixty times
    // speed and has moved on, which is the point of the view.
    await page.getByRole('heading', { name: 'The tape' }).hover();
    await expect(page.locator('.tape__scrub')).toHaveCount(0);
    await expect(page.locator('.tape-lane.is-live .tape-lane__when').first()).toContainText(/\d/);
  });

  /**
   * The property the whole view rests on: a lane's drawing is a function of its
   * data and its box, and of nothing that moves. The clock ticks every second
   * and the pointer moves sixty times a second, and neither may rebuild a lane.
   * Both used to: they were props on the memoised component, so a dot moving
   * four pixels rebuilt every ribbon, quarter, score and red zone on the page.
   */
  test('scrubbing and the clock never rebuild a lane', async ({ page }) => {
    const session = await openTape(page, 0.3);
    await waitForMovement(page);
    // The world is stopped first. A running card rebuilds the lanes whose data
    // actually changed, which is right and is not what this measures.
    await control(page, session, { type: 'pause' });
    await page.waitForTimeout(1200);

    const tag = () => page.evaluate(() => [...document.querySelectorAll('.tape-lane__chart *')].forEach((n, i) => ((n as HTMLElement & { __e2e?: number }).__e2e = i)));
    const rebuilt = () => page.evaluate(() => [...document.querySelectorAll('.tape-lane__chart *')].filter((n) => (n as HTMLElement & { __e2e?: number }).__e2e === undefined).length);

    // scrubbing right across the tape
    await tag();
    const band = page.locator('.tape-lane__band').first();
    const box = (await band.boundingBox())!;
    for (let i = 0; i <= 20; i++) await page.mouse.move(box.x + (i / 20) * box.width, box.y + box.height / 2);
    expect(await rebuilt(), 'scrubbing rebuilt lane drawing nodes').toBe(0);

    // and the two things that move are moved by a transform, not by redrawing
    const moved = await page.locator('.tape-lane__now').first().evaluate((el) => getComputedStyle(el).transform);
    expect(moved).toMatch(/^matrix/);
  });

  test('can be read by keyboard, not only by pointer', async ({ page }) => {
    await openTape(page, 0.3);
    await waitForMovement(page);
    const scores = page.locator('.tape-lane__score');
    const now = (await scores.allInnerTexts()).join('|');

    await page.locator('.tape__grid').focus();
    await page.keyboard.press('Home');
    await expect(page.locator('.tape__scrub')).toBeVisible();
    await expect.poll(async () => (await scores.allInnerTexts()).join('|')).not.toBe(now);

    // A step moves it. The position is what is asserted, not the label: a step is
    // a fortieth of the tape, and on a short recording two of them can land
    // inside the same minute while having moved perfectly well.
    const left = () => page.locator('.tape__scrub').evaluate((el) => Math.round((el as HTMLElement).offsetLeft));
    const start = await left();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(left).toBeGreaterThan(start);
    const forward = await left();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(left).toBeLessThan(forward);
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Reading' })).toHaveCount(1);

    // and Escape gives the lanes back to the live game
    await page.keyboard.press('Escape');
    await expect(page.locator('.tape__scrub')).toHaveCount(0);
  });

  /**
   * The thing that makes the tape a way in rather than only a picture: a point
   * on a lane is a play on the field, and the game page already opens at one.
   */
  test('opens a game at the moment that was pointed at', async ({ page }) => {
    const session = await openTape(page, 0.3);
    await waitForMovement(page);
    await control(page, session, { type: 'pause' });

    const band = page.locator('.tape-lane__band').first();
    // hover() first: a bare move into the region is not reliably delivered as a
    // pointer event, which the scrub is what listens for
    await band.hover();
    const box = (await band.boundingBox())!;
    // a moment partway through the recording, not its live edge
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
    await expect(page.locator('.tape__scrub')).toBeVisible();
    await expect(band).toHaveAttribute('aria-label', /on the field/);

    await band.click();
    await expect(page).toHaveURL(/\/game\/.*[?&]play=\d+/);
    // and the field is held at that play rather than following the live one
    await expect(page.getByRole('button', { name: /back to live/i })).toBeVisible();
  });

  test('opens the game plainly when no play was reported for that moment', async ({ page }) => {
    await openTape(page, 0.3);
    // the label always opens the game itself, with no moment attached
    await page.locator('.tape-lane__open').first().click();
    await expect(page).toHaveURL(/\/game\//);
    await expect(page).not.toHaveURL(/[?&]play=/);
  });

  test('opens the game a lane is a lane of', async ({ page }) => {
    await openTape(page, 0.35);
    await page.locator('.tape-lane__open').first().click();
    await expect(page).toHaveURL(/\/game\//);
  });

  /**
   * The recording is worth reaching from anywhere, not only from its own view.
   * A swing was one play, and the palette can open that play from any screen.
   */
  test('offers the day\'s biggest swing in the command palette, and opens its play', async ({ page }) => {
    await openTape(page, 0.3);
    await waitForMovement(page);
    await page.keyboard.press('1');

    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: /search/i }).fill('biggest swing');
    // by its own label: the palette's "filter by this text" command echoes the query back
    const option = page.getByRole('option', { name: /Open the day's biggest swing/ });
    await expect(option).toBeVisible();
    // it names the measurement and the game, and never calls it the play of the day
    await expect(option).toContainText(/\d+ points/);
    await expect(option).not.toContainText(/best|play of the day/i);
    await option.click();
    await expect(page).toHaveURL(/\/game\/.*[?&]play=\d+/);
  });

  test('is reachable from the layout control and the command palette', async ({ page }) => {
    await openReplay(page, { at: 0.3 });
    await expect(liveCards(page).first()).toBeVisible();
    await page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Tape' }).click();
    await expect(page).toHaveURL(/\/tape/);
    await expect(page.getByRole('heading', { name: 'The tape' })).toBeVisible();

    await page.keyboard.press('1');
    await expect(page).not.toHaveURL(/\/tape/);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: /search/i }).fill('tape');
    await page.getByRole('option', { name: /Open the tape/ }).click();
    await expect(page).toHaveURL(/\/tape/);
  });

  /**
   * The pulse is the lane on the game's own card. The property worth holding is
   * not that it draws something, but that it draws the SAME thing: one
   * recording, read twice, cannot disagree with itself about what the day did.
   */
  test('draws the same reading on a card as the tape draws in its lane', async ({ page }) => {
    const session = await openTape(page, 0.3);
    await waitForMovement(page);
    await control(page, session, { type: 'pause' });
    await page.waitForTimeout(1200);

    // the game the tape put first, and what it says that game has done
    const lane = page.locator('.tape-lane').first();
    const laneMovement = await lane.locator('.tape-lane__movement').innerText();
    const gameId = await lane.getAttribute('data-game');
    expect(gameId).toBeTruthy();

    await page.keyboard.press('1');
    const pulse = page.locator(`.card[data-game="${gameId}"] .tape-pulse`);
    await expect(pulse).toBeVisible();
    await expect(pulse.locator('title')).toContainText(`${laneMovement} points of movement`);
  });

  /**
   * The same property the lanes hold, on the view people actually live on. The
   * pulse takes a game id and nothing else, so a ticking clock cannot reach it;
   * this fails the moment someone passes it something that moves.
   */
  test('a stopped game never redraws its pulse', async ({ page }) => {
    const session = await openTape(page, 0.3);
    await waitForMovement(page);
    await control(page, session, { type: 'pause' });
    await page.waitForTimeout(1200);
    await page.keyboard.press('1');
    await expect(page.locator('.tape-pulse').first()).toBeVisible();

    await page.evaluate(() => document.querySelectorAll('.tape-pulse path').forEach((n, i) => ((n as HTMLElement & { __e2e?: number }).__e2e = i)));
    // long enough for several clock ticks and freshness updates to re-render the cards around it
    await page.waitForTimeout(3500);
    const redrawn = await page.evaluate(() => [...document.querySelectorAll('.tape-pulse path')].filter((n) => (n as HTMLElement & { __e2e?: number }).__e2e === undefined).length);
    expect(redrawn, 'the clock redrew a pulse').toBe(0);
  });

  test('says nothing on a card the provider reported no win probability for', async ({ page }) => {
    const session = await openTape(page, 0.3);
    await waitForMovement(page);
    /*
     * Stopped first. A lane reading "none" a second from now may be a game the
     * provider has simply not reported twice yet, and reading the lanes while
     * the clock runs and checking the card after would be two different moments
     * either side of its second reading.
     */
    await control(page, session, { type: 'pause' });
    await page.waitForTimeout(1200);
    const laneIds = await page.locator('.tape-lane').evaluateAll((els) => els.map((e) => e.getAttribute('data-game')));
    const movements = await page.locator('.tape-lane__movement').allInnerTexts();
    const silent = laneIds[movements.indexOf('none')];
    test.skip(!silent, 'every game in this replay reported a win probability');

    await page.keyboard.press('1');
    // the card is there, and simply has no pulse: no empty box, no flat line
    await expect(page.locator(`.card[data-game="${silent}"]`)).toBeVisible();
    await expect(page.locator(`.card[data-game="${silent}"] .tape-pulse`)).toHaveCount(0);
  });
});

/**
 * The recording is kept in session storage and dies with the tab, so a file is
 * the only way a day survives or reaches anyone else. The round trip is the
 * journey worth holding: written, read back, and shown as what it is.
 */
test.describe('a day as a file', () => {
  test('writes the day, reads it back, and says whose recording it is', async ({ page }) => {
    await openTape(page, 0.35);

    // Capture what the download would hold, rather than downloading it.
    const text = await page.evaluate(async () => {
      let blob: Blob | null = null;
      const create = URL.createObjectURL;
      const click = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (b: Blob) => ((blob = b), 'blob:captured');
      HTMLAnchorElement.prototype.click = function () {};
      document.querySelectorAll('button').forEach((b) => { if (/Save this day/.test(b.textContent ?? '')) b.click(); });
      await new Promise((r) => setTimeout(r, 200));
      URL.createObjectURL = create;
      HTMLAnchorElement.prototype.click = click;
      return blob ? await (blob as Blob).text() : '';
    });

    const file = JSON.parse(text);
    expect(file.format).toBe('gridiron.tape');
    expect(file.origin, 'a tape this browser recorded is a device tape').toBe('device');
    expect(file.order.length).toBeGreaterThan(1);
    expect(file.build).toBeTruthy();

    // Feed it straight back in.
    await page.setInputFiles('.tape__tools input[type=file]', { name: 'tape.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    const banner = page.locator('.tape__imported:not(.tape__imported--bad)');
    await expect(banner).toBeVisible();
    await expect(banner, 'an imported tape has to say it was recorded elsewhere').toContainText('an imported tape');
    await expect(banner).toContainText('another device');
    await expect(page.locator('.tape-lane').first()).toBeVisible();
    // Saving is not offered for somebody else's recording.
    await expect(page.getByRole('button', { name: 'Save this day' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Back to this device' }).click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save this day' })).toBeVisible();
  });

  test('refuses a file it cannot vouch for, and says why', async ({ page }) => {
    /*
     * On an empty tape, which is where somebody most wants to open a saved day
     * and also costs this suite no replay session of its own. The tape tests are
     * the heaviest journeys here and a second 60x replay for this was enough to
     * make the whole file miss its lanes under two workers.
     */
    await page.goto('/tape');
    await expect(page.getByRole('heading', { name: 'The tape' })).toBeVisible();
    for (const [body, says] of [
      ['not json at all', 'not JSON'],
      ['{"hello":"world"}', 'not a Gridiron tape'],
    ] as const) {
      await page.setInputFiles('.tape__tools input[type=file]', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(body) });
      const bad = page.locator('.tape__imported--bad');
      await expect(bad).toBeVisible();
      await expect(bad).toContainText(says);
      await bad.getByRole('button', { name: 'Dismiss' }).click();
    }
    // And nothing was shown as a tape.
    await expect(page.locator('.tape__imported:not(.tape__imported--bad)')).toHaveCount(0);
  });
});

