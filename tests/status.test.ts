import { describe, expect, it } from 'vitest';
import { normalizeStatus } from '../server/providers/espn/normalize';
import { statusShort } from '../shared/format';

/** Status objects shaped like real in-game captures of the ESPN scoreboard. */
const status = (name: string, period: number, displayClock: string, shortDetail: string, state = 'in', completed = false) => ({
  period,
  displayClock,
  type: { name, state, completed, detail: shortDetail, shortDetail },
});

describe('provider status normalization', () => {
  it('keeps the running clock in NFL overtime', () => {
    const s = normalizeStatus(status('STATUS_IN_PROGRESS', 5, '6:07', '6:07 - OT'));
    expect(s).toMatchObject({ kind: 'in_progress', period: 5, clock: '6:07', clockSeconds: 367 });
    expect(statusShort(s)).toBe('OT 6:07');
  });

  it('drops the placeholder clock in college overtime, which has no game clock', () => {
    const s = normalizeStatus(status('STATUS_IN_PROGRESS', 6, '0:00', '2OT'));
    expect(s).toMatchObject({ kind: 'in_progress', period: 6, clock: null, clockSeconds: null });
    expect(statusShort(s)).toBe('2OT');
  });

  it('keeps a real 0:00 in regulation', () => {
    expect(normalizeStatus(status('STATUS_IN_PROGRESS', 4, '0:00', '0:00 - 4th')).clock).toBe('0:00');
  });

  it('ignores leftover clocks at period breaks and halftime', () => {
    expect(normalizeStatus(status('STATUS_END_PERIOD', 4, '0:20', 'End of 4th'))).toMatchObject({ kind: 'end_of_period', period: 4, clock: null });
    expect(normalizeStatus(status('STATUS_HALFTIME', 2, '0:00', 'Halftime'))).toMatchObject({ kind: 'halftime', period: 2, clock: null });
  });

  it('maps finals, forfeits, cancellations and postponements', () => {
    const ot = normalizeStatus(status('STATUS_FINAL', 5, '0:00', 'Final/OT', 'post', true));
    expect(ot.kind).toBe('final');
    expect(statusShort(ot)).toBe('Final/OT');
    expect(normalizeStatus(status('STATUS_FORFEIT', 4, '0:00', 'Forfeit', 'post', true)).kind).toBe('final');
    expect(normalizeStatus(status('STATUS_CANCELED', 1, '6:12', 'Canceled', 'post', false))).toMatchObject({ kind: 'canceled', clock: null });
    expect(normalizeStatus(status('STATUS_POSTPONED', 0, '0:00', 'Postponed', 'post', false)).kind).toBe('postponed');
  });

  it('treats both scheduled shapes as scheduled with no period or clock', () => {
    expect(normalizeStatus(status('STATUS_SCHEDULED', 0, '0:00', '9/14 - 8:15 PM EDT', 'pre'))).toMatchObject({ kind: 'scheduled', period: null, clock: null });
    expect(normalizeStatus(status('STATUS_SCHEDULED', 1, '15:00', '9/14 - 8:15 PM EDT', 'pre'))).toMatchObject({ kind: 'scheduled', period: null, clock: null });
  });

  it('does not guess at an unrecognized in-game status', () => {
    expect(normalizeStatus(status('STATUS_SOMETHING_NEW', 3, '4:00', '?')).kind).toBe('unknown');
  });
});
