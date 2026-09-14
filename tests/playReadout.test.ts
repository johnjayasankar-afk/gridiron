import { describe, expect, it } from 'vitest';
import type { PlayEvent } from '../shared/model';
import { gainedFirstDown, planPlayAnimation, playInputFromBrief, playInputFromEvent, playReadout } from '../shared/playAnimation';
import { play, spot } from './helpers/builders';

const endingAt = (p: PlayEvent, down: number | null, distance: number | null): PlayEvent => ({ ...p, end: { ...p.end!, down, distance } });
const live = { reducedMotion: false, burst: false };

describe('play readouts', () => {
  it('shows the reported yardage for runs, passes, sacks and penalties', () => {
    expect(playReadout(playInputFromEvent(play({ n: 1, kind: 'rush', yards: 7, startProgress: 20, endProgress: 27 })))).toBe('Rush +7');
    expect(playReadout(playInputFromEvent(play({ n: 2, kind: 'pass_complete', yards: 18, startProgress: 20, endProgress: 38 })))).toBe('Pass +18');
    expect(playReadout(playInputFromEvent(play({ n: 3, kind: 'sack', yards: -8, startProgress: 30, endProgress: 22 })))).toBe('Sack −8');
    expect(playReadout(playInputFromEvent(play({ n: 4, kind: 'penalty', yards: -10, penalty: true, startProgress: 30, endProgress: 20 })))).toBe('Penalty −10');
  });

  it('never adds yardage the provider did not report', () => {
    expect(playReadout(playInputFromEvent(play({ n: 5, kind: 'rush', yards: null })))).toBe('Rush');
    expect(playReadout(playInputFromEvent(play({ n: 6, kind: 'touchdown_pass', scoring: true, yards: 34, startProgress: 66, endProgress: 100 })))).toBe('Touchdown');
    expect(playReadout(playInputFromEvent(play({ n: 7, kind: 'pass_incomplete' })))).toBe('Incomplete');
  });

  it('detects a new set of downs from the reported downs only', () => {
    const conversion = endingAt(play({ n: 8, kind: 'pass_complete', yards: 12, down: 3, distance: 8, startProgress: 40, endProgress: 52 }), 1, 10);
    expect(playReadout(playInputFromEvent(conversion))).toBe('Pass +12 · First down');
    expect(planPlayAnimation(null, playInputFromEvent(conversion), live)).toMatchObject({ effect: 'first_down', firstDown: true, effectMs: 400 });

    const tenOnFirst = endingAt(play({ n: 9, kind: 'rush', yards: 10, down: 1, distance: 10, startProgress: 20, endProgress: 30 }), 1, 10);
    expect(gainedFirstDown(playInputFromEvent(tenOnFirst))).toBe(true);

    const shortGain = endingAt(play({ n: 10, kind: 'rush', yards: 4, down: 1, distance: 10, startProgress: 20, endProgress: 24 }), 2, 6);
    expect(gainedFirstDown(playInputFromEvent(shortGain))).toBe(false);

    const defensivePenalty = endingAt(play({ n: 11, kind: 'penalty', yards: 5, penalty: true, down: 1, distance: 10, startProgress: 20, endProgress: 25 }), 1, 5);
    expect(gainedFirstDown(playInputFromEvent(defensivePenalty))).toBe(false);

    const interception = endingAt(play({ n: 12, kind: 'interception', turnover: true, down: 3, distance: 5, endOffense: 'home', startProgress: 40, endProgress: 60 }), 1, 10);
    expect(gainedFirstDown(playInputFromEvent(interception))).toBe(false);

    const punt = endingAt(play({ n: 13, kind: 'punt', down: 4, distance: 9, endOffense: 'home', startProgress: 30, endProgress: 70 }), 1, 10);
    expect(gainedFirstDown(playInputFromEvent(punt))).toBe(false);
  });

  it('keeps scoreboard-only briefs to what the brief reports', () => {
    const input = playInputFromBrief({ id: 'x', kind: 'rush', description: 'Run for 9', yards: 9, team: 'away' }, spot(40, 'away'), spot(49, 'away'));
    expect(playReadout(input)).toBe('Rush +9');
    expect(gainedFirstDown(input)).toBe(false);
  });

  it('lets a bigger moment take the emphasis over a first down', () => {
    const scoreAndFirst = endingAt(play({ n: 14, kind: 'penalty', penalty: true, yards: 15, down: 3, distance: 9, startProgress: 40, endProgress: 55 }), 1, 10);
    expect(planPlayAnimation(null, playInputFromEvent(scoreAndFirst), live)).toMatchObject({ effect: 'penalty', firstDown: true, label: 'Penalty +15 · First down' });
  });
});
