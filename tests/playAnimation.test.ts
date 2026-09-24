import { describe, expect, it } from 'vitest';
import type { PlayKind } from '../shared/model';
import { planPlayAnimation, playInputFromBrief, playInputFromEvent, TIMINGS, type PlanOptions } from '../shared/playAnimation';
import { play, spot } from './helpers/builders';

const live: PlanOptions = { reducedMotion: false, burst: false };
const inBand = (ms: number, band: readonly [number, number]) => ms >= band[0] && ms <= band[1];

describe('play animation planning', () => {
  it('does nothing for administrative entries or a play already shown', () => {
    const timeout = play({ n: 1, kind: 'timeout', offense: null, startProgress: null });
    expect(planPlayAnimation(null, playInputFromEvent(timeout), live)).toBeNull();
    const rush = play({ n: 2, kind: 'rush', startProgress: 20, endProgress: 26 });
    expect(planPlayAnimation({ id: rush.id, revision: rush.revision }, playInputFromEvent(rush), live)).toBeNull();
  });

  it('arcs a touchdown pass between the reported spots and then celebrates', () => {
    const td = play({ n: 3, kind: 'touchdown_pass', startProgress: 70, endProgress: 100, scoring: true });
    const a = planPlayAnimation(null, playInputFromEvent(td), live)!;
    expect(a).toMatchObject({ path: 'arc', effect: 'touchdown', fromYard: 70, toYard: 100, label: 'Touchdown', corrected: false });
    expect(inBand(a.durationMs, TIMINGS.major)).toBe(true);
    expect(inBand(a.effectMs, TIMINGS.major)).toBe(true);
  });

  it('sweeps runs and keeps short movement in the standard band', () => {
    const a = planPlayAnimation(null, playInputFromEvent(play({ n: 4, kind: 'rush', startProgress: 20, endProgress: 55 })), live)!;
    expect(a.path).toBe('sweep');
    expect(inBand(a.durationMs, TIMINGS.standard)).toBe(true);
  });

  it('marks incompletions, sacks, turnovers and penalties', () => {
    const plan = (kind: PlayKind, extra: Parameters<typeof play>[0] = { n: 0 }) =>
      planPlayAnimation(null, playInputFromEvent(play({ startProgress: 40, endProgress: 40, ...extra, kind })), live)!;
    expect(plan('pass_incomplete', { n: 5 })).toMatchObject({ path: 'incomplete', label: 'Incomplete', effect: null });
    expect(plan('sack', { n: 6, endProgress: 33 })).toMatchObject({ path: 'sack', label: 'Sack' });
    // An interception is thrown one way and taken back the other, so it is not
    // the same shape as a completed pass: a single arc from the throw to where
    // the return ended drew the ball flying to a spot behind the line.
    expect(plan('interception', { n: 7, endProgress: 70, endOffense: 'home', turnover: true })).toMatchObject({ path: 'pick', effect: 'turnover', label: 'Interception' });
    expect(plan('penalty', { n: 8, endProgress: 35, penalty: true })).toMatchObject({ effect: 'penalty', label: 'Penalty' });
  });

  it('settles a correction quietly and never celebrates again', () => {
    const original = play({ n: 9, kind: 'touchdown_rush', startProgress: 95, endProgress: 100, scoring: true, revision: 'a' });
    const revised = play({ n: 9, kind: 'touchdown_rush', startProgress: 95, endProgress: 100, scoring: true, revision: 'b' });
    const a = planPlayAnimation({ id: original.id, revision: 'a' }, playInputFromEvent(revised), live)!;
    expect(a).toMatchObject({ path: 'settle', effect: null, effectMs: 0, label: 'Play corrected', corrected: true });
    expect(inBand(a.durationMs, TIMINGS.micro)).toBe(true);
  });

  it('does not celebrate a touchdown the provider no longer counts as scoring', () => {
    const overturned = play({ n: 10, kind: 'touchdown_pass', startProgress: 90, endProgress: 90, scoring: false });
    expect(planPlayAnimation(null, playInputFromEvent(overturned), live)!.effect).toBeNull();
  });

  it('settles a burst of catch-up plays promptly', () => {
    const td = play({ n: 11, kind: 'touchdown_pass', startProgress: 10, endProgress: 100, scoring: true });
    const a = planPlayAnimation(null, playInputFromEvent(td), { reducedMotion: false, burst: true })!;
    expect(a).toMatchObject({ path: 'settle', effect: null, label: 'Touchdown' });
    expect(inBand(a.durationMs, TIMINGS.micro)).toBe(true);
  });

  it('replaces motion with a brief fade when motion is reduced, keeping the label', () => {
    const a = planPlayAnimation(null, playInputFromEvent(play({ n: 12, kind: 'punt', startProgress: 30, endProgress: 70, endOffense: 'home' })), { reducedMotion: true, burst: false })!;
    expect(a).toMatchObject({ path: 'settle', effect: null, durationMs: 150, label: 'Punt' });
  });

  it('does not move the ball when either spot is unknown', () => {
    const a = planPlayAnimation(null, playInputFromEvent(play({ n: 13, kind: 'rush', startProgress: null, endProgress: null })), live)!;
    expect(a.path).toBe('settle');
  });

  it('keeps scoreboard-only updates to a plain sweep between reported spots', () => {
    const input = playInputFromBrief({ id: '77', kind: 'pass_complete', description: 'Pass for 18', yards: 18, team: 'away' }, spot(40, 'away'), spot(58, 'away'));
    expect(planPlayAnimation(null, input, live)).toMatchObject({ path: 'sweep', fromYard: 40, toYard: 58 });
  });

  /**
   * The provider says what a kick was on the conversion rather than in the kind
   * of play, so an extra point used to slide along the ground like a run and a
   * good one lit nothing. These are the two readings that fix it.
   */
  it('kicks a kicked conversion, and lights the uprights when it was good', () => {
    const good = play({ n: 20, kind: 'extra_point', startProgress: 85, endProgress: 85, conversion: { kind: 'kick', result: 'good' }, scoring: true });
    expect(planPlayAnimation(null, playInputFromEvent(good), live)).toMatchObject({ path: 'kick', effect: 'field_goal', label: 'Extra point good' });

    const missed = play({ n: 21, kind: 'extra_point', startProgress: 85, endProgress: 85, conversion: { kind: 'kick', result: 'failed' } });
    expect(planPlayAnimation(null, playInputFromEvent(missed), live)).toMatchObject({ path: 'kick', effect: null });

    // A two-point try is a run or a pass and is never kicked.
    const two = play({ n: 22, kind: 'two_point', startProgress: 85, endProgress: 98, conversion: { kind: 'two-point', result: 'good' } });
    expect(planPlayAnimation(null, playInputFromEvent(two), live)!.path).not.toBe('kick');
  });

  it('never lets a blocked kick fly', () => {
    for (const [n, kind] of [[23, 'field_goal_blocked'], [24, 'punt_blocked']] as const) {
      const a = planPlayAnimation(null, playInputFromEvent(play({ n, kind, startProgress: 60, endProgress: 58 })), live)!;
      expect(a.path, kind).toBe('blocked');
      expect(inBand(a.durationMs, TIMINGS.standard), `${kind} ${a.durationMs}`).toBe(true);
    }
    // and a conversion the provider says was blocked is the same
    const ep = play({ n: 25, kind: 'extra_point', startProgress: 85, endProgress: 84, conversion: { kind: 'kick', result: 'blocked' } });
    expect(planPlayAnimation(null, playInputFromEvent(ep), live)).toMatchObject({ path: 'blocked', effect: null });
  });

  it('keeps every movement and effect inside the motion bands', () => {
    const kinds: PlayKind[] = ['rush', 'pass_complete', 'pass_incomplete', 'sack', 'interception', 'fumble_lost', 'punt', 'kickoff_return', 'field_goal_good', 'field_goal_missed', 'field_goal_blocked', 'punt_blocked', 'extra_point', 'two_point', 'touchdown_return', 'safety', 'penalty', 'other'];
    for (const [i, kind] of kinds.entries()) {
      for (const endProgress of [0, 12, 99]) {
        const a = planPlayAnimation(null, playInputFromEvent(play({ n: 100 + i, kind, startProgress: 50, endProgress })), live)!;
        const band = a.path === 'settle' ? TIMINGS.micro : a.path === 'arc' || a.path === 'kick' || a.path === 'pick' ? TIMINGS.major : TIMINGS.standard;
        expect(inBand(a.durationMs, band), `${kind} movement ${a.durationMs}`).toBe(true);
        expect(a.effectMs === 0 || inBand(a.effectMs, TIMINGS.standard) || inBand(a.effectMs, TIMINGS.major), `${kind} effect`).toBe(true);
      }
    }
  });
});
