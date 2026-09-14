import { describe, expect, it } from 'vitest';
import { normalizeScoreboardEvent, normalizeSummary } from '../server/providers/espn/normalize';
import { FixtureStore, SCENARIOS } from '../server/replay/scenarios';
import { buildTimeline, scoreboardEventAt, statusAt, summaryAt, visiblePlays } from '../server/replay/timeline';
import { VirtualClock } from '../server/replay/lab';
import { FIXTURES, fixture } from './helpers/fixtures';

type Raw = Record<string, any>;
const event = fixture<Raw>('scoreboard/nfl-20260913.json').events.find((e: Raw) => e.id === '401872925');
const summary = fixture<Raw>('summary/nfl-401872925.json');
const rawPlays: Raw[] = summary.drives.previous.flatMap((d: Raw) => d.plays);
const fresh = () => buildTimeline('nfl', event, summary, ['NFL']);

describe('replay timeline built from a captured game', () => {
  it('is scheduled before the first reported play and final after the last', () => {
    const tl = fresh();
    const before = normalizeScoreboardEvent(scoreboardEventAt(tl, tl.kickoffAt - 60_000), 'nfl', ['NFL'])!;
    expect(before.status.kind).toBe('scheduled');
    expect(before.score).toEqual({ home: null, away: null });
    const after = normalizeScoreboardEvent(scoreboardEventAt(tl, tl.endAt + 60_000), 'nfl', ['NFL'])!;
    expect(after.status.kind).toBe('final');
    const finalHome = Number(event.competitions[0].competitors.find((c: Raw) => c.homeAway === 'home').score);
    expect(after.score.home).toBe(finalHome);
  });

  it('shows the reported score and situation of the latest play at a moment mid-game', () => {
    const tl = fresh();
    const k = rawPlays.findIndex((p, i) => i > 30 && p.type.text === 'Rush' && p.end?.possessionText);
    const tv = Date.parse(rawPlays[k].wallclock);
    const visible = visiblePlays(tl, tv);
    const last = visible[visible.length - 1].raw;
    expect(Date.parse(last.wallclock)).toBeLessThanOrEqual(tv);
    const g = normalizeScoreboardEvent(scoreboardEventAt(tl, tv), 'nfl', ['NFL'])!;
    expect(g.status.kind).toBe('in_progress');
    expect(g.status.clock).toBe(last.clock.displayValue);
    expect(g.score).toEqual({ home: Number(last.homeScore), away: Number(last.awayScore) });
    expect(g.situation?.spot.label).toBe(rawPlays[k].end.possessionText);
  });

  it('does not reveal how an unfinished drive ends', () => {
    const tl = fresh();
    const driveWithManyPlays = summary.drives.previous.findIndex((d: Raw) => d.plays.length >= 6);
    const drive = summary.drives.previous[driveWithManyPlays];
    const tv = Date.parse(drive.plays[2].wallclock);
    const s = summaryAt(tl, tv);
    expect(s.drives.current).toBeTruthy();
    expect(s.drives.current.result).toBeUndefined();
    expect(s.drives.current.displayResult).toBeUndefined();
    expect(s.drives.current.plays.length).toBeLessThan(drive.plays.length);
    expect(s.boxscore).toBeUndefined();
    const detail = normalizeSummary(s, 'nfl')!;
    const current = detail.drives.find((d) => d.isCurrent)!;
    expect(current.result).toBeNull();
    expect(detail.stats).toEqual([]);
    expect(s.header.competitions[0].competitors.every((c: Raw) => c.winner === undefined && c.record === undefined)).toBe(true);
  });

  it('reports halftime between the end of the half and the third quarter', () => {
    const tl = fresh();
    const half = rawPlays.find((p) => p.type.text === 'End of Half')!;
    const g = normalizeScoreboardEvent(scoreboardEventAt(tl, Date.parse(half.wallclock) + 1000), 'nfl', ['NFL'])!;
    expect(g.status.kind).toBe('halftime');
    expect(statusAt(tl, visiblePlays(tl, Date.parse(half.wallclock)), Date.parse(half.wallclock)).type.name).toBe('STATUS_HALFTIME');
  });

  it('withholds a burst of plays and releases them together', () => {
    const tl = fresh();
    const from = Date.parse(rawPlays[40].wallclock);
    const until = Date.parse(rawPlays[45].wallclock) + 1;
    tl.edits.push({ kind: 'hold', from, until });
    expect(visiblePlays(tl, until - 1000).length).toBe(40);
    expect(visiblePlays(tl, until).length).toBeGreaterThanOrEqual(46);
  });

  it('can omit the reported spot, and the field then has no ball position', () => {
    const tl = fresh();
    const k = rawPlays.findIndex((p, i) => i > 30 && p.type.text === 'Rush' && p.end?.possessionText);
    const t = Date.parse(rawPlays[k].wallclock);
    tl.edits.push({ kind: 'strip-spot', from: t, until: t + 1 });
    const g = normalizeScoreboardEvent(scoreboardEventAt(tl, t), 'nfl', ['NFL'])!;
    expect(g.situation?.spot.progress).toBeNull();
    expect(g.situation?.spot.provenance).toBe('unknown');
  });
});

describe('replay scenarios', () => {
  const fx = new FixtureStore(FIXTURES);

  it('builds every scenario whose captured data is installed', () => {
    const built = SCENARIOS.map((s) => [s.id, s.build(fx)] as const);
    for (const [id, b] of built) {
      if (!b) continue;
      expect(b.endAt, id).toBeGreaterThan(b.startAt);
      expect(b.games.length, id).toBeGreaterThan(0);
    }
    expect(built.find(([id]) => id === 'nfl-week1-sunday')?.[1]?.games).toHaveLength(13);
    expect(SCENARIOS.filter((s) => s.id.startsWith('test-')).every((s) => s.synthetic && /synthetic/i.test(s.label))).toBe(true);
  });

  it('reverses a touchdown in the synthetic correction scenario without changing its id', () => {
    const def = SCENARIOS.find((s) => s.id === 'test-overturned-touchdown')!;
    const b = def.build(fx)!;
    const tl = b.games[0];
    const edit = tl.edits.find((e) => e.kind === 'revise') as Extract<(typeof tl.edits)[number], { kind: 'revise' }>;
    const beforeEdit = normalizeSummary(summaryAt(tl, edit.at - 1), 'nfl')!;
    const afterEdit = normalizeSummary(summaryAt(tl, edit.at + 1), 'nfl')!;
    const id = `nfl-401872925:${edit.playId}`;
    const was = beforeEdit.plays.find((p) => p.id === id)!;
    const now = afterEdit.plays.find((p) => p.id === id)!;
    expect(was.kind === 'touchdown_pass' || was.kind === 'touchdown_rush').toBe(true);
    expect(now.kind === 'pass_complete' || now.kind === 'rush').toBe(true);
    expect(now.scoring).toBe(false);
    expect(now.revision).not.toBe(was.revision);
    expect((afterEdit.summary.score.home ?? 0) + (afterEdit.summary.score.away ?? 0)).toBeLessThan((beforeEdit.summary.score.home ?? 0) + (beforeEdit.summary.score.away ?? 0));
    expect(afterEdit.scoring.some((s) => s.playId === id)).toBe(false);
  });
});

describe('virtual clock', () => {
  it('runs, pauses, steps and seeks within its range', () => {
    let real = 1_000;
    const clock = new VirtualClock(10_000, 70_000, 10, () => real, true);
    real += 1_000; // one real second at 10x
    expect(clock.now()).toBe(20_000);
    clock.pause();
    real += 5_000;
    expect(clock.now()).toBe(20_000);
    clock.step(30);
    expect(clock.now()).toBe(50_000);
    clock.step(60);
    expect(clock.now()).toBe(70_000); // clamped at the end
    clock.seek(0);
    expect(clock.now()).toBe(10_000);
  });
});
