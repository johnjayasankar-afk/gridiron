import { describe, expect, it } from 'vitest';
import { fieldSoundFor } from '../shared/fieldSound';
import type { AnimationEffect, AnimationPath, PlayAnimation } from '../shared/playAnimation';

const plan = (o: Partial<PlayAnimation> = {}): PlayAnimation =>
  ({
    key: 'k', playId: 'p', kind: 'rush', path: 'sweep' as AnimationPath, effect: null as AnimationEffect,
    fromYard: 40, toYard: 46, offenseBefore: 'away', offenseAfter: 'away',
    durationMs: 400, effectMs: 0, label: null, corrected: false, firstDown: false, ...o,
  }) as PlayAnimation;

/**
 * A sound is only ever a restatement of something the provider reported, and a
 * play that was not drawn moving makes none: a burst of delayed plays and a jump
 * to a play both settle without movement, and neither should fire a run of
 * noises at somebody who was not watching for it.
 */
describe('what a play sounds like', () => {
  it('says nothing for a play that was not drawn moving', () => {
    expect(fieldSoundFor(null)).toBeNull();
    expect(fieldSoundFor(plan({ path: 'settle' }))).toBeNull();
    // A correction is the record being put right, not something happening.
    expect(fieldSoundFor(plan({ corrected: true, effect: 'touchdown' }))).toBeNull();
    // A review is a question; it has its own mark on the field.
    expect(fieldSoundFor(plan({ effect: 'review' }))).toBeNull();
  });

  it('names the sound from the reported effect', () => {
    expect(fieldSoundFor(plan({ effect: 'touchdown' }))).toMatchObject({ kind: 'touchdown', strength: 1 });
    expect(fieldSoundFor(plan({ effect: 'field_goal' }))).toMatchObject({ kind: 'fieldGoal' });
    expect(fieldSoundFor(plan({ effect: 'turnover' }))).toMatchObject({ kind: 'turnover' });
    expect(fieldSoundFor(plan({ effect: 'safety' }))).toMatchObject({ kind: 'turnover' });
    expect(fieldSoundFor(plan({ effect: 'penalty' }))).toMatchObject({ kind: 'penalty' });
    expect(fieldSoundFor(plan({ effect: 'first_down' }))).toMatchObject({ kind: 'firstDown' });
    expect(fieldSoundFor(plan())).toMatchObject({ kind: 'land' });
  });

  it('takes how much of it there is from the ground the play covered', () => {
    const short = fieldSoundFor(plan({ fromYard: 40, toYard: 42 }))!;
    const long = fieldSoundFor(plan({ fromYard: 20, toYard: 70 }))!;
    expect(short.kind).toBe(long.kind);
    expect(short.strength).toBeLessThan(long.strength);
    expect(long.strength).toBe(1);
    // A play that lost ground is as loud as one that gained the same, because
    // the reading is how far the ball went, not which way.
    expect(fieldSoundFor(plan({ fromYard: 40, toYard: 30 }))!.strength).toBe(fieldSoundFor(plan({ fromYard: 30, toYard: 40 }))!.strength);
    // A play with no reported spots is as quiet as it gets, not silent.
    expect(fieldSoundFor(plan({ fromYard: null, toYard: null }))).toMatchObject({ kind: 'land', strength: 0 });
  });

  it('never lets a score be quiet because it was short', () => {
    expect(fieldSoundFor(plan({ effect: 'touchdown', fromYard: 99, toYard: 100 }))!.strength).toBe(1);
    expect(fieldSoundFor(plan({ effect: 'first_down', fromYard: 40, toYard: 41 }))!.strength).toBeGreaterThanOrEqual(0.4);
  });
});
