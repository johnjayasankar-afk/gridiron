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
import { StatusPill } from '../src/components/StatusPill';
import { ScoreBug } from '../src/field/ScoreBug';
import { game, situation } from './helpers/builders';

const base = game({ id: 'nfl-1', home: 21, away: 17, period: 3, clock: '4:12' });

const render = (s: Situation | null, over: Partial<GameSummary> = {}) =>
  renderToStaticMarkup(createElement(ScoreBug, { game: { ...base, ...over }, situation: s }));

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

describe('before kickoff', () => {
  it('is not drawn at all, because there is nothing for it to say', () => {
    const scheduled = game({ id: 'nfl-2', kind: 'scheduled' });
    expect(renderToStaticMarkup(createElement(ScoreBug, { game: scheduled, situation: null }))).toBe('');
  });

  it('is drawn for a finished game, where the final score is the thing worth carrying', () => {
    const final = game({ id: 'nfl-3', kind: 'final', home: 31, away: 24 });
    const html = renderToStaticMarkup(createElement(ScoreBug, { game: final, situation: null }));
    expect(html).toContain('31');
    expect(html).toContain('24');
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

/**
 * The pill is handed the state of the play being looked at, so without being
 * told it is a past one it announces the live dot and says "Live" over a moment
 * that finished hours ago.
 */
describe('the status pill while a past play is being looked at', () => {
  const past = game({ id: 'nfl-9', kind: 'in_progress', period: 1, clock: '15:00' });

  it('keeps the clock and the period, and drops the claim that it is happening now', () => {
    const now = renderToStaticMarkup(createElement(StatusPill, { game: past }));
    const then = renderToStaticMarkup(createElement(StatusPill, { game: past, historical: true }));
    for (const html of [now, then]) expect(html).toContain('Q1 15:00');
    expect(now).toContain('live-dot');
    expect(now).toContain('Live, ');
    expect(then).not.toContain('live-dot');
    expect(then).not.toContain('Live, ');
  });

  it('is still the live pill when nothing is being looked at, which is the ordinary case', () => {
    expect(renderToStaticMarkup(createElement(StatusPill, { game: past, historical: false }))).toContain('tone-live');
  });
});
