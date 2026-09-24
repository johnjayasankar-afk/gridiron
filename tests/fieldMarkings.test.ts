import { describe, expect, it } from 'vitest';
import { FIELD } from '../shared/field';
import { NCAA_MARKINGS, NFL_MARKINGS, NUMBERED_LINES } from '../shared/fieldMarkings';

const feet = (yards: number) => Math.round(yards * 3 * 100) / 100;

describe('field markings from the rulebooks', () => {
  it('uses the standard field size', () => {
    expect(FIELD.total).toBe(120);
    expect(feet(FIELD.width)).toBe(160);
  });

  it('puts NFL hash rows 18 ft 6 in apart and NCAA rows 40 ft apart', () => {
    expect(feet(NFL_MARKINGS.hashInner * 2)).toBe(18.5);
    expect(feet(NCAA_MARKINGS.halfWidth - NCAA_MARKINGS.hashInner)).toBe(60);
    expect(feet(NFL_MARKINGS.halfWidth - NFL_MARKINGS.hashInner)).toBe(70.75);
    expect(feet(NCAA_MARKINGS.hashInner * 2)).toBe(40);
  });

  it('matches hash rows to the goal-post width in the NFL only', () => {
    expect(feet(NFL_MARKINGS.hashInner * 2)).toBe(feet(NFL_MARKINGS.goalpost.width));
    expect(feet(NCAA_MARKINGS.hashInner * 2)).not.toBe(feet(NCAA_MARKINGS.goalpost.width));
  });

  it('draws the NFL try mark and 8 pylons, and 12 pylons with no try mark for NCAA', () => {
    expect(NFL_MARKINGS.tryMark).toEqual({ fromGoal: 2, length: 1 });
    expect(NCAA_MARKINGS.tryMark).toBeNull();
    expect(NFL_MARKINGS.pylons).toHaveLength(8);
    expect(NCAA_MARKINGS.pylons).toHaveLength(12);
  });

  it('places numbers 12 yd (NFL bottom) and 9 yd (NCAA top) from the sideline', () => {
    expect(NFL_MARKINGS.numberNear).toBe(12);
    expect(NCAA_MARKINGS.numberNear + NCAA_MARKINGS.numberHeight).toBe(9);
    expect(NUMBERED_LINES.map((l) => l.label)).toEqual(['10', '20', '30', '40', '50', '40', '30', '20', '10']);
  });
});

describe('the ball', () => {
  /**
   * The one marking that is not on the field. NCAA rules require two white
   * stripes on the panels beside the laces so the ball can be picked up at
   * night; the NFL ball carries none. It is drawn from here like every other
   * rulebook value, so a college ball and a pro ball are not the same ball.
   */
  it('carries NCAA stripes and no NFL ones', () => {
    expect(NCAA_MARKINGS.ball.stripes).toBe(true);
    expect(NFL_MARKINGS.ball.stripes).toBe(false);
  });
});
