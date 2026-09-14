import { describe, expect, it } from 'vitest';
import { newDiagnostics, normalizeSummary } from '../server/providers/espn/normalize';
import { applyDetailDelta, computeDetailDelta } from '../shared/detailDelta';
import { fixture } from './helpers/fixtures';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const summary = (raw: Raw) => normalizeSummary(raw, 'nfl', ['NFL'], newDiagnostics())!;

describe('game leaders', () => {
  it('reads passing, rushing and receiving leaders for both teams, as reported', () => {
    const d = summary(fixture<Raw>('summary/nfl-401872661.json'));
    expect(d.leaders.map((t) => t.side)).toEqual(['away', 'home']);
    for (const team of d.leaders) {
      expect(team.leaders.map((l) => l.category)).toEqual(['passing', 'rushing', 'receiving']);
      for (const leader of team.leaders) {
        expect(leader.athlete.name.length).toBeGreaterThan(2);
        expect(leader.line).toMatch(/YDS/);
        if (leader.athlete.headshot) expect(leader.athlete.headshot).toMatch(/^https:\/\/a\.espncdn\.com\//);
      }
    }
    expect(d.attendance).toBeGreaterThan(1000);
  });

  it('drops leaders it cannot attribute and never invents a stat line', () => {
    const raw = fixture<Raw>('summary/nfl-401872661.json');
    const homeId = String(raw.header.competitions[0].competitors.find((c: Raw) => c.homeAway === 'home').team.id);
    const d = summary({
      ...raw,
      leaders: [
        { team: { id: '99999' }, leaders: [{ name: 'passingYards', leaders: [{ displayValue: '10/10, 100 YDS', athlete: { displayName: 'Nobody' } }] }] },
        { team: { id: homeId }, leaders: [{ name: 'passingYards', leaders: [{ athlete: { displayName: 'No Line' } }] }, { name: 'sacks', leaders: [{ displayValue: '2', athlete: { displayName: 'Rusher' } }] }] },
        { team: { id: homeId }, leaders: [{ name: 'rushingYards', leaders: [{ displayValue: '5 CAR, 40 YDS', athlete: { displayName: 'Back', headshot: { href: 'https://evil.example/x.png' } } }] }] },
      ],
      gameInfo: { ...raw.gameInfo, attendance: 'lots' },
    });
    // Only the attributable leader with a stat line survives, and its off-provider headshot is dropped.
    expect(d.leaders).toHaveLength(1);
    expect(d.leaders[0]?.side).toBe('home');
    expect(d.leaders[0]?.leaders.map((l) => [l.category, l.athlete.name, l.line])).toEqual([['rushing', 'Back', '5 CAR, 40 YDS']]);
    expect(d.leaders[0]?.leaders[0]?.athlete.headshot).toBeNull();
    expect(d.attendance).toBeNull();
  });

  it('travels through detail deltas', () => {
    const d = summary(fixture<Raw>('summary/nfl-401872661.json'));
    const delta = computeDetailDelta(null, d, 0, 1);
    const applied = applyDetailDelta({ ...d, plays: [], leaders: [], attendance: null }, delta);
    expect(applied.leaders).toEqual(d.leaders);
    expect(applied.attendance).toBe(d.attendance);
  });
});
