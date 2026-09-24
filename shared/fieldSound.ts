/**
 * Which sound a play makes, decided from the reported play alone.
 *
 * Nothing here plays anything; it is the reading, kept apart from the playing so
 * it can be tested. A sound is only ever a restatement of something the provider
 * reported, and a play that was not drawn moving makes none: a burst of delayed
 * plays and a jump to a play both settle without movement, and neither should
 * fire a run of noises at somebody.
 */
import type { PlayAnimation } from './playAnimation.js';

export type FieldSoundKind = 'land' | 'firstDown' | 'touchdown' | 'fieldGoal' | 'turnover' | 'penalty';

export interface FieldSound {
  kind: FieldSoundKind;
  /** 0 to 1, from the ground the play covered. A two yard run is quiet; a long one is not. */
  strength: number;
}

/** Yards at which a play is as loud as it gets. */
const FULL_YARDS = 35;

export function fieldSoundFor(animation: PlayAnimation | null): FieldSound | null {
  if (!animation) return null;
  // A correction is not an event happening; it is the record being put right.
  if (animation.corrected) return null;
  // A settle is a play that was not drawn moving: a jump, or a burst of plays
  // arriving at once after a gap.
  if (animation.path === 'settle') return null;

  const yards = animation.fromYard !== null && animation.toYard !== null ? Math.abs(animation.toYard - animation.fromYard) : 0;
  const strength = Math.min(1, yards / FULL_YARDS);

  switch (animation.effect) {
    case 'touchdown':
      return { kind: 'touchdown', strength: 1 };
    case 'field_goal':
      return { kind: 'fieldGoal', strength: 1 };
    case 'safety':
      return { kind: 'turnover', strength: 1 };
    case 'turnover':
      return { kind: 'turnover', strength: Math.max(0.6, strength) };
    case 'penalty':
      return { kind: 'penalty', strength: 0.6 };
    case 'first_down':
      return { kind: 'firstDown', strength: Math.max(0.4, strength) };
    case 'review':
      // A review is a question, not an event. It has its own mark on the field.
      return null;
    default:
      return { kind: 'land', strength };
  }
}
