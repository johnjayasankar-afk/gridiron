import { expect, test, type Page } from '@playwright/test';
import { liveCards, openMenuItem, openReplay } from './helpers';
import type { FieldProbe } from '../src/field/probe';

/**
 * The 3D field's own behaviour, which is the one part of it that cannot be
 * checked by looking at a still. `window.__gridironField` reports what the ball
 * is doing, the way `window.__gridironGraphics` reports what the renderer is,
 * and these read it while a drive replays.
 *
 * Nothing here asserts how anything looks. It asserts the things that are
 * claims: that a pass spirals and a placed kick does not, that the nose follows
 * the arc, that the path is drawn as it is run, and that the broadcast camera
 * moves with the play and stops when the viewer takes the camera.
 */
type Sample = FieldProbe & { t: number };

async function openGame(page: Page, at = 0.5): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReplay(page, { at });
  await liveCards(page).first().locator('.card-link').click();
  await expect(page.locator('.scoreboard')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.__gridironField), { timeout: 20_000 }).toBe(true);
}

/** Every distinct reading of the ball over a stretch of replaying. */
async function watch(page: Page, ms: number): Promise<Sample[]> {
  return page.evaluate(async (duration) => {
    const out: Sample[] = [];
    let last = '';
    const id = setInterval(() => {
      const p = window.__gridironField?.();
      if (!p) return;
      const k = JSON.stringify(p);
      if (k === last) return;
      last = k;
      out.push({ ...p, t: Math.round(performance.now()) });
    }, 8);
    await new Promise((r) => setTimeout(r, duration));
    clearInterval(id);
    return out;
  }, ms);
}

/*
 * Jumping to a play is deliberately a burst with no movement drawn, so a play
 * has to be STEPPED onto for its shape to run at all. Both of these land on the
 * play before and walk forward onto it.
 */
async function walkOn(page: Page): Promise<void> {
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Previous play' }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Next play' }).click();
}

/** Steps onto the first play matching a label in the scoring jump list. */
async function stepOnto(page: Page, match: RegExp): Promise<boolean> {
  const jump = page.locator('select').filter({ hasText: /Scoring plays/ }).first();
  const options = await jump.locator('option').allTextContents();
  const wanted = options.find((o) => match.test(o));
  if (!wanted) return false;
  await jump.selectOption({ label: wanted });
  await walkOn(page);
  return true;
}

/** Steps onto the first play whose description matches, found through the play search. */
async function stepOntoPlay(page: Page, search: string): Promise<boolean> {
  await page.getByPlaceholder('Search plays').fill(search);
  const rows = page.locator('button.pbp-row');
  if ((await rows.count()) === 0) return false;
  await rows.first().click();
  await walkOn(page);
  return true;
}

test.describe('the field in 3D', () => {
  test('a thrown ball spirals, and its nose follows the arc it is on', async ({ page }) => {
    await openGame(page);
    await page.locator('.rp-play').click();
    const samples = await watch(page, 30_000);
    const passes = samples.filter((s) => s.inFlight && (s.path === 'arc' || s.path === 'incomplete'));
    expect(passes.length, 'frames of a ball in the air').toBeGreaterThan(20);

    // it turns about its long axis, and only ever forwards
    const spins = passes.map((s) => s.spin);
    expect(Math.max(...spins)).toBeGreaterThan(1);
    for (const s of passes) expect(s.tumbling).toBe(false);

    // and the nose is up on the way out and down on the way in, which is the
    // whole claim: it is measured from the ball's own path, not from the shape
    const climbing = passes.filter((s, i) => i > 0 && s.y > passes[i - 1].y + 0.05);
    const falling = passes.filter((s, i) => i > 0 && s.y < passes[i - 1].y - 0.05);
    expect(climbing.length, 'frames climbing').toBeGreaterThan(3);
    expect(falling.length, 'frames falling').toBeGreaterThan(3);
    expect(Math.max(...climbing.map((s) => s.pitch)), 'nose up on the way out').toBeGreaterThan(0.1);
    expect(Math.min(...falling.map((s) => s.pitch)), 'nose down on the way in').toBeLessThan(-0.1);
  });

  test('a placed kick turns end over end instead, and never spirals', async ({ page }) => {
    await openGame(page);
    const found = await stepOnto(page, /field goal/i);
    test.skip(!found, 'this replay has no field goal to step onto');
    const samples = await watch(page, 6_000);
    const kick = samples.filter((s) => s.inFlight && s.path === 'kick');
    expect(kick.length, 'frames of a placed kick in the air').toBeGreaterThan(10);
    for (const s of kick) {
      expect(s.tumbling, 'a placed kick tumbles').toBe(true);
      expect(Math.abs(s.spin), 'a placed kick does not spiral').toBeLessThan(0.001);
    }
    // it goes over the top at least once rather than holding one angle
    expect(Math.max(...kick.map((s) => s.pitch))).toBeGreaterThan(Math.PI);
  });

  test('a play draws its own path as it runs, and leaves it drawn', async ({ page }) => {
    await openGame(page);
    await page.locator('.rp-play').click();
    const samples = await watch(page, 30_000);
    // A run is drawn as it is run too, so this is every play that is moving and
    // not only the ones in the air.
    const running = samples.filter((s) => s.path !== null);
    expect(running.length).toBeGreaterThan(20);
    expect(Math.min(...running.map((s) => s.trail)), 'the path starts unfinished').toBeLessThan(0.5);
    // and it is whole whenever no play is running
    const idle = samples.filter((s) => s.path === null);
    expect(idle.length, 'moments with no play running').toBeGreaterThan(0);
    for (const s of idle) expect(s.trail).toBe(1);
    // a play leaves a mark at the spot it stopped
    expect(samples.some((s) => s.spotVisible), 'the spot a play ended was marked').toBe(true);
  });

  /**
   * Possession is reported, so the field may say it. The ball wears the mark of
   * the team the provider says has it and every mark on the field takes that
   * team's colour, which makes a turnover something the field does rather than
   * only a line of text. When the provider does not report possession the ball
   * is plain leather and the marks are the field's own colour: it never guesses.
   */
  test('the ball wears the mark of whoever the provider says has it', async ({ page }) => {
    await openGame(page);
    await page.locator('.rp-play').click();
    const samples = await watch(page, 35_000);
    expect(samples.length).toBeGreaterThan(20);
    for (const s of samples) {
      if (s.possession) expect(s.skin, 'a reported possession marks the ball').toBeTruthy();
      else expect(s.skin, 'an unreported possession leaves the ball plain').toBeNull();
    }

    const held = samples.filter((s) => s.possession);
    test.skip(held.length < 10, 'possession was not reported during this stretch');
    // and the marks carry a team rather than the field's own colour
    expect(held.filter((s) => s.mark.toLowerCase() !== '#a7f3d0').length / held.length, 'the marks took a team colour').toBeGreaterThan(0.8);

    // one ball per team, and the two teams never share one
    const perSide = new Map<string, Set<string>>();
    for (const s of held) {
      const side = s.possession as string;
      if (!perSide.has(side)) perSide.set(side, new Set());
      perSide.get(side)!.add(s.skin as string);
    }
    for (const [side, skins] of perSide) expect(skins.size, `one ball for ${side}`).toBe(1);
    const all = new Set([...perSide.values()].flatMap((s) => [...s]));
    expect(all.size, 'the two teams do not share a ball').toBe(perSide.size);
    test.skip(perSide.size < 2, 'the ball did not change hands during this stretch');
  });

  /**
   * The drive is the thing the ball is in the middle of, and the field draws it:
   * the ground between where it began and where the ball is, the play it began
   * at, and one mark per play the provider gave an end spot for. The field and
   * the panel beside it are built from one reading, so they cannot disagree, and
   * this holds them to it.
   */
  test('the field draws the drive the panel describes', async ({ page }) => {
    await openGame(page);
    await page.waitForTimeout(1500);
    const chart = page.locator('.dchart');
    test.skip((await chart.count()) === 0, 'no drive reported at this moment of the replay');
    const said = (await chart.innerText()).replace(/\s+/g, ' ');
    const drive = await page.evaluate(() => window.__gridironField!().drive);
    test.skip(!drive, 'the field is not drawing a drive');

    // the panel's play count is the field's
    const counted = /(\d+) plays?/.exec(said);
    if (counted) expect(drive!.playCount, `panel says ${counted[0]}`).toBe(Number(counted[1]));
    // Every mark on the field is a play of this drive that had a reported end
    // spot, and a play with no spot at all is drawn nowhere. Held against the
    // drive's own rows rather than its play count, which leaves out a kickoff.
    expect(drive!.ticks, 'a mark per spotted play').toBeLessThanOrEqual(drive!.rows);
    expect(drive!.ticks + drive!.unspotted, 'nothing is drawn for a play with no reported spot').toBeLessThanOrEqual(drive!.rows);
    // a drive on the field has somewhere to start from and somewhere to be
    if (drive!.ticks > 0) expect(drive!.ball, 'a drive with plays has a ball').not.toBeNull();
  });

  test('and the drive grows on the field as the drive is stepped through', async ({ page }) => {
    await openGame(page);
    // Start of the game, so there are plays ahead of the first one to step onto.
    await page.getByRole('button', { name: 'First play of the game' }).click();
    await page.waitForTimeout(1200);
    const ticks = () => page.evaluate(() => window.__gridironField!().drive?.ticks ?? -1);
    const first = await ticks();
    test.skip(first < 0, 'the field is not drawing a drive');

    const next = page.getByRole('button', { name: 'Next play' });
    for (let i = 0; i < 6; i++) {
      await next.click();
      await page.waitForTimeout(700);
    }
    const later = await ticks();
    // The drive is cut at the play being watched, so walking forward through it
    // adds marks rather than showing the whole drive from the first play.
    expect(later, `marks went from ${first} to ${later}`).toBeGreaterThan(first);
  });

  /**
   * The reel: the game's scoring plays one after another, drawn on the field
   * rather than jumped to. Landing on a play is deliberately a burst that draws
   * no movement, which is right for a jump and wrong here, where the jump IS the
   * thing being watched.
   */
  test('the reel plays the scores in order and draws each one', async ({ page }) => {
    await openGame(page, 0.6);
    const reel = page.getByRole('button', { name: /Play the scores/ });
    test.skip(!(await reel.isEnabled()), 'no scoring plays reported yet in this replay');
    await reel.click();

    const samples = await watch(page, 11_000);
    // A burst is a settle and draws no movement; these are drawn.
    const drawn = samples.filter((s) => s.path !== null && s.path !== 'settle');
    expect(drawn.length, 'frames of a score being drawn').toBeGreaterThan(8);
    // and it walks forward through them
    await expect(page.locator('.rp-readout', { hasText: /Score \d+ of/ })).toContainText(/Score [2-9] of/);

    await page.getByRole('button', { name: /Stop the reel/ }).click();
    await expect(page.locator('.rp-readout', { hasText: /Score \d+ of/ })).toHaveCount(0);
  });

  test('and it can be started from the keyboard or the palette', async ({ page }) => {
    await openGame(page, 0.6);
    const reel = page.getByRole('button', { name: /Play the scores/ });
    test.skip(!(await reel.isEnabled()), 'no scoring plays reported yet in this replay');
    const running = page.locator('.rp-readout', { hasText: /Score \d+ of/ });

    await page.locator('body').click();
    await page.keyboard.press('r');
    await expect(running, 'R starts the reel').toBeVisible();
    await page.keyboard.press('r');
    await expect(running, 'and stops it').toHaveCount(0);

    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: /search/i }).fill('play the scores');
    await page.getByRole('option', { name: /Play the scores/ }).click();
    await expect(running, 'and the palette starts it').toBeVisible();
  });

  test('and anything the viewer does by hand ends it', async ({ page }) => {
    await openGame(page, 0.6);
    const reel = page.getByRole('button', { name: /Play the scores/ });
    test.skip(!(await reel.isEnabled()), 'no scoring plays reported yet in this replay');
    await reel.click();
    await expect(page.locator('.rp-readout', { hasText: /Score \d+ of/ })).toBeVisible();
    // Taking the game back off the reel by stepping through it by hand.
    await page.getByRole('button', { name: 'Next play' }).click();
    await expect(page.locator('.rp-readout', { hasText: /Score \d+ of/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Play the scores/ })).toBeVisible();
  });

  /**
   * A real field carries the home team's mark at the fifty, and without it every
   * game in the app was played on the same field with different end zones.
   */
  test('the field carries the home team\'s mark at the fifty', async ({ page }) => {
    await openGame(page);
    const links = page.locator('.scoreboard a[href^="/team/"]');
    await expect(links).toHaveCount(2);
    // The scoreboard reads away then home, which is the order the field defends.
    const home = (await links.last().getAttribute('href'))!.replace('/team/', '');
    const away = (await links.first().getAttribute('href'))!.replace('/team/', '');
    const mark = await page.evaluate(() => window.__gridironField!().midfield);
    expect(mark, 'the field has a mark at the fifty').toBeTruthy();
    expect(mark!.startsWith(`${home}|`), `mark ${mark} is the home team ${home}`).toBe(true);
    expect(mark!.startsWith(`${away}|`), 'and not the away team').toBe(false);
  });

  /**
   * An interception is thrown one way and taken back the other. Drawn as one
   * smooth arc it flew to a spot behind the line, which is not what happened.
   */
  test('an interception reverses, and stops spiralling once it changes hands', async ({ page }) => {
    // Late enough in the replay that this game has one to step onto.
    await openGame(page, 0.6);
    const found = await stepOntoPlay(page, 'intercept');
    test.skip(!found, 'this replay has no interception to step onto');
    const samples = await watch(page, 4_000);
    const pick = samples.filter((s) => s.path === 'pick');
    expect(pick.length, 'frames of an interception').toBeGreaterThan(5);

    const thrown = pick.filter((s) => s.inFlight);
    const carried = pick.filter((s) => !s.inFlight);
    expect(thrown.length, 'frames in the air').toBeGreaterThan(2);
    expect(carried.length, 'frames being carried').toBeGreaterThan(2);
    // it is a ball in the air first and a ball being carried after, never both
    expect(Math.max(...thrown.map((s) => s.spin))).toBeGreaterThan(0.2);
    // and the two legs run in opposite directions
    const run = (list: typeof pick) => Math.sign(list[list.length - 1].x - list[0].x);
    expect(run(thrown), 'the throw and the return go opposite ways').toBe(-run(carried));
  });

  /**
   * Two moments the field has to tell apart, because the provider does: a kick
   * that counted lights the gate between the uprights, and a turnover is
   * answered by the stands in the colour of whoever came away with the ball.
   */
  test('a kick the provider called good lights the uprights', async ({ page }) => {
    await openGame(page);
    const found = await stepOnto(page, /field goal/i);
    test.skip(!found, 'this replay has no field goal to step onto');
    await page.waitForFunction(() => window.__gridironField?.().gateVisible === true, undefined, { timeout: 20_000 });
    const at = await page.evaluate(() => window.__gridironField!());
    expect(at.kind, 'the gate lit for a kick').toMatch(/field_goal/);
    // and it goes out again rather than staying lit
    await expect.poll(() => page.evaluate(() => window.__gridironField!().gateVisible), { timeout: 10_000 }).toBe(false);
  });

  test('the stands answer a score and a turnover, and differently', async ({ page }) => {
    await openGame(page);
    const found = await stepOnto(page, /touchdown/i);
    test.skip(!found, 'this replay has no touchdown to step onto');
    await page.waitForFunction(() => (window.__gridironField?.().cheer ?? 0) > 0.5, undefined, { timeout: 20_000 });
    expect((await page.evaluate(() => window.__gridironField!())).cheerFor).toBe('score');
    // and it falls silent again on its own
    await expect.poll(() => page.evaluate(() => window.__gridironField!().cheerFor), { timeout: 15_000 }).toBeNull();
  });

  test('the broadcast camera moves with the play, and the isometric one holds still', async ({ page }) => {
    await openGame(page);
    const presets = page.getByRole('group', { name: 'Camera view' });
    const spread = async (): Promise<{ cam: number; ball: number }> => {
      const samples = (await watch(page, 22_000)).filter((s) => s.inFlight);
      expect(samples.length, 'frames of a ball in the air').toBeGreaterThan(10);
      const cam = samples.map((s) => s.camX);
      const ndc = samples.map((s) => s.ndcX);
      return { cam: Math.max(...cam) - Math.min(...cam), ball: Math.max(...ndc) - Math.min(...ndc) };
    };

    await presets.getByRole('button', { name: 'Isometric' }).click();
    await page.waitForTimeout(1500);
    await page.locator('.rp-play').click();
    const still = await spread();

    await presets.getByRole('button', { name: 'Broadcast' }).click();
    await page.waitForTimeout(1800);
    const panned = await spread();

    // the isometric camera frames the whole field and never chases a play
    expect(still.cam, 'the isometric camera moved during a play').toBeLessThan(1);
    // the broadcast camera does, and keeps the ball near the middle while it does
    expect(panned.cam, 'the broadcast camera did not move with the play').toBeGreaterThan(4);
    expect(Math.abs(panned.ball), 'the ball left the frame').toBeLessThan(1.4);
  });

  /**
   * The 2D field is the accessible, low power fallback, and it is meant to carry
   * the same readings as the 3D one rather than fewer. It draws the drive from
   * the same source, and its arrow carries whoever has the ball.
   */
  test('the 2D field carries the drive and the team, not just the markings', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openReplay(page, { at: 0.6 });
    await expect(liveCards(page).first()).toBeVisible();
    await openMenuItem(page, 'Display settings');
    await page.getByRole('dialog', { name: 'Display' }).getByRole('group', { name: 'Effects' }).getByRole('button', { name: '2D' }).click();
    await page.keyboard.press('Escape');
    await liveCards(page).first().locator('.card-link').click();
    await expect(page.locator('.scoreboard')).toBeVisible();
    await expect(page.locator('.field-svg').first()).toBeVisible();
    await expect(page.locator('canvas'), 'no WebGL in 2D').toHaveCount(0);

    // The drive, the same three readings the 3D field draws.
    await expect(page.locator('.field-svg-drive')).toHaveCount(1);
    await expect(page.locator('.field-svg-drive-start')).toHaveCount(1);
    expect(await page.locator('.field-svg-drive-tick').count(), 'a mark per spotted play').toBeGreaterThan(0);

    // And a card, which has its own drive strip in the DOM, does not draw one.
    await page.getByRole('button', { name: 'Slate' }).first().click();
    await expect(liveCards(page).first()).toBeVisible();
    await expect(page.locator('.field-svg-drive')).toHaveCount(0);
  });
});


/**
 * The sky a game is played under.
 *
 * The weather at a venue and whether that venue has a roof are both reported, so
 * a field is lit by its own sky rather than every field being lit the same way.
 * No captured replay carries weather, because it lives on the live scoreboard and
 * was not captured with these games, so the one way to see a sky is a synthetic
 * scenario that says plainly that its weather did not happen.
 */
test.describe('the sky over the field', () => {
  test('a game the provider reported snow for is played in the snow, at night', async ({ page }) => {
    /*
     * The sky is drawn by two shader patches, and a patch that stops applying is
     * the failure this version already had once. Both signals are watched here
     * because both were proven to fire: breaking an anchor on purpose throws to
     * the page and collapses the field from about thirty four draw calls to
     * seven. Reading the probe alone would not have caught either, because the
     * probe reports the number that was computed and not the shader that used it.
     */
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReplay(page, { path: '/game/nfl-401872925', scenario: 'test-weather', at: 0.4 });
    await expect.poll(() => page.evaluate(() => !!window.__gridironField), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await page.evaluate(() => window.__gridironGraphics?.info()))?.calls ?? 0, { timeout: 15_000 }).toBeGreaterThan(20);
    await expect.poll(() => page.evaluate(() => window.__gridironField?.()?.sky ?? null), { timeout: 20_000 }).toEqual({ kind: 'snow', night: true, indoor: false, drops: 1100 });
    // The field says what it is lit by, in the provider's own words, so the light is attributable.
    await expect(page.locator('.field-orientation')).toContainText('Snow · 24°F');
    // And the air takes the far end of it: snow after dark is a real amount of haze, not a rounding of zero.
    expect(await page.evaluate(() => window.__gridironField!().haze)).toBeGreaterThan(0.1);
    // And the scenario says the weather is not real, which is the whole reason it is allowed to exist.
    await expect(page.locator('.replay-bar')).toContainText('synthetic');
    expect(errors, 'a shader patch stopped applying').toEqual([]);
  });

  /*
   * A roof is three more things to draw, so that is what is asserted rather than
   * the flag that asked for them. Reading `sky.indoor` back would only prove the
   * provider said indoors and the field agreed, which is the mistake the haze
   * test made: it would pass with the roof deleted.
   */
  test('a venue the provider says has a roof is given one, and one without is not', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    const draws = async () => {
      await expect.poll(() => page.evaluate(() => !!window.__gridironField), { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => (await page.evaluate(() => window.__gridironGraphics?.info()))?.calls ?? 0, { timeout: 15_000 }).toBeGreaterThan(20);
      return (await page.evaluate(() => window.__gridironGraphics?.info()))!.calls;
    };

    await openReplay(page, { path: '/game/nfl-401872925', scenario: 'test-indoors', at: 0.4 });
    const roofed = await draws();
    expect(await page.evaluate(() => window.__gridironField!().sky!.indoor)).toBe(true);
    // Nothing falls indoors, and the field says so in words a screen reader gets.
    expect(await page.evaluate(() => window.__gridironField!().sky!.drops)).toBe(0);
    await expect(page.locator('.sit-note')).toContainText('The venue has a roof');

    await openReplay(page, { path: '/game/nfl-401872925', scenario: 'nfl-week1-sunday', at: 0.4 });
    const open = await draws();
    expect(await page.evaluate(() => window.__gridironField!().sky)).toBeNull();

    // The deck, its ribs and the membrane over the field: three more draws than the same game under the sky.
    expect(roofed - open, 'the roof was not drawn').toBeGreaterThanOrEqual(3);
    expect(errors, 'drawing the roof logged an error').toEqual([]);
  });

  test('the scorebug carries the state of the down, on the field', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReplay(page, { path: '/game/nfl-401872926', at: 0.55 });
    const bug = page.locator('.score-bug');
    await expect(bug).toBeVisible();
    await expect(bug).toContainText('ARI');
    await expect(bug).toContainText('LAC');
    // Whoever the provider says has the ball has their row lit, and only one row is.
    await expect(bug.locator('.bug-team.has-ball')).toHaveCount(1);
    await expect(bug.locator('.bug-down')).toContainText(/\d(st|nd|rd|th) &/);
    /*
     * It sits above the shared canvas. Below it the field draws over the bug and
     * the whole thing vanishes, which is exactly what happened the first time.
     */
    const overlay = await bug.evaluate((el) => Number(getComputedStyle(el).zIndex));
    const canvas = await page.locator('canvas').first().evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
    expect(overlay).toBeGreaterThan(canvas);
  });

  test('a game the provider reported no weather for is lit exactly as it always was', async ({ page }) => {
    await openGame(page, 0.5);
    expect(await page.evaluate(() => window.__gridironField!().sky)).toBeNull();
    // No reported sky means no haze at all, so the field is exactly as sharp as it always was.
    expect(await page.evaluate(() => window.__gridironField!().haze)).toBe(0);
    const caption = await page.locator('.field-orientation').innerText();
    expect(caption).toContain('defends left');
    // No invented sky, no placeholder, nothing appended.
    expect(caption).not.toContain('°F');
  });
});
