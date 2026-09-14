import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { progressFromLabel } from '../shared/field';
import { parseGameId, type GameStatusKind, type LeagueId } from '../shared/model';
import { boxscoreUrl, playByPlayUrl, pushEventsUrl, seasonScheduleUrl, SportradarClient } from '../server/providers/sportradar/client';
import { ApiKey, describeSportradarConfig, loadSportradarConfig, SportradarConfigError } from '../server/providers/sportradar/config';
import {
  classifyPlay,
  easternDayOf,
  newSportradarDiagnostics,
  normalizeBoxscore,
  normalizePlayByPlay,
  normalizeStatus,
  orderBySequence,
  parseSchedule,
  parseSportradarGameId,
  SportradarShapeError,
  sportradarGameId,
  summaryFromSchedule,
} from '../server/providers/sportradar/normalize';
import { SportradarProvider, type PushStreamLike } from '../server/providers/sportradar/provider';
import type { PushStreamEvent } from '../server/providers/sportradar/push';
import type { ProviderPushEvent } from '../server/providers/types';

type Raw = Record<string, any>;

const FIXTURES = new URL('../fixtures/sportradar/', import.meta.url);
const fixture = <T = Raw>(name: string): T => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const GAME_CLOSED = '0a000000-0000-4000-8000-000000000001';
const GAME_LIVE = '0a000000-0000-4000-8000-000000000002';
const GAME_LATER = '0a000000-0000-4000-8000-000000000003';
const HCG = '7e000000-0000-4000-8000-000000000001'; // home in the live game
const RMC = '7e000000-0000-4000-8000-000000000002'; // away in the live game
const NFL_KEY = 'test-nfl-key-not-real';

const closedBoxscore = {
  id: GAME_CLOSED,
  status: 'closed',
  scheduled: '2026-09-13T17:00:00+00:00',
  clock: '00:00',
  quarter: 4,
  summary: {
    home: { id: '7e000000-0000-4000-8000-000000000003', alias: 'LKP', name: 'Pilots', market: 'Lakeport', points: 24, remaining_timeouts: 0 },
    away: { id: '7e000000-0000-4000-8000-000000000004', alias: 'IVF', name: 'Forge', market: 'Iron Valley', points: 20, remaining_timeouts: 1 },
  },
};

const boxscoreWith = (situation: Raw | undefined) => {
  const box = fixture('nfl-boxscore-inprogress.json');
  box.situation = situation;
  return box;
};
const loc = (id: string, alias: string, yardline: number) => ({ id, alias, yardline });

describe('Sportradar game ids', () => {
  it('fits the GameId format with a distinct provider namespace and round-trips the UUID', () => {
    const id = sportradarGameId('nfl', GAME_LIVE);
    expect(id).toBe('nfl-sr:0a000000_0000_4000_8000_000000000002');
    expect(parseGameId(id)).toEqual({ league: 'nfl', providerEventId: 'sr:0a000000_0000_4000_8000_000000000002' });
    expect(parseSportradarGameId(id)).toEqual({ league: 'nfl', uuid: GAME_LIVE });
    expect(sportradarGameId('cfb', GAME_LIVE)).not.toBe(id);
    expect(parseSportradarGameId('nfl-401772834')).toBeNull(); // an ESPN id
    expect(parseSportradarGameId('nfl-sr:not_a_uuid')).toBeNull();
  });
});

describe('Sportradar status mapping', () => {
  const cases: Array<[string, GameStatusKind]> = [
    ['scheduled', 'scheduled'],
    ['created', 'scheduled'],
    ['time-tbd', 'scheduled'],
    ['flex-schedule', 'scheduled'],
    ['if necessary', 'scheduled'],
    ['inprogress', 'in_progress'],
    ['halftime', 'halftime'],
    ['delayed', 'delayed'],
    ['suspended', 'suspended'],
    ['complete', 'final'],
    ['closed', 'final'],
    ['postponed', 'postponed'],
    ['cancelled', 'canceled'],
    ['unnecessary', 'canceled'],
  ];
  it.each(cases)('maps %s to %s', (raw, kind) => {
    const status = normalizeStatus(raw, 2, '07:12');
    expect(status.kind).toBe(kind);
    expect(status.providerCode).toBe(raw);
  });

  it('keeps an unrecognised status as unknown with the provider text, never a guess', () => {
    expect(normalizeStatus('something-new', 2, '07:12')).toMatchObject({ kind: 'unknown', detail: 'something-new', providerCode: 'something-new' });
    expect(normalizeStatus(null, null, null)).toMatchObject({ kind: 'unknown', detail: null, period: null });
  });

  it('keeps the clock only while it can matter and says when a final score is not yet verified', () => {
    expect(normalizeStatus('inprogress', 3, '07:12')).toMatchObject({ period: 3, clock: '07:12', clockSeconds: 432, detail: null });
    expect(normalizeStatus('halftime', 2, '00:00').clock).toBeNull();
    expect(normalizeStatus('scheduled', 0, '15:00')).toMatchObject({ period: null, clock: null });
    expect(normalizeStatus('complete', 4, '00:00').detail).toBe('Final score; stats still being verified');
    expect(normalizeStatus('closed', 5, '00:00')).toMatchObject({ kind: 'final', period: 5, detail: null });
  });
});

describe('Sportradar ball spot and situation', () => {
  it('reads the in-progress boxscore fixture: possession, down and distance, and a spot in the opponent half', () => {
    const g = normalizeBoxscore(fixture('nfl-boxscore-inprogress.json'), 'nfl');
    expect(g.id).toBe(sportradarGameId('nfl', GAME_LIVE));
    expect(g.home).toMatchObject({ providerId: HCG, abbreviation: 'HCG', displayName: 'Harbor City Gulls', shortName: 'Gulls', location: 'Harbor City', logo: null });
    expect(g.status).toMatchObject({ kind: 'in_progress', period: 1, clock: '12:59' });
    expect(g.score).toEqual({ home: 0, away: 7 });
    expect(g.coverage.level).toBe('unknown');
    const s = g.situation!;
    expect(s).toMatchObject({ possession: 'home', down: 3, distance: 7, goalToGo: false, downDistanceText: null, isRedZone: false, timeouts: { home: 2, away: 3 } });
    // HCG (home) has the ball at the RMC 35: 65 yards from its own goal line; RMC defends the schematic 0 end.
    expect(s.spot).toMatchObject({ label: 'RMC 35', offense: 'home', progress: 65, schematicYard: 35, phase: 'pre-snap', provenance: 'label', lateral: null });
    expect(progressFromLabel(s.spot.label, 'home', g)).toBe(65);
  });

  it('places a spot in the offense’s own half', () => {
    const g = normalizeBoxscore(boxscoreWith({ down: 1, yfd: 10, possession: { id: HCG, alias: 'HCG' }, location: loc(HCG, 'HCG', 20) }), 'nfl');
    expect(g.situation!.spot).toMatchObject({ label: 'HCG 20', progress: 20, schematicYard: 80 });
    expect(g.situation!.isRedZone).toBe(false);
    const away = normalizeBoxscore(boxscoreWith({ down: 2, yfd: 4, possession: { id: RMC, alias: 'RMC' }, location: loc(RMC, 'RMC', 30) }), 'nfl');
    expect(away.situation!.spot).toMatchObject({ label: 'RMC 30', progress: 30, schematicYard: 30, offense: 'away' });
  });

  it('places a red zone spot and derives goal to go from yards to go reaching the goal line', () => {
    const g = normalizeBoxscore(boxscoreWith({ down: 1, yfd: 8, possession: { id: RMC, alias: 'RMC' }, location: loc(HCG, 'HCG', 8) }), 'nfl');
    expect(g.situation).toMatchObject({ possession: 'away', down: 1, distance: 8, goalToGo: true, isRedZone: true });
    expect(g.situation!.spot).toMatchObject({ label: 'HCG 8', progress: 92, schematicYard: 92 });
    const mid = normalizeBoxscore(boxscoreWith({ down: 2, yfd: 5, possession: { id: RMC }, location: loc(HCG, 'HCG', 50) }), 'nfl');
    expect(mid.situation!.spot).toMatchObject({ label: '50', progress: 50, schematicYard: 50 });
  });

  it('leaves what it cannot place unknown', () => {
    const tooFar = normalizeBoxscore(boxscoreWith({ down: 1, yfd: 10, possession: { id: HCG }, location: loc(HCG, 'HCG', 61) }), 'nfl');
    expect(tooFar.situation!.spot).toMatchObject({ progress: null, schematicYard: null, provenance: 'unknown', label: null });
    const stranger = normalizeBoxscore(boxscoreWith({ down: 1, yfd: 10, possession: { id: HCG }, location: loc('7e000000-0000-4000-8000-00000000ffff', 'XYZ', 20) }), 'nfl');
    expect(stranger.situation!.spot.provenance).toBe('unknown');
    const noPossession = normalizeBoxscore(boxscoreWith({ down: 1, yfd: 10, location: loc(RMC, 'RMC', 40) }), 'nfl');
    expect(noPossession.situation).toMatchObject({ possession: null, isRedZone: null, goalToGo: null });
    expect(noPossession.situation!.spot).toMatchObject({ schematicYard: 40, progress: null, label: 'RMC 40' });
    const kickoff = normalizeBoxscore(boxscoreWith({ down: 0, yfd: 0, possession: { id: HCG }, location: loc(HCG, 'HCG', 35) }), 'nfl');
    expect(kickoff.situation).toMatchObject({ down: null, distance: null, goalToGo: null });
    expect(normalizeBoxscore(boxscoreWith(undefined), 'nfl').situation).toBeNull();
  });
});

describe('Sportradar play-by-play', () => {
  const detail = normalizePlayByPlay(fixture('nfl-pbp-inprogress.json'), 'nfl');

  it('orders plays by sequence and maps the documented play types', () => {
    expect(detail.plays.map((p) => p.order)).toEqual([...detail.plays.keys()]);
    const sequences = detail.plays.map((p) => p.sequence as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(detail.plays.map((p) => p.kind)).toEqual([
      'kickoff', 'other', 'penalty', 'rush', 'touchdown_pass', 'extra_point', 'kickoff', 'rush', 'other', 'timeout', 'rush',
    ]);
    expect(detail.plays[1].providerType).toEqual({ id: null, text: 'pass' });
    expect(detail.plays.every((p) => p.id === `${detail.gameId}:${p.providerId}`)).toBe(true);
  });

  it('reorders plays that arrive out of sequence', () => {
    const raw = fixture('nfl-pbp-inprogress.json');
    const [first, second] = raw.periods[0].pbp;
    first.events.reverse();
    second.events.reverse();
    raw.periods[0].pbp = [second, first];
    const shuffled = normalizePlayByPlay(raw, 'nfl');
    expect(shuffled.plays.map((p) => p.providerId)).toEqual(detail.plays.map((p) => p.providerId));
    expect(shuffled.drives.map((d) => d.providerId)).toEqual(detail.drives.map((d) => d.providerId));
    expect(orderBySequence([{ sequence: 20, index: 0 }, { sequence: null, index: 1 }, { sequence: 10, index: 2 }]).map((i) => i.index)).toEqual([2, 0, 1]);
  });

  it('reads scoring plays, the scoring team and the score after each play from home_points and away_points', () => {
    const td = detail.plays[4];
    expect(td).toMatchObject({ kind: 'touchdown_pass', scoring: true, scoringTeam: 'away', offense: 'away', scoreAfter: { home: 0, away: 6 }, yards: null });
    expect(td.start!.spot).toMatchObject({ label: 'HCG 45', progress: 55, phase: 'pre-snap' });
    const pat = detail.plays[5];
    expect(pat).toMatchObject({ kind: 'extra_point', scoringTeam: 'away', conversion: { kind: 'kick', result: 'good' }, scoreAfter: { home: 0, away: 7 } });
    expect(detail.scoring.map((s) => [s.kind, s.team, s.scoreAfter.away])).toEqual([['touchdown', 'away', 6], ['conversion', 'away', 7]]);
    expect(detail.plays.filter((p) => p.scoring !== true).every((p) => p.scoringTeam === null)).toBe(true);
    // The timeout event reports no points; a stoppage keeps the score before it.
    expect(detail.plays[9]).toMatchObject({ kind: 'timeout', offense: null, start: null, end: null, scoreAfter: { home: 0, away: 7 } });
  });

  it('reads down and distance, penalties and possession from start and end situations', () => {
    const penalty = detail.plays[2];
    expect(penalty).toMatchObject({ penalty: true, turnover: null });
    expect(penalty.start).toMatchObject({ down: 2, distance: 3, goalToGo: false });
    expect(penalty.end).toMatchObject({ down: 2, distance: 8 });
    expect(detail.plays[3].penalty).toBeNull(); // not reported, so not "false"
    expect(detail.plays[0].possessionChanged).toBe(true);
    const last = detail.plays[10];
    expect(last.end).toMatchObject({ down: 3, distance: 7, goalToGo: false });
    expect(last.end!.spot).toMatchObject({ label: 'RMC 35', progress: 65, phase: 'post-play', provenance: 'label' });
  });

  it('builds drives in sequence and marks the unfinished drive of a live game as current', () => {
    expect(detail.drives).toHaveLength(2);
    expect(detail.drives[0]).toMatchObject({ offense: 'away', result: 'Touchdown', offensivePlays: 3, yards: 75, isCurrent: false, start: null, end: null });
    expect(detail.drives[0].playIds).toHaveLength(6);
    expect(detail.drives[1]).toMatchObject({ offense: 'home', result: null, isCurrent: true });
    expect(detail.drives[1].playIds).toHaveLength(5);
    expect(detail.currentDriveId).toBe(detail.drives[1].id);
    expect(detail.summary.situation).toBeNull(); // play-by-play has no situation block
    expect(detail.summary.coverage).toMatchObject({ playByPlay: true, drives: true, teamStats: false, provider: 'Sportradar' });
    expect(detail.gaps).toEqual([]);
  });

  it('changes a play revision when its content changes', () => {
    const raw = fixture('nfl-pbp-inprogress.json');
    raw.periods[0].pbp[0].events[1].description = 'Corrected description.';
    const revised = normalizePlayByPlay(raw, 'nfl');
    expect(revised.plays[1].revision).not.toBe(detail.plays[1].revision);
    expect(revised.plays[2].revision).toBe(detail.plays[2].revision);
  });

  it('keeps undocumented play and event types generic', () => {
    const raw = fixture('nfl-pbp-inprogress.json');
    raw.periods[0].pbp[0].events[3].play_type = 'kneel_down';
    raw.periods[0].pbp[1].events[3].event_type = 'mystery_event';
    const out = normalizePlayByPlay(raw, 'nfl');
    expect(out.plays[3]).toMatchObject({ kind: 'other', providerType: { text: 'kneel_down' } });
    expect(out.plays[9]).toMatchObject({ kind: 'other', providerType: { text: 'mystery_event' } });
  });
});

describe('Sportradar play classification', () => {
  const play = (play_type: string, scoring_play: boolean | undefined, results: string[] = []) => ({ play_type, scoring_play, details: results.map((result) => ({ category: 'placeholder', result })) });

  it('maps a touchdown by the team in possession to the play type, and by the other team to a return', () => {
    expect(classifyPlay(play('pass', true, ['touchdown']), 'home', 'home')).toBe('touchdown_pass');
    expect(classifyPlay(play('pass', true, ['touchdown']), 'home', 'away')).toBe('touchdown_return');
    expect(classifyPlay(play('rush', true, ['touchdown']), 'away', 'away')).toBe('touchdown_rush');
    expect(classifyPlay(play('punt', true, ['touchdown']), 'away', 'home')).toBe('touchdown_return');
  });

  it('uses only documented results, and stays generic otherwise', () => {
    expect(classifyPlay(play('field_goal', true, ['good']), 'home', 'home')).toBe('field_goal_good');
    expect(classifyPlay(play('field_goal', false, ['good']), 'home', null)).toBe('other');
    expect(classifyPlay(play('field_goal', false, ['no good']), 'home', null)).toBe('other');
    expect(classifyPlay(play('pass', true, ['touchdown']), 'home', null)).toBe('other'); // scorer not known
    expect(classifyPlay(play('pass', false), 'home', null)).toBe('other'); // completion, incompletion, sack and interception are not distinguishable
    expect(classifyPlay(play('rush', false), 'home', null)).toBe('rush');
    expect(classifyPlay(play('extra_point', true, ['good']), 'home', 'home')).toBe('extra_point');
    expect(classifyPlay(play('conversion', true), 'home', 'home')).toBe('two_point');
    expect(classifyPlay(play('kickoff', false), 'home', null)).toBe('kickoff');
    expect(classifyPlay(play('punt', false), 'home', null)).toBe('punt');
    expect(classifyPlay(play('penalty', false), 'home', null)).toBe('penalty');
    expect(classifyPlay(play('free_kick', false), 'home', null)).toBe('other');
    expect(classifyPlay(play('faircatch_kick', false), 'home', null)).toBe('other');
    expect(classifyPlay(play('kneel_down', false), 'home', null)).toBe('other');
  });
});

describe('Sportradar schedules', () => {
  it('reads every game in a schedule and files each under its US Eastern day', () => {
    const entries = parseSchedule(fixture('nfl-week-schedule.json'));
    expect(entries.map((e) => [e.uuid, e.status, e.dateKey])).toEqual([
      [GAME_CLOSED, 'closed', '20260913'],
      [GAME_LIVE, 'inprogress', '20260913'], // 00:20 UTC on the 14th is 8:20 pm Eastern on the 13th
      [GAME_LATER, 'scheduled', '20260914'],
    ]);
    const later = summaryFromSchedule(entries[2], 'nfl');
    expect(later).toMatchObject({ status: { kind: 'scheduled' }, score: { home: null, away: null }, startTime: '2026-09-15T00:15:00+00:00', divisions: ['NFL'] });
    expect(summaryFromSchedule(entries[0], 'nfl').score).toEqual({ home: 24, away: 20 });
    expect(easternDayOf('not a date')).toBeNull();
  });

  it('does not report a kickoff time for a time-tbd game', () => {
    const raw = fixture('nfl-week-schedule.json');
    raw.week.games[2].status = 'time-tbd';
    const [, , tbd] = parseSchedule(raw);
    expect(summaryFromSchedule(tbd, 'nfl')).toMatchObject({ startTime: null, status: { kind: 'scheduled', detail: 'Kickoff time to be determined' } });
    expect(tbd.dateKey).toBe('20260914');
  });
});

describe('malformed Sportradar responses', () => {
  it('throws a clear error for a document that is not the expected shape', () => {
    expect(() => parseSchedule('<html>')).toThrow(SportradarShapeError);
    expect(() => parseSchedule('<html>')).toThrow('Sportradar schedule was not a JSON object');
    expect(() => parseSchedule({ week: { title: '1' } })).toThrow('Sportradar schedule had no games list');
    expect(() => normalizeBoxscore([], 'nfl')).toThrow('Sportradar NFL boxscore was not a JSON object');
    expect(() => normalizeBoxscore({ status: 'inprogress' }, 'nfl')).toThrow('Sportradar NFL boxscore has no game id (expected a UUID in "id")');
    expect(() => normalizeBoxscore({ id: GAME_LIVE }, 'nfl')).toThrow('Sportradar NFL boxscore has no summary with home and away teams');
    expect(() => normalizeBoxscore({ id: GAME_LIVE, summary: { home: { alias: 'HCG' }, away: { id: RMC } } }, 'cfb')).toThrow('Sportradar NCAA football boxscore summary.home has no team id');
    const pbp = fixture('nfl-pbp-inprogress.json');
    expect(() => normalizePlayByPlay({ ...pbp, periods: 'x' }, 'nfl')).toThrow('Sportradar NFL play-by-play has no periods list');
    expect(() => normalizePlayByPlay({ ...pbp, periods: [{ number: 1, pbp: {} }] }, 'nfl')).toThrow('Sportradar NFL play-by-play has a period whose pbp is not a list');
  });

  it('skips and counts individual games that lack the documented fields', () => {
    const raw = fixture('nfl-week-schedule.json');
    raw.week.games.push({ id: 'not-a-uuid', home: { id: 'a' }, away: { id: 'b' } }, { id: GAME_CLOSED.replace('1', '9'), home: {} });
    const diagnostics = newSportradarDiagnostics();
    expect(parseSchedule(raw, diagnostics)).toHaveLength(3);
    expect(diagnostics.invalidGames).toBe(2);
  });
});

describe('Sportradar configuration', () => {
  it('requires at least one key and says which variables to set', () => {
    expect(() => loadSportradarConfig({})).toThrow(SportradarConfigError);
    expect(() => loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: '  ', SPORTRADAR_NCAAFB_API_KEY: '' })).toThrow(/SPORTRADAR_NFL_API_KEY.*SPORTRADAR_NCAAFB_API_KEY/);
  });

  it('defaults to trial access with push off, and ignores push on trial access', () => {
    const c = loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY });
    expect(c).toMatchObject({ accessLevel: 'trial', push: false, warnings: [] });
    expect(c.keys.cfb).toBeNull();
    const pushTrial = loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY, SPORTRADAR_PUSH: 'on' });
    expect(pushTrial.push).toBe(false);
    expect(pushTrial.warnings[0]).toMatch(/production plans only/);
    expect(loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY, SPORTRADAR_PUSH: 'on', SPORTRADAR_ACCESS_LEVEL: 'production' }).push).toBe(true);
    const shared = loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY, SPORTRADAR_NCAAFB_API_KEY: NFL_KEY });
    expect(shared.keys.cfb).toBe(shared.keys.nfl);
  });

  it('rejects invalid values without echoing them', () => {
    expect(() => loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY, SPORTRADAR_ACCESS_LEVEL: 'gold' })).toThrow('SPORTRADAR_ACCESS_LEVEL must be "trial" or "production".');
    expect(() => loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY, SPORTRADAR_PUSH: 'maybe' })).toThrow('SPORTRADAR_PUSH must be "on" or "off".');
    let message = '';
    try {
      loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: 'secret value\n' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/SPORTRADAR_NFL_API_KEY contains spaces/);
    expect(message).not.toContain('secret');
  });

  it('never prints a key through JSON, string conversion or util.inspect', () => {
    const c = loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY, SPORTRADAR_NCAAFB_API_KEY: 'test-cfb-key-not-real' });
    for (const text of [JSON.stringify(c), String(c.keys.nfl), `${c.keys.cfb}`, inspect(c, { depth: 10 }), describeSportradarConfig(c)]) {
      expect(text).not.toContain('not-real');
    }
    expect(c.keys.nfl!.reveal()).toBe(NFL_KEY);
  });
});

describe('SportradarClient', () => {
  const KEY = new ApiKey(NFL_KEY);
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the key only as x-api-key and spaces request starts by the queries-per-second limit', async () => {
    const calls: Array<{ url: string; at: number; key: string | null }> = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), at: Date.now(), key: new Headers(init?.headers).get('x-api-key') });
      return json({ ok: true });
    });
    const client = new SportradarClient({ fetch: impl as unknown as typeof fetch });
    const all = ['a', 'b', 'c'].map((n) => client.getJson(`https://api.sportradar.test/${n}.json`, KEY));
    await vi.advanceTimersByTimeAsync(0);
    expect(impl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(impl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(impl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    const results = await Promise.all(all);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls.map((c) => c.at - calls[0].at)).toEqual([0, 1_000, 2_000]);
    expect(calls.every((c) => c.key === NFL_KEY && !c.url.includes(NFL_KEY))).toBe(true);
  });

  it('shares one query between identical in-flight requests', async () => {
    const impl = vi.fn(async () => json({ ok: true }));
    const client = new SportradarClient({ fetch: impl as unknown as typeof fetch });
    const [a, b] = await Promise.all([client.getJson('https://api.sportradar.test/x.json', KEY), client.getJson('https://api.sportradar.test/x.json', KEY)]);
    expect(a.ok && b.ok).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(client.stats().shared).toBe(1);
  });

  it('backs off after HTTP 429, refusing requests until the back-off ends, and doubles on repeated 429s', async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValue(json({ ok: true }));
    const client = new SportradarClient({ fetch: impl as unknown as typeof fetch, random: () => 1, baseBackoffMs: 2_000 });
    const first = await client.getJson('https://api.sportradar.test/1.json', KEY);
    expect(first).toMatchObject({ ok: false, status: 429 });
    expect(!first.ok && first.error).toMatch(/throttled the request, or the plan's request quota is used up/);
    expect(client.backoffUntil(KEY) - Date.now()).toBe(2_000);

    const refused = await client.getJson('https://api.sportradar.test/2.json', KEY);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/^Not requested: backing off after HTTP 429/);
    expect(impl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    const second = client.getJson('https://api.sportradar.test/3.json', KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect((await second).ok).toBe(false);
    expect(client.backoffUntil(KEY) - Date.now()).toBe(4_000);

    await vi.advanceTimersByTimeAsync(4_000);
    const third = client.getJson('https://api.sportradar.test/4.json', KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect((await third).ok).toBe(true);
    expect(impl).toHaveBeenCalledTimes(3);
    expect(client.stats()).toMatchObject({ throttled: 2, refusedWhileBackingOff: 1, succeeded: 1 });
  });

  it('explains 403 and never puts the key in an error', async () => {
    const client = new SportradarClient({ fetch: (async () => json({ message: 'no' }, 403)) as typeof fetch });
    const r = await client.getJson('https://api.sportradar.test/pbp.json', KEY);
    expect(!r.ok && r.error).toBe('HTTP 403: the API key is not authorized for this feed or access level');
    expect(JSON.stringify(r) + JSON.stringify(client.stats())).not.toContain(NFL_KEY);
  });

  it('builds the documented feed URLs', () => {
    expect(seasonScheduleUrl('nfl', 'trial')).toBe('https://api.sportradar.com/nfl/official/trial/v7/en/games/current_season/schedule.json');
    expect(boxscoreUrl('cfb', 'production', GAME_LIVE)).toBe(`https://api.sportradar.com/ncaafb/production/v7/en/games/${GAME_LIVE}/boxscore.json`);
    expect(playByPlayUrl('nfl', 'trial', GAME_LIVE)).toBe(`https://api.sportradar.com/nfl/official/trial/v7/en/games/${GAME_LIVE}/pbp.json`);
    expect(pushEventsUrl('nfl', 'production')).toBe('https://api.sportradar.com/nfl/official/production/stream/en/events/subscribe');
    expect(pushEventsUrl('cfb', 'production')).toBe('https://api.sportradar.com/ncaafb/production/stream/en/events/subscribe');
  });
});

describe('SportradarProvider', () => {
  const NOW = Date.parse('2026-09-14T00:50:00Z'); // 8:50 pm Eastern on Sunday 13 September
  const nflOnly = () => loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY });

  /** Answers documented feed URLs from fixtures. The season schedule's container is undocumented, so the weekly fixture stands in for it. */
  function feeds(over: Record<string, () => Response> = {}) {
    const log: string[] = [];
    const routes: Record<string, () => Response> = {
      [seasonScheduleUrl('nfl', 'trial')]: () => json(fixture('nfl-week-schedule.json')),
      [boxscoreUrl('nfl', 'trial', GAME_CLOSED)]: () => json(closedBoxscore),
      [boxscoreUrl('nfl', 'trial', GAME_LIVE)]: () => json(fixture('nfl-boxscore-inprogress.json')),
      [playByPlayUrl('nfl', 'trial', GAME_LIVE)]: () => json(fixture('nfl-pbp-inprogress.json')),
      ...over,
    };
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      log.push(url);
      return routes[url]?.() ?? new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { impl, log };
  }

  const provider = (impl: typeof fetch, config = nflOnly(), extra: Partial<ConstructorParameters<typeof SportradarProvider>[1]> = {}) =>
    new SportradarProvider(config, { client: new SportradarClient({ fetch: impl, queriesPerSecond: 1000 }), now: () => NOW, ...extra });

  it('builds a day from the season schedule by Eastern date, reading live and final games from their boxscores', async () => {
    const { impl, log } = feeds();
    const p = provider(impl);
    const slate = await p.fetchSlate('nfl', '20260913', { divisions: [] });
    expect(slate).toMatchObject({ league: 'nfl', dateKey: '20260913', failed: false, errors: [] });
    expect(slate.games.map((g) => [g.id, g.status.kind, g.score.home, g.score.away])).toEqual([
      [sportradarGameId('nfl', GAME_CLOSED), 'final', 24, 20],
      [sportradarGameId('nfl', GAME_LIVE), 'in_progress', 0, 7],
    ]);
    expect(slate.games[1].situation?.spot.label).toBe('RMC 35');
    expect(slate.divisions).toEqual([{ division: 'NFL', label: 'NFL', providerGroupId: null, games: 2, health: 'connected' }]);
    expect(slate.limitations.join(' ')).toMatch(/1 query per second and 1,000 requests per 30 days/);
    expect(log.filter((u) => u.endsWith('schedule.json'))).toHaveLength(1);
    expect(log.filter((u) => u.endsWith('boxscore.json'))).toHaveLength(2);

    const monday = await p.fetchSlate('nfl', '20260914', { divisions: [] });
    expect(monday.games.map((g) => [g.id, g.status.kind, g.score.home])).toEqual([[sportradarGameId('nfl', GAME_LATER), 'scheduled', null]]);
    expect(log.filter((u) => u.endsWith('schedule.json'))).toHaveLength(1); // cached
    expect(log.some((u) => u.includes(GAME_LATER))).toBe(false); // kickoff not reached, so no boxscore
  });

  it('reports a game it could not read instead of filling it from the schedule', async () => {
    const { impl } = feeds({ [boxscoreUrl('nfl', 'trial', GAME_CLOSED)]: () => new Response('down', { status: 500 }) });
    const slate = await provider(impl).fetchSlate('nfl', '20260913', { divisions: [] });
    expect(slate.failed).toBe(false);
    expect(slate.games.map((g) => g.providerEventId)).toEqual(['sr:0a000000_0000_4000_8000_000000000002']);
    expect(slate.errors).toEqual([{ scope: `NFL game ${GAME_CLOSED} boxscore`, message: 'HTTP 500', status: 500 }]);
    expect(slate.divisions[0]).toMatchObject({ health: 'unavailable', label: 'NFL (1 of 2 games could not be read)', games: 1 });
  });

  it('reports the whole league unavailable when the schedule cannot be read', async () => {
    const { impl } = feeds({ [seasonScheduleUrl('nfl', 'trial')]: () => json({ week: {} }) });
    const slate = await provider(impl).fetchSlate('nfl', '20260913', { divisions: [] });
    expect(slate).toMatchObject({ failed: true, games: [], errors: [{ scope: 'NFL schedule', message: 'Sportradar schedule had no games list' }] });
    expect(slate.divisions[0].health).toBe('unavailable');
  });

  it('reports a league without a key as unavailable, with the variable to set', async () => {
    const { impl, log } = feeds();
    const p = provider(impl);
    const slate = await p.fetchSlate('cfb', '20260912', { divisions: ['FBS'] });
    expect(slate.failed).toBe(true);
    expect(slate.errors[0].message).toBe('No Sportradar NCAA football key is configured. Set SPORTRADAR_NCAAFB_API_KEY to read college games.');
    const detail = await p.fetchDetail(sportradarGameId('cfb', GAME_LIVE));
    expect(!detail.ok && detail.error.message).toMatch(/SPORTRADAR_NCAAFB_API_KEY/);
    expect(log).toEqual([]);
    expect(p.info).toMatchObject({ id: 'sportradar', licensed: true, push: false, divisions: ['NFL'] });
    expect(p.subscribe).toBeUndefined();
  });

  it('reads detail from play-by-play and turns failures into unavailable results', async () => {
    const { impl } = feeds();
    const p = provider(impl);
    const ok = await p.fetchDetail(sportradarGameId('nfl', GAME_LIVE));
    expect(ok.ok && ok.detail.plays).toHaveLength(11);
    expect(ok.ok && ok.detail.summary.divisions).toEqual(['NFL']);

    const broken = provider(feeds({ [playByPlayUrl('nfl', 'trial', GAME_LIVE)]: () => json({ ...fixture<Raw>('nfl-pbp-inprogress.json'), periods: 'x' }) }).impl);
    const bad = await broken.fetchDetail(sportradarGameId('nfl', GAME_LIVE));
    expect(bad).toMatchObject({ ok: false, error: { scope: 'Game detail', message: 'Sportradar NFL play-by-play has no periods list', status: null } });

    const denied = provider(feeds({ [playByPlayUrl('nfl', 'trial', GAME_LIVE)]: () => json({}, 403) }).impl);
    const no = await denied.fetchDetail(sportradarGameId('nfl', GAME_LIVE));
    expect(no).toMatchObject({ ok: false, error: { status: 403, message: 'HTTP 403: the API key is not authorized for this feed or access level' } });

    expect(await p.fetchDetail('nfl-401772834')).toMatchObject({ ok: false, error: { message: 'Not a Sportradar game id: nfl-401772834' } });
  });

  it('streams push events as summaries on production access and stops the streams when unsubscribed', async () => {
    const made: Array<{ league: LeagueId; url: string; emit: (e: PushStreamEvent) => void; started: boolean; stopped: boolean }> = [];
    const pushStream = (league: LeagueId, url: string): PushStreamLike => {
      const listeners = new Set<(e: PushStreamEvent) => void>();
      const record = { league, url, emit: (e: PushStreamEvent) => listeners.forEach((l) => l(e)), started: false, stopped: false };
      made.push(record);
      return {
        on: (l) => (listeners.add(l), () => listeners.delete(l)),
        start: () => void (record.started = true),
        stop: async () => void (record.stopped = true),
      };
    };
    const config = loadSportradarConfig({ SPORTRADAR_NFL_API_KEY: NFL_KEY, SPORTRADAR_ACCESS_LEVEL: 'production', SPORTRADAR_PUSH: 'on' });
    const { impl } = feeds({ [seasonScheduleUrl('nfl', 'production')]: () => json(fixture('nfl-week-schedule.json')), [boxscoreUrl('nfl', 'production', GAME_CLOSED)]: () => json(closedBoxscore), [boxscoreUrl('nfl', 'production', GAME_LIVE)]: () => json(fixture('nfl-boxscore-inprogress.json')) });
    const p = provider(impl, config, { pushStream });
    expect(p.info.push).toBe(true);
    await p.fetchSlate('nfl', '20260913', { divisions: [] });

    const received: ProviderPushEvent[] = [];
    const unsubscribe = p.subscribe!((e) => received.push(e));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ league: 'nfl', url: 'https://api.sportradar.com/nfl/official/production/stream/en/events/subscribe', started: true });

    const box = fixture('nfl-boxscore-inprogress.json');
    made[0].emit({
      type: 'message',
      at: NOW,
      message: {
        type: 'event',
        game: { id: GAME_LIVE, status: 'inprogress', quarter: 1, clock: '12:20', summary: { home: { ...box.summary.home, points: 0 }, away: { ...box.summary.away, points: 7 } } },
        event: { type: 'play', id: 'pushed-play', play_type: 'rush', end_situation: { down: 1, yfd: 10, possession: { id: HCG, alias: 'HCG' }, location: loc(RMC, 'RMC', 20) } },
        metadata: { league: 'nfl', match: null, status: 'inprogress', eventType: 'rush', operation: null, version: null },
      },
    });
    made[0].emit({ type: 'message', at: NOW, message: { type: 'event', game: null, event: null, metadata: { league: null, match: null, status: null, eventType: null, operation: null, version: null } } });

    expect(received).toHaveLength(1);
    const summary = received[0].summary!;
    expect(received[0]).toMatchObject({ gameId: sportradarGameId('nfl', GAME_LIVE), kind: 'summary', receivedAt: NOW });
    expect(summary.status).toMatchObject({ kind: 'in_progress', clock: '12:20' });
    expect(summary.startTime).toBe('2026-09-14T00:20:00+00:00'); // kept from the boxscore; the push game has no scheduled time
    expect(summary.situation?.spot).toMatchObject({ label: 'RMC 20', progress: 80, phase: 'post-play' });
    expect(p.diagnostics.unattributedPushEvents).toBe(1);

    unsubscribe();
    expect(made[0].stopped).toBe(true);
  });
});
