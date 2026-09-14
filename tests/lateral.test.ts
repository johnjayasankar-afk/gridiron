import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplayProvider, VirtualClock } from '../server/replay/lab';
import { detailWithLateral, lateralsFor, snapLateral, syntheticLaterals } from '../server/replay/lateral';
import { FixtureStore, SCENARIOS } from '../server/replay/scenarios';
import { buildTimeline } from '../server/replay/timeline';
import { FIELD, HASH_LATERAL, isValidLateral, lateralZ } from '../shared/field';
import { planPlayAnimation, playInputFromEvent } from '../shared/playAnimation';
import { FieldSvg } from '../src/field/FieldSvg';
import { detail, game, play, situation } from './helpers/builders';
import { FIXTURES, fixture } from './helpers/fixtures';

type Raw = Record<string, any>;

describe('lateral position frame', () => {
  it('runs from the far sideline (0) to the near sideline (1), centred when unknown', () => {
    expect(lateralZ(0)).toBeCloseTo(-FIELD.width / 2);
    expect(lateralZ(1)).toBeCloseTo(FIELD.width / 2);
    expect(lateralZ(0.5)).toBe(0);
    expect(lateralZ(null)).toBe(0);
    for (const bad of [1.2, -0.1, Number.NaN, '0.3', undefined]) {
      expect(isValidLateral(bad)).toBe(false);
      expect(lateralZ(bad as never)).toBe(0);
    }
    expect(HASH_LATERAL.nfl[0]).toBeCloseTo(0.4422, 3);
    expect(HASH_LATERAL.cfb).toEqual([0.375, 0.625]);
  });
});

describe('synthetic lateral estimates', () => {
  const event = fixture<Raw>('scoreboard/nfl-20260913.json').events.find((e: Raw) => e.id === '401872925');
  const summary = fixture<Raw>('summary/nfl-401872925.json');
  const tl = buildTimeline('nfl', event, summary, ['NFL']);
  const homeId = String(summary.header.competitions[0].competitors.find((c: Raw) => c.homeAway === 'home').team.id);
  const laterals = syntheticLaterals(tl);

  it('moves a described play toward that side of the offense, mirrored for the home offense', () => {
    const passes = tl.plays.filter((p) => /\bshort right\b/i.test(String(p.raw.text)) && !/kickoff|extra point|two-point/i.test(String(p.raw.type?.text)));
    expect(passes.length).toBeGreaterThan(0);
    for (const p of passes) {
      const home = String(p.raw.start?.team?.id) === homeId;
      expect(laterals.get(String(p.raw.id))?.end).toBeCloseTo(home ? 0.3 : 0.7);
    }
    const middle = tl.plays.find((p) => /\bup the middle\b/i.test(String(p.raw.text)));
    if (middle) expect(laterals.get(String(middle.raw.id))?.end).toBe(0.5);
  });

  it('spots each snap between the hashes and restarts kicks from the centre', () => {
    const [low, high] = HASH_LATERAL.nfl;
    for (let i = 1; i < tl.plays.length; i++) {
      const pair = laterals.get(String(tl.plays[i].raw.id))!;
      expect(pair.start).toBeGreaterThanOrEqual(Math.min(low, 0.5));
      expect(pair.start).toBeLessThanOrEqual(Math.max(high, 0.5));
      if (/kickoff/i.test(String(tl.plays[i].raw.type?.text))) expect(pair).toMatchObject({ start: 0.5, end: null });
    }
    expect(snapLateral('nfl', { start: 0.5, end: 0.1 })).toBeCloseTo(low);
    expect(snapLateral('cfb', { start: 0.5, end: 0.55 })).toBe(0.55);
    expect(snapLateral('nfl', undefined)).toBeNull();
  });

  it('decorates normalized detail and its live situation only for the estimates given', () => {
    const summaryGame = game({ situation: situation({ possession: 'away', progress: 40 }) });
    const plays = [play({ n: 1, startProgress: 30, endProgress: 40 })];
    const decorated = detailWithLateral(detail(summaryGame, plays), new Map([['p1', { start: 0.5, end: 0.2 }]]));
    expect(decorated.plays[0].start?.spot.lateral).toBe(0.5);
    expect(decorated.plays[0].end?.spot.lateral).toBe(0.2);
    expect(decorated.summary.situation?.spot.lateral).toBeCloseTo(HASH_LATERAL.nfl[0]);
    expect(detailWithLateral(detail(summaryGame, plays), new Map()).plays[0].end?.spot.lateral).toBeNull();
  });
});

describe('lateral position test scenario', () => {
  const store = new FixtureStore(FIXTURES);

  it('is listed as synthetic and marks its timeline', () => {
    const def = SCENARIOS.find((s) => s.id === 'test-lateral-position');
    expect(def?.synthetic).toBe(true);
    expect(def?.label).toMatch(/synthetic/i);
    const built = def!.build(store)!;
    expect(built.limitations.join(' ')).toMatch(/estimated/i);
    expect(lateralsFor(built.games[0])).not.toBeNull();
  });

  it('puts estimates on the replayed game, while a captured replay keeps lateral unknown', async () => {
    const def = SCENARIOS.find((s) => s.id === 'test-lateral-position')!;
    const built = def.build(store)!;
    const clock = new VirtualClock(built.startAt, built.endAt, def.speed, Date.now, false);
    clock.seek(0.7);
    const provider = new ReplayProvider(built, clock, def);
    const result = await provider.fetchDetail(built.games[0].id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const spots = result.detail.plays.flatMap((p) => [p.start?.spot.lateral, p.end?.spot.lateral]).filter((v) => v !== null && v !== undefined);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.every(isValidLateral)).toBe(true);

    const captured = SCENARIOS.find((s) => s.id === 'nfl-week1-sunday')!;
    const capturedBuilt = captured.build(store)!;
    const capturedClock = new VirtualClock(capturedBuilt.startAt, capturedBuilt.endAt, captured.speed, Date.now, false);
    capturedClock.seek(0.5);
    const real = await new ReplayProvider(capturedBuilt, capturedClock, captured).fetchDetail(capturedBuilt.games[0].id);
    if (real.ok) expect(real.detail.plays.every((p) => p.start?.spot.lateral == null && p.end?.spot.lateral == null)).toBe(true);
  });
});

describe('drawing a lateral position', () => {
  it('carries the positions into the play animation', () => {
    const p = play({ n: 1, kind: 'rush', startProgress: 30, endProgress: 38, yards: 8 });
    const withLateral = { ...p, start: { ...p.start!, spot: { ...p.start!.spot, lateral: 0.5 } }, end: { ...p.end!, spot: { ...p.end!.spot, lateral: 0.15 } } };
    const plan = planPlayAnimation(null, playInputFromEvent(withLateral), { reducedMotion: false, burst: false });
    expect(plan).toMatchObject({ fromLateral: 0.5, toLateral: 0.15 });
    expect(planPlayAnimation(null, playInputFromEvent(p), { reducedMotion: false, burst: false })?.toLateral).toBeUndefined();
  });

  it('places the 2D ball across the field only when the position is known', () => {
    const base = situation({ possession: 'away', progress: 40 });
    const markup = (lateral: number | null) => renderToStaticMarkup(createElement(FieldSvg, { game: game(), situation: { ...base, spot: { ...base.spot, lateral } } }));
    const cy = (lateral: number) => `cy="${(2.2 + 160 / 6 + lateralZ(lateral)) * 10}"`;
    expect(markup(0.25)).toContain(cy(0.25));
    expect(markup(null)).toContain(`cy="${(2.2 + 160 / 6) * 10}"`);
  });
});
