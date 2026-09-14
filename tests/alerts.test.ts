import { describe, expect, it } from 'vitest';
import { AlertEngine, DEFAULT_ALERT_RULES, SCORE_GRACE_MS, type AlertRules } from '../shared/alerts';
import type { GameSummary } from '../shared/model';
import { detail, game, play, situation } from './helpers/builders';

const rules = (over: Partial<AlertRules> = {}): AlertRules => ({
  ...DEFAULT_ALERT_RULES,
  enabled: { ...DEFAULT_ALERT_RULES.enabled, red_zone: true, fourth_down: true, review: true },
  ...over,
});
const at = (s: number) => 1_000_000 + s * 1000;
const withClock = (g: GameSummary, clock: string, seconds: number, period = g.status.period): GameSummary => ({ ...g, status: { ...g.status, clock, clockSeconds: seconds, period } });

describe('alert baseline and deduplication', () => {
  it('establishes a baseline on first sight without announcing history', () => {
    const e = new AlertEngine(rules());
    const g = game({ home: 7, away: 0 });
    const d = detail(g, [play({ n: 1, kind: 'touchdown_pass', scoring: true, home: 7, offense: 'home' })]);
    expect(e.observe(g, d, at(0))).toEqual([]);
    expect(e.observe(g, d, at(20))).toEqual([]); // polling unchanged data announces nothing
  });

  it('announces a new touchdown once, however many times it is observed', () => {
    const e = new AlertEngine(rules());
    const before = game({ home: 0, away: 0 });
    e.observe(before, detail(before, [play({ n: 1 })]), at(0));
    const after = game({ home: 7, away: 0 });
    const d = detail(after, [play({ n: 1 }), play({ n: 2, kind: 'touchdown_rush', scoring: true, offense: 'home', home: 7 })]);
    const first = e.observe(after, d, at(30));
    expect(first.map((c) => [c.type, c.alert.kind])).toEqual([['created', 'touchdown']]);
    expect(first[0].alert.title).toBe('Touchdown HOM');
    expect(e.observe(after, d, at(60))).toEqual([]);
    expect(e.observe(after, d, at(90), true)).toEqual([]); // a reconnect replays nothing
  });

  it('flags plays that arrive after a connection gap as late updates', () => {
    const e = new AlertEngine(rules());
    const g = game({ home: 0, away: 0 });
    e.observe(g, detail(g, []), at(0));
    const g2 = game({ home: 0, away: 3 });
    const changes = e.observe(g2, detail(g2, [play({ n: 5, kind: 'field_goal_good', scoring: true, away: 3 })]), at(120), true);
    expect(changes).toHaveLength(1);
    expect(changes[0].alert).toMatchObject({ kind: 'field_goal', late: true });
  });

  it('does not treat a first detail load as a flood of new plays', () => {
    const e = new AlertEngine(rules());
    const g = game({ home: 14, away: 7 });
    e.observe(g, null, at(0));
    const d = detail(g, [play({ n: 1, kind: 'touchdown_pass', scoring: true }), play({ n: 2, kind: 'interception', turnover: true })]);
    expect(e.observe(g, d, at(20))).toEqual([]);
  });
});

describe('corrections', () => {
  it('withdraws an overturned touchdown without celebrating anything new', () => {
    const e = new AlertEngine(rules());
    const g0 = game({ home: 0, away: 0 });
    e.observe(g0, detail(g0, []), at(0));
    const g1 = game({ home: 7, away: 0 });
    const td = play({ n: 9, kind: 'touchdown_pass', scoring: true, offense: 'home', home: 7, revision: 'a' });
    const created = e.observe(g1, detail(g1, [td]), at(30));
    expect(created.map((c) => c.alert.kind)).toEqual(['touchdown']);
    const reversed = { ...td, kind: 'pass_complete' as const, scoring: false, scoreAfter: { home: 0, away: 0 }, revision: 'b' };
    const changes = e.observe(g0, detail(g0, [reversed]), at(90));
    const tdUpdate = changes.find((c) => c.alert.kind === 'touchdown')!;
    expect(tdUpdate).toMatchObject({ type: 'updated', alert: { status: 'withdrawn', revision: 2, id: created[0].alert.id } });
    // the only new moment is the plain statement that the score was corrected: no celebration, no "tied"
    expect(changes.filter((c) => c.type === 'created').map((c) => [c.alert.kind, c.alert.title])).toEqual([['score_change', 'Score corrected: AWY 0, HOM 0']]);
  });

  it('keeps a touchdown whose description was only revised, marked corrected', () => {
    const e = new AlertEngine(rules());
    const g0 = game({ home: 0, away: 0 });
    e.observe(g0, detail(g0, []), at(0));
    const g1 = game({ home: 0, away: 7 });
    const td = play({ n: 3, kind: 'touchdown_rush', scoring: true, away: 7, revision: 'a' });
    e.observe(g1, detail(g1, [td]), at(30));
    const changes = e.observe(g1, detail(g1, [{ ...td, description: 'Corrected yardage', revision: 'b' }]), at(60));
    expect(changes.map((c) => [c.type, c.alert.kind, c.alert.status])).toEqual([['updated', 'touchdown', 'corrected']]);
  });

  it('never calls a score increase a touchdown without a touchdown play', () => {
    const e = new AlertEngine(rules());
    const g0 = game({ home: 0, away: 0, coverage: 'score-only' });
    e.observe(g0, null, at(0));
    const changes = e.observe(game({ home: 6, away: 0, coverage: 'score-only' }), null, at(40));
    // an opening score is not a lead change, and six points are not assumed to be a touchdown
    expect(changes.map((c) => c.alert.kind)).toEqual(['score_change']);
    expect(changes[0].alert.title).toBe('Score changed: AWY 0, HOM 6');
  });

  it('waits briefly for the scoring play before announcing an unexplained score', () => {
    const e = new AlertEngine(rules({ enabled: { ...DEFAULT_ALERT_RULES.enabled, lead_change: false } }));
    const g0 = game({ home: 0, away: 0 });
    e.observe(g0, detail(g0, []), at(0));
    const g1 = game({ home: 3, away: 0 });
    expect(e.observe(g1, detail(g1, []), at(10))).toEqual([]);
    const fg = play({ n: 4, kind: 'field_goal_good', scoring: true, offense: 'home', home: 3 });
    expect(e.observe(g1, detail(g1, [fg]), at(20)).map((c) => c.alert.kind)).toEqual(['field_goal']);
    // a different game where the play never arrives
    const e2 = new AlertEngine(rules({ enabled: { ...DEFAULT_ALERT_RULES.enabled, lead_change: false } }));
    e2.observe(g0, detail(g0, []), at(0));
    e2.observe(g1, detail(g1, []), at(10));
    const late = e2.observe(g1, detail(g1, []), at(10) + SCORE_GRACE_MS);
    expect(late.map((c) => [c.alert.kind, c.alert.late])).toEqual([['score_change', true]]);
  });
});

describe('situational alerts', () => {
  it('fires a red-zone entry only on a known outside-to-inside transition', () => {
    const e = new AlertEngine(rules());
    const unknown = game({ situation: situation({ progress: null }) });
    e.observe(unknown, null, at(0));
    expect(e.observe(game({ situation: situation({ progress: 85 }) }), null, at(10))).toEqual([]); // unknown → inside is not a new entry
    const e2 = new AlertEngine(rules());
    e2.observe(game({ situation: situation({ progress: 70 }) }), null, at(0));
    const entry = e2.observe(game({ situation: situation({ progress: 85 }) }), null, at(10));
    expect(entry.map((c) => c.alert.kind)).toEqual(['red_zone']);
    expect(e2.observe(game({ situation: situation({ progress: 90 }) }), null, at(20))).toEqual([]);
    expect(e2.observe(game({ situation: situation({ progress: null }) }), null, at(30))).toEqual([]);
    expect(e2.observe(game({ situation: situation({ progress: 92 }) }), null, at(40))).toEqual([]); // still the same trip
  });

  it('reports a fourth-down situation once per situation, not every poll', () => {
    const e = new AlertEngine(rules());
    e.observe(game({ situation: situation({ down: 3, progress: 60 }) }), null, at(0));
    const fourth = game({ situation: situation({ down: 4, distance: 2, progress: 62 }) });
    expect(e.observe(fourth, null, at(10)).map((c) => c.alert.kind)).toEqual(['fourth_down']);
    expect(e.observe(fourth, null, at(20))).toEqual([]);
    expect(e.observe(fourth, null, at(30))).toEqual([]);
    e.observe(game({ situation: situation({ down: 1, progress: 30, possession: 'home' }) }), null, at(40));
    expect(e.observe(game({ situation: situation({ down: 4, progress: 41, possession: 'home' }) }), null, at(50)).map((c) => c.alert.kind)).toEqual(['fourth_down']);
  });

  it('respects the close-game margin and late-game time thresholds', () => {
    const e = new AlertEngine(rules({ closeMargin: 8, lateSeconds: 300 }));
    const base = game({ home: 21, away: 17, period: 4 });
    e.observe(withClock(base, '6:00', 360), null, at(0));
    expect(e.observe(withClock(base, '5:01', 301), null, at(10))).toEqual([]);
    const close = e.observe(withClock(base, '4:58', 298), null, at(20));
    expect(close.map((c) => c.alert.kind)).toEqual(['close_late']);
    expect(close[0].alert.title).toBe('4-point game late');
    expect(e.observe(withClock(base, '3:10', 190), null, at(30))).toEqual([]);
    const wide = new AlertEngine(rules({ closeMargin: 3 }));
    wide.observe(withClock(base, '6:00', 360), null, at(0));
    expect(wide.observe(withClock(base, '2:00', 120), null, at(10))).toEqual([]);
  });

  it('announces lead changes, ties, overtime and the final result from known transitions', () => {
    const e = new AlertEngine(rules());
    e.observe(game({ home: 7, away: 3, period: 4 }), null, at(0));
    expect(e.observe(game({ home: 7, away: 10, period: 4 }), null, at(10)).map((c) => c.alert.kind)).toEqual(['lead_change', 'score_change']);
    expect(e.observe(game({ home: 10, away: 10, period: 4 }), null, at(20)).map((c) => c.alert.kind)).toEqual(['tied', 'score_change']);
    expect(e.observe(game({ home: 10, away: 10, period: 5 }), null, at(30)).map((c) => c.alert.kind)).toEqual(['overtime']);
    expect(e.observe(game({ home: 16, away: 10, period: 5, kind: 'final' }), null, at(40)).map((c) => c.alert.kind)).toContain('final');
  });

  it('announces a favorite team kickoff and nothing for other kickoffs', () => {
    const fav = new AlertEngine(rules(), { favorites: ['nfl-HOM'], monitored: [], muted: [] });
    fav.observe(game({ kind: 'scheduled' }), null, at(0));
    expect(fav.observe(game({ kind: 'in_progress' }), null, at(10)).map((c) => c.alert.kind)).toEqual(['kickoff']);
    const other = new AlertEngine(rules());
    other.observe(game({ kind: 'scheduled' }), null, at(0));
    expect(other.observe(game({ kind: 'in_progress' }), null, at(10))).toEqual([]);
  });

  it('reads turnovers, big plays and fourth-down tries from explicit play fields', () => {
    const e = new AlertEngine(rules({ bigPlayYards: 25 }));
    const g = game();
    e.observe(g, detail(g, []), at(0));
    const plays = [
      play({ n: 1, kind: 'interception', turnover: true, offense: 'away', endOffense: 'home' }),
      play({ n: 2, kind: 'pass_complete', yards: 42, offense: 'home' }),
      { ...play({ n: 3, kind: 'rush', offense: 'home', down: 4, distance: 1 }), end: { down: 1, distance: 10, goalToGo: false, downDistanceText: null, spot: { ...play({ n: 3 }).end!.spot, offense: 'home' as const } } },
    ];
    const kinds = e.observe(g, detail(g, plays), at(10)).map((c) => c.alert.kind);
    expect(kinds).toEqual(['turnover', 'big_play', 'fourth_down_attempt']);
  });
});

describe('scope, mute and baseline resets', () => {
  it('keeps memory for games outside the scope, so widening the scope does not flood', () => {
    const e = new AlertEngine(rules({ scope: 'monitored' }), { favorites: [], monitored: [], muted: [] });
    const g0 = game({ home: 0, away: 0 });
    e.observe(g0, detail(g0, []), at(0));
    const g1 = game({ home: 7, away: 0 });
    const d1 = detail(g1, [play({ n: 1, kind: 'touchdown_pass', scoring: true, offense: 'home', home: 7 })]);
    expect(e.observe(g1, d1, at(10))).toEqual([]);
    e.setRules(rules({ scope: 'all' }));
    expect(e.observe(g1, d1, at(20))).toEqual([]);
  });

  it('silences a muted game', () => {
    const e = new AlertEngine(rules(), { favorites: [], monitored: [], muted: ['nfl-1'] });
    const g0 = game({ home: 0, away: 0 });
    e.observe(g0, detail(g0, []), at(0));
    const g1 = game({ home: 7, away: 0 });
    expect(e.observe(g1, detail(g1, [play({ n: 1, kind: 'touchdown_pass', scoring: true, home: 7 })]), at(10))).toEqual([]);
  });

  it('re-baselines after a reset instead of replaying the game', () => {
    const e = new AlertEngine(rules());
    const g = game({ home: 14, away: 10, period: 4 });
    const d = detail(g, [play({ n: 1, kind: 'touchdown_pass', scoring: true })]);
    e.observe(g, d, at(0));
    e.reset();
    expect(e.observe(g, d, at(10))).toEqual([]);
  });
});
