/**
 * The scorebug.
 *
 * It says the state of the down on the field itself, the way a broadcast does.
 * Everything in it is reported or absent: a down nobody reported is not drawn as
 * first and ten, and a timeout count nobody reported is not drawn as three.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GameSummary, Situation } from '../shared/model';
import { ScoreBug } from '../src/field/ScoreBug';
import { game, situation } from './helpers/builders';

const base = game({ id: 'nfl-1', home: 21, away: 17, period: 3, clock: '4:12' });

const render = (s: Situation | null, over: Partial<GameSummary> = {}) =>
  renderToStaticMarkup(createElement(ScoreBug, { game: { ...base, ...over }, situation: s, frame: null }));

describe('what the bug says', () => {
  it('carries both sides, their scores and the clock', () => {
    const html = render(situation());
    expect(html).toContain('AWY');
    expect(html).toContain('HOM');
    expect(html).toContain('17');
    expect(html).toContain('21');
    expect(html).toContain('Q3');
    expect(html).toContain('4:12');
  });

  it('lights the row of whoever the provider says has the ball, and neither when it said nothing', () => {
    const home = render({ ...situation(), possession: 'home' });
    expect(home.match(/bug-team has-ball/g)).toHaveLength(1);
    const away = render({ ...situation(), possession: 'away' });
    expect(away.match(/bug-team has-ball/g)).toHaveLength(1);
    // The away row comes first, so possession is on the first row for away and the second for home.
    expect(away.indexOf('has-ball')).toBeLessThan(home.indexOf('has-ball'));
    expect(render({ ...situation(), possession: null })).not.toContain('has-ball');
  });

  it("uses the provider's own words for the down, rather than rebuilding them from the parts", () => {
    const html = render({ ...situation(), downDistanceText: '3rd & 7 at BUF 35' });
    expect(html).toContain('3rd &amp; 7 at BUF 35');
  });

  it('flags the red zone, and does not when the provider says it is not', () => {
    expect(render({ ...situation(), isRedZone: true })).toContain('RED ZONE');
    expect(render({ ...situation(), isRedZone: false })).not.toContain('RED ZONE');
    expect(render({ ...situation(), isRedZone: null })).not.toContain('RED ZONE');
  });
});

describe('timeouts', () => {
  it('are three pips a side, unlit as they are spent', () => {
    const html = render({ ...situation(), timeouts: { home: 2, away: 0 } });
    expect(html.match(/bug-pip/g)).toHaveLength(6);
    expect(html.match(/bug-pip is-left/g)).toHaveLength(2);
  });

  it('are not drawn at all for a side the provider gave no count for, rather than drawn as three', () => {
    const one = render({ ...situation(), timeouts: { home: 3, away: null } });
    expect(one.match(/bug-pip/g)).toHaveLength(3);
    const none = render({ ...situation(), timeouts: { home: null, away: null } });
    expect(none).not.toContain('bug-pip');
  });
});

describe('what it does without a situation', () => {
  it('still says the score and the clock, because those are reported without one', () => {
    const html = render(null);
    expect(html).toContain('21');
    expect(html).toContain('4:12');
    // And says nothing about a down, a red zone or timeouts, because nothing was reported.
    expect(html).not.toContain('bug-down');
    expect(html).not.toContain('bug-pip');
    expect(html).not.toContain('RED ZONE');
  });

  it('writes a dash where a score has not been reported, never a zero', () => {
    const html = render(null, { score: { home: null, away: null } });
    expect(html).toContain('-');
    expect(html).not.toContain('>0<');
  });

  it('is hidden from screen readers, because every figure in it is already in prose elsewhere', () => {
    expect(render(situation())).toContain('aria-hidden="true"');
  });
});
