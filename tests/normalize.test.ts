import { describe, expect, it } from 'vitest';
import { gameId, parseGameId, teamKey } from '../shared/model';
import { ProviderFetcher, DEFAULT_FETCH_POLICY } from '../server/fetcher';
import { classifyPlayType, parseConversion, parseReview } from '../server/providers/espn/classify';
import { divisionFromGroupName, seasonForDate } from '../server/providers/espn/coverage';
import {
  newDiagnostics,
  normalizeScoreboardEvent,
  normalizeSituation,
  normalizeStatus,
  normalizeSummary,
  parseScoreboard,
  resolveSpot,
} from '../server/providers/espn/normalize';
import { EspnProvider } from '../server/providers/espn/provider';
import { fixture, fixtureFetch, fixtureNames } from './helpers/fixtures';

type Raw = Record<string, any>;
const fastFetcher = (impl: typeof fetch) => new ProviderFetcher({ ...DEFAULT_FETCH_POLICY, maxConcurrent: 8, budgetPerMinute: 1000, maxRetries: 0 }, impl);

describe('identity', () => {
  it('namespaces ids so NFL and college events and teams cannot collide', () => {
    expect(gameId('nfl', '401')).not.toBe(gameId('cfb', '401'));
    expect(teamKey('nfl', '4')).not.toBe(teamKey('cfb', '4'));
    expect(parseGameId('cfb-401856682')).toEqual({ league: 'cfb', providerEventId: '401856682' });
    expect(parseGameId('mlb-1')).toBeNull();
    expect(parseGameId('nfl-../../etc')).toBeNull();
  });
});

describe('status normalization', () => {
  const status = (name: string, extra: Raw = {}) => normalizeStatus({ displayClock: '7:12', period: 2, type: { name, state: 'in', shortDetail: 'x' }, ...extra });
  it('distinguishes every provider state rather than a live boolean', () => {
    expect(status('STATUS_SCHEDULED').kind).toBe('scheduled');
    expect(status('STATUS_IN_PROGRESS').kind).toBe('in_progress');
    expect(status('STATUS_HALFTIME').kind).toBe('halftime');
    expect(status('STATUS_END_PERIOD').kind).toBe('end_of_period');
    expect(status('STATUS_DELAYED').kind).toBe('delayed');
    expect(status('STATUS_RAIN_DELAY').kind).toBe('delayed');
    expect(status('STATUS_SUSPENDED').kind).toBe('suspended');
    expect(status('STATUS_POSTPONED').kind).toBe('postponed');
    expect(status('STATUS_CANCELED').kind).toBe('canceled');
    expect(status('STATUS_FINAL').kind).toBe('final');
    expect(status('STATUS_SOMETHING_NEW').kind).toBe('unknown');
  });
  it('keeps the provider clock only while it can matter, and never for a scheduled game', () => {
    expect(status('STATUS_IN_PROGRESS').clock).toBe('7:12');
    expect(status('STATUS_IN_PROGRESS').clockSeconds).toBe(432);
    expect(status('STATUS_SCHEDULED').clock).toBeNull();
    expect(status('STATUS_SCHEDULED').period).toBeNull();
    expect(status('STATUS_FINAL').clock).toBeNull();
  });
  it('preserves overtime periods beyond regulation', () => {
    const ot = normalizeStatus({ displayClock: '0:00', period: 6, type: { name: 'STATUS_FINAL', state: 'post', completed: true, shortDetail: 'Final/2OT' } });
    expect(ot).toMatchObject({ kind: 'final', period: 6, regulationPeriods: 4, detail: 'Final/2OT' });
  });
});

describe('invalid provider responses', () => {
  it('rejects shapes that are not a scoreboard or summary', () => {
    expect(parseScoreboard('<html>').ok).toBe(false);
    expect(parseScoreboard({ leagues: [] }).ok).toBe(false);
    expect(normalizeSummary({ header: {} }, 'nfl')).toBeNull();
    const diag = newDiagnostics();
    expect(normalizeScoreboardEvent({ id: '1' }, 'nfl', ['NFL'], diag)).toBeNull();
    expect(normalizeScoreboardEvent({ id: '2', competitions: [{ competitors: [{ homeAway: 'home' }] }] }, 'nfl', ['NFL'], diag)).toBeNull();
    expect(diag.invalidEvents).toBe(2);
  });
});

describe('NFL scoreboard fixture', () => {
  const raw = fixture<Raw>('scoreboard/nfl-20260913.json');
  const games = raw.events.map((e: Raw) => normalizeScoreboardEvent(e, 'nfl', ['NFL']));

  it('normalizes every event with league-namespaced ids and real team metadata', () => {
    expect(games).toHaveLength(raw.events.length);
    for (const [i, g] of games.entries()) {
      const ev = raw.events[i];
      const home = ev.competitions[0].competitors.find((c: Raw) => c.homeAway === 'home');
      expect(g.id).toBe(`nfl-${ev.id}`);
      expect(g.home.abbreviation).toBe(home.team.abbreviation);
      expect(g.home.color).toBe(`#${String(home.team.color).toLowerCase()}`);
      expect(g.home.logo).toBe(home.team.logo);
      expect(g.score.home).toBe(Number(home.score));
      expect(g.status.kind).toBe('final');
      expect(g.situation).toBeNull();
      expect(g.coverage.level).toBe(ev.competitions[0].playByPlayAvailable ? 'full' : 'score-only');
    }
  });

  it('reads national broadcasts and the provider game page link', () => {
    const tbCin = games.find((g: Raw) => g.shortName === 'TB @ CIN');
    expect(tbCin.broadcasts.map((b: Raw) => b.name)).toContain('FOX');
    expect(tbCin.links.gamePage).toMatch(/^https:\/\/www\.espn\.com\/nfl\/game\//);
  });
});

describe('college coverage across divisions', () => {
  it('maps provider group names to divisions without guessing ids', () => {
    expect(divisionFromGroupName({ name: 'FBS' })).toBe('FBS');
    expect(divisionFromGroupName({ name: 'FCS' })).toBe('FCS');
    expect(divisionFromGroupName({ name: 'NCAA Division II', abbreviation: 'd2' })).toBe('D2');
    expect(divisionFromGroupName({ name: 'NCAA Division III', abbreviation: 'd3' })).toBe('D3');
    expect(divisionFromGroupName({ name: 'Division II/III', abbreviation: 'yy' })).toBe('D2'); // a parent, never requested as a child
    expect(divisionFromGroupName({ name: 'Big Ten Conference' })).toBeNull();
  });

  it('finds the season type for a date from the league calendar', () => {
    expect(seasonForDate(fixture('scoreboard/cfb-20260912-g80.json'), '20260912')).toEqual({ season: 2026, seasonType: 2 });
  });

  it('discovers FBS and FCS, fetches each, and deduplicates games in both', async () => {
    const log: string[] = [];
    const provider = new EspnProvider(fastFetcher(fixtureFetch({ log })));
    const slate = await provider.fetchSlate('cfb', '20260912', { divisions: ['FBS', 'FCS'] });
    const fbs = fixture<Raw>('scoreboard/cfb-20260912-g80.json').events.map((e: Raw) => e.id);
    const fcs = fixture<Raw>('scoreboard/cfb-20260912-g81.json').events.map((e: Raw) => e.id);
    const union = new Set([...fbs, ...fcs]);
    const both = fbs.filter((id: string) => fcs.includes(id));
    expect(both.length).toBeGreaterThan(0); // FBS teams play FCS teams
    expect(slate.failed).toBe(false);
    expect(slate.games).toHaveLength(union.size);
    expect(new Set(slate.games.map((g) => g.id)).size).toBe(slate.games.length);
    const shared = slate.games.find((g) => g.providerEventId === both[0]);
    expect(shared?.divisions.sort()).toEqual(['FBS', 'FCS']);
    expect(slate.divisions.map((d) => [d.division, d.providerGroupId, d.games])).toEqual([
      ['FBS', '80', fbs.length],
      ['FCS', '81', fcs.length],
    ]);
    // group ids came from the discovery documents, not from the code
    expect(log.some((u) => /\/groups\/90\/children/.test(u))).toBe(true);
    expect(log.some((u) => /scoreboard\?dates=20260912&limit=500&groups=81/.test(u))).toBe(true);
  });

  it('keeps the FBS games when the FCS request fails, and says so', async () => {
    const provider = new EspnProvider(fastFetcher(fixtureFetch({ fail: (u) => (/groups=81/.test(u) ? 503 : null) })));
    const slate = await provider.fetchSlate('cfb', '20260912', { divisions: ['FBS', 'FCS'] });
    expect(slate.failed).toBe(false);
    expect(slate.errors).toEqual([expect.objectContaining({ scope: 'FCS scoreboard', status: 503 })]);
    expect(slate.divisions.find((d) => d.division === 'FCS')?.health).toBe('unavailable');
    expect(slate.games.length).toBe(fixture<Raw>('scoreboard/cfb-20260912-g80.json').events.length);
  });

  it('includes Division II and III when asked', async () => {
    const provider = new EspnProvider(fastFetcher(fixtureFetch()));
    const slate = await provider.fetchSlate('cfb', '20260912', { divisions: ['D2', 'D3'] });
    const d2 = fixture<Raw>('scoreboard/cfb-20260912-g57.json').events.map((e: Raw) => e.id);
    const d3 = fixture<Raw>('scoreboard/cfb-20260912-g58.json').events.map((e: Raw) => e.id);
    expect(slate.games).toHaveLength(new Set([...d2, ...d3]).size);
  });

  it('reports a league failure without inventing games', async () => {
    const provider = new EspnProvider(fastFetcher(fixtureFetch({ fail: () => 500 })));
    const slate = await provider.fetchSlate('nfl', '20260913', { divisions: [] });
    expect(slate.failed).toBe(true);
    expect(slate.games).toEqual([]);
  });
});

describe('game summaries from real fixtures', () => {
  const tbCin = fixture<Raw>('summary/nfl-401872925.json');
  const detail = normalizeSummary(tbCin, 'nfl')!;
  const rawPlays = tbCin.drives.previous.flatMap((d: Raw) => d.plays);

  it('keeps every reported play exactly once, grouped into drives', () => {
    expect(detail.plays).toHaveLength(new Set(rawPlays.map((p: Raw) => p.id)).size);
    expect(detail.drives).toHaveLength(tbCin.drives.previous.length);
    expect(detail.drives.reduce((n, d) => n + d.playIds.length, 0)).toBe(detail.plays.length);
    expect(detail.scoring).toHaveLength(tbCin.scoringPlays.length);
    expect(detail.summary.home.abbreviation).toBe('CIN');
    expect(detail.summary.away.abbreviation).toBe('TB');
  });

  it('places the ball from the reported label, in both possession directions', () => {
    const find = (text: string) => detail.plays.find((p) => p.start?.downDistanceText === text)!;
    // TB (away) at CIN 46: 54 yards from its own goal line, schematic yard 54
    const tb = find('1st & 10 at CIN 46');
    expect(tb.offense).toBe('away');
    expect(tb.start?.spot).toMatchObject({ progress: 54, schematicYard: 54, provenance: 'label' });
    // CIN (home) at its own 20: progress 20, drawn 20 yards from the home goal line
    const cin = find('2nd & 10 at CIN 20');
    expect(cin.offense).toBe('home');
    expect(cin.start?.spot).toMatchObject({ progress: 20, schematicYard: 80 });
  });

  it('classifies only from explicit types, and reads the try from the text', () => {
    const td = detail.plays.filter((p) => p.kind === 'touchdown_rush' || p.kind === 'touchdown_pass' || p.kind === 'touchdown_return');
    const rawTds = rawPlays.filter((p: Raw) => /touchdown/i.test(p.type.text));
    expect(td).toHaveLength(rawTds.length);
    const kicked = td.filter((p) => p.conversion?.kind === 'kick');
    expect(kicked.length).toBeGreaterThan(0);
    expect(detail.plays.filter((p) => p.turnover).length).toBe(rawPlays.filter((p: Raw) => p.isTurnover).length);
  });

  it('never reports a spot outside the field and never disagrees between label and yard line', () => {
    const diag = newDiagnostics();
    for (const name of fixtureNames('summary')) {
      const raw = fixture<Raw>(`summary/${name}`);
      const d = normalizeSummary(raw, name.startsWith('nfl') ? 'nfl' : 'cfb', [], diag);
      if (!d) continue;
      for (const p of d.plays) for (const s of [p.start, p.end]) {
        if (!s || s.spot.progress === null) continue;
        expect(s.spot.progress).toBeGreaterThanOrEqual(0);
        expect(s.spot.progress).toBeLessThanOrEqual(100);
      }
    }
    expect(diag.spotSignalConflicts).toBe(0);
  });

  it('ignores the timeout-calling team as a possession signal', () => {
    const timeouts = detail.plays.filter((p) => p.kind === 'timeout');
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((p) => p.offense === null && p.start?.spot.offense === null)).toBe(true);
  });

  it('trusts the label and the team over a contradictory yards-to-end-zone', () => {
    const raw = fixture<Raw>('summary/cfb-401856673.json');
    const ugaWku = normalizeSummary(raw, 'cfb')!;
    const bad = raw.drives.previous.flatMap((d: Raw) => d.plays).find((p: Raw) => p.end?.possessionText === 'WKU 42' && p.end?.yardsToEndzone === 42);
    expect(bad).toBeTruthy();
    const play = ugaWku.plays.find((p) => p.providerId === bad.id)!;
    const wkuIsAway = ugaWku.summary.away.abbreviation === 'WKU';
    expect(wkuIsAway).toBe(true);
    expect(play.end?.spot.schematicYard).toBe(42); // 42 yards from the away (WKU) goal line
    expect(play.end?.spot.offense).toBe('away');
    expect(play.end?.spot.progress).toBe(42); // WKU at its own 42, not 58
  });

  it('moves a scoring play that was appended after the end of the game back into place', () => {
    const raw = fixture<Raw>('summary/cfb-401872616.json');
    const diag = newDiagnostics();
    const d = normalizeSummary(raw, 'cfb', [], diag)!;
    expect(diag.reorderedPlays).toBeGreaterThan(0);
    const moved = d.plays.find((p) => p.description.startsWith('LaSalle Rose Jr. 19 Yd pass'))!;
    const t = (p: { wallclock: string | null }) => Date.parse(p.wallclock as string);
    // In the provider's order the play sat after plays logged more than an hour later.
    const rawPlays = raw.drives.previous.flatMap((dr: Raw) => dr.plays);
    const rawIndex = rawPlays.findIndex((p: Raw) => p.id === moved.providerId);
    expect(rawPlays.slice(0, rawIndex).some((p: Raw) => Date.parse(p.wallclock) - t(moved) > 60 * 60_000)).toBe(true);
    // After ordering, its neighbours bracket its own wall-clock time.
    expect(moved.order).toBeLessThan(d.plays.length - 1);
    expect(t(d.plays[moved.order + 1])).toBeGreaterThanOrEqual(t(moved));
    expect(t(d.plays[moved.order - 1])).toBeLessThanOrEqual(t(moved));
  });

  it('treats a summary without play-by-play as score-only coverage', () => {
    const scoreOnly = fixtureNames('summary')
      .map((n) => fixture<Raw>(`summary/${n}`))
      .filter((s) => s.header.competitions[0].playByPlaySource === 'none');
    for (const s of scoreOnly) {
      const d = normalizeSummary(s, 'cfb')!;
      expect(d.summary.coverage.level).toBe('score-only');
      expect(d.plays).toEqual([]);
    }
  });
});

describe('live situation (test scenario shaped like the provider)', () => {
  const summary = normalizeScoreboardEvent(fixture<Raw>('scoreboard/nfl-20260913.json').events[0], 'nfl', ['NFL'])!;
  const ctx = { league: 'nfl' as const, gameId: summary.id, home: summary.home, away: summary.away };

  it('reads down, distance, possession, spot and red zone', () => {
    const s = normalizeSituation(
      { down: 1, distance: 5, yardLine: 5, possession: summary.away.providerId, possessionText: `${summary.home.abbreviation} 5`, downDistanceText: `1st & Goal at ${summary.home.abbreviation} 5`, isRedZone: true, homeTimeouts: 2, awayTimeouts: 3 },
      ctx,
    )!;
    expect(s.possession).toBe('away');
    expect(s.goalToGo).toBe(true);
    expect(s.spot).toMatchObject({ progress: 95, schematicYard: 95, provenance: 'label', phase: 'pre-snap' });
    expect(s.isRedZone).toBe(true);
    expect(s.timeouts).toEqual({ home: 2, away: 3 });
  });

  it('reports an unknown spot rather than midfield when nothing locates the ball', () => {
    const s = normalizeSituation({ down: 2, distance: 7, possession: summary.home.providerId }, ctx)!;
    expect(s.spot.progress).toBeNull();
    expect(s.spot.schematicYard).toBeNull();
    expect(s.spot.provenance).toBe('unknown');
  });

  it('treats 0 and 0 as missing unless the away team just scored', () => {
    const missing = resolveSpot({ label: null, yardLine: 0, yardsToEndzone: 0, team: 'home' }, ctx, { phase: 'post-play', sourceTime: null });
    expect(missing.schematicYard).toBeNull();
    const score = resolveSpot({ label: null, yardLine: 0, yardsToEndzone: 0, team: 'away' }, ctx, { phase: 'post-play', sourceTime: null, scoring: true });
    expect(score).toMatchObject({ schematicYard: 100, progress: 100 });
  });
});

describe('classification text rules', () => {
  it('maps observed provider types', () => {
    expect(classifyPlayType('Passing Touchdown')).toBe('touchdown_pass');
    expect(classifyPlayType('Interception Return Touchdown')).toBe('touchdown_return');
    expect(classifyPlayType('Blocked Punt Touchdown')).toBe('touchdown_return');
    expect(classifyPlayType('Sack Opp Fumble Recovery')).toBe('fumble_lost');
    expect(classifyPlayType('Pass Interception Return')).toBe('interception');
    expect(classifyPlayType('Two-minute warning')).toBe('two_minute_warning');
    expect(classifyPlayType('Official Timeout')).toBe('timeout');
    expect(classifyPlayType('Something Unseen')).toBe('other');
    expect(classifyPlayType(null)).toBe('other');
  });
  it('reads conversions and reviews only when the text states them', () => {
    expect(parseConversion('... TOUCHDOWN. E.Pineiro extra point is GOOD, Center-J.Weeks')).toEqual({ kind: 'kick', result: 'good' });
    expect(parseConversion('... TOUCHDOWN. D.Stevens extra point is Blocked (J.Carter)')).toEqual({ kind: 'kick', result: 'blocked' });
    expect(parseConversion('... TOUCHDOWN, clock 11:28 #91 P.Woodring kick attempt good (H: #14)')).toEqual({ kind: 'kick', result: 'good' });
    expect(parseConversion('TWO-POINT CONVERSION ATTEMPT. J.Allen pass to K.Shakir is complete. ATTEMPT SUCCEEDS.')).toEqual({ kind: 'two-point', result: 'good' });
    expect(parseConversion('J.Burrow pass short left to M.Gesicki for 2 yards, TOUCHDOWN.')).toBeNull();
    expect(parseReview('Tampa Bay challenged the pass completion ruling, and the play was REVERSED.')).toEqual({ outcome: 'reversed' });
    expect(parseReview('The Replay Official reviewed the runner was down ruling, and the play was Upheld.')).toEqual({ outcome: 'upheld' });
    expect(parseReview('B.Robinson left end for 4 yards')).toBeNull();
  });
});
