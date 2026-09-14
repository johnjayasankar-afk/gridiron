import { describe, expect, it } from 'vitest';
import { newDiagnostics, normalizeSummary } from '../server/providers/espn/normalize';
import { buildTimeline, summaryAt, visiblePlays, visibleWinProbability } from '../server/replay/timeline';
import { applyDetailDelta, computeDetailDelta } from '../shared/detailDelta';
import { UNKNOWN_SPOT, type GameDetail, type GameSummary, type Situation } from '../shared/model';
import { mergeSummaries } from '../shared/situation';
import { currentWinProbability, lastSwing, predictorShare, probabilityAtPlay, winProbabilitySeries } from '../shared/winProbability';
import { fixture } from './helpers/fixtures';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Arizona at the Chargers, 13 September 2026: a captured final with ESPN's win probability after each play. */
const arizonaAtChargers = (): GameDetail => normalizeSummary(fixture<Raw>('summary/nfl-401872926.json'), 'nfl', ['NFL'], newDiagnostics())!;

const situationAt = (playId: string): Situation => ({
  possession: 'home',
  down: 1,
  distance: 10,
  goalToGo: false,
  downDistanceText: null,
  spot: UNKNOWN_SPOT,
  isRedZone: null,
  timeouts: { home: null, away: null },
  lastPlay: { id: playId, kind: 'rush', description: 'Run', yards: 3, team: 'home' },
});

const liveCopy = (summary: GameSummary, patch: Partial<GameSummary>): GameSummary => ({ ...summary, status: { ...summary.status, kind: 'in_progress' }, ...patch });

describe('win probability', () => {
  it('places every reported value on the game clock, in order, with the biggest swings marked', () => {
    const detail = arizonaAtChargers();
    const series = winProbabilitySeries(detail.summary, detail)!;
    expect(series.points).toHaveLength(detail.winProbability!.length);
    for (let i = 1; i < series.points.length; i++) expect(series.points[i].x).toBeGreaterThanOrEqual(series.points[i - 1].x);
    expect(series.points[series.points.length - 1].x).toBeLessThanOrEqual(1);
    expect(series.swings.length).toBeLessThanOrEqual(5);
    for (const s of series.swings) expect(Math.abs(s.swing as number)).toBeGreaterThanOrEqual(0.1);
    expect(series.points.at(-1)?.home).toBe(detail.winProbability!.at(-1)?.home);
    expect(winProbabilitySeries(detail.summary, { ...detail, winProbability: [] })).toBeNull();
  });

  it('shows the latest value: the detail, unless the summary is already at a newer play', () => {
    const detail = arizonaAtChargers();
    const last = detail.winProbability!.at(-1)!;
    expect(currentWinProbability(detail.summary, detail)?.home).toBe(last.home);
    const ahead = liveCopy(detail.summary, { situation: situationAt('nfl-401872926:newer'), winProbability: { home: 0.3, tie: 0, playId: 'nfl-401872926:newer', source: 'ESPN' } });
    expect(currentWinProbability(ahead, detail)?.home).toBe(0.3);
    expect(currentWinProbability(ahead, null)?.home).toBe(0.3);
  });

  it('reads the value and swing at a given play, and the swing of the latest play', () => {
    const detail = arizonaAtChargers();
    const series = detail.winProbability!;
    const at = probabilityAtPlay(detail, series[10].playId)!;
    expect(at.home).toBe(series[10].home);
    expect(at.swing).toBeCloseTo(series[10].home - series[9].home, 12);
    expect(probabilityAtPlay(detail, 'nfl-401872926:missing')).toBeNull();
    expect(lastSwing(detail)).toBeCloseTo(series.at(-1)!.home - series.at(-2)!.home, 12);
    expect(predictorShare({ home: 0.596, away: 0.401, source: 'ESPN' })).toBeCloseTo(0.5978, 4);
  });

  it('sends the series in a detail delta only when it changed', () => {
    const detail = arizonaAtChargers();
    expect('winProbability' in computeDetailDelta(detail, detail, 1, 2)).toBe(false);
    const earlier = { ...detail, winProbability: detail.winProbability!.slice(0, -1) };
    const delta = computeDetailDelta(earlier, detail, 1, 2);
    expect(delta.winProbability).toHaveLength(detail.winProbability!.length);
    expect(applyDetailDelta(earlier, delta).winProbability).toEqual(detail.winProbability);
    const cleared = computeDetailDelta(detail, { ...detail, winProbability: undefined }, 2, 3);
    expect(cleared.winProbability).toEqual([]);
  });

  it('merges reports without erasing lines, and keeps a win probability only while it is still for the latest play', () => {
    const detail = arizonaAtChargers();
    const base = liveCopy(detail.summary, { lines: detail.summary.lines, market: null });
    const held = liveCopy(base, { receivedAt: 1, situation: situationAt('p1'), winProbability: { home: 0.7, tie: 0, playId: 'p1', source: 'ESPN' }, market: { source: 'Kalshi', moneyline: null, spread: null, total: null, changedAt: 'then', stale: false } });
    const samePlay = { ...liveCopy(base, { receivedAt: 2, situation: situationAt('p1') }), lines: undefined, winProbability: undefined, market: undefined };
    const merged = mergeSummaries(held, samePlay);
    expect(merged.lines).toEqual(detail.summary.lines);
    expect(merged.winProbability?.home).toBe(0.7);
    expect(merged.market?.source).toBe('Kalshi');
    const nextPlay = { ...samePlay, situation: situationAt('p2') };
    expect(mergeSummaries(held, nextPlay).winProbability).toBeUndefined();
    expect(mergeSummaries(held, { ...samePlay, market: null }).market).toBeNull();
  });

  it('replays win probability only up to the replay clock', () => {
    const event = fixture<Raw>('scoreboard/nfl-20260913.json').events.find((e: Raw) => String(e.id) === '401872926');
    const timeline = buildTimeline('nfl', event, fixture<Raw>('summary/nfl-401872926.json'), ['NFL']);
    expect(visibleWinProbability(timeline, visiblePlays(timeline, timeline.kickoffAt - 1))).toEqual([]);

    const tv = timeline.plays[Math.floor(timeline.plays.length / 2)].t;
    const visible = visiblePlays(timeline, tv);
    const shown = new Set(visible.map((p) => String(p.raw.id)));
    const known = new Set(timeline.plays.map((p) => String(p.raw.id)));
    const entries = visibleWinProbability(timeline, visible);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.length).toBeLessThan(timeline.summary.winprobability.length);
    for (const e of entries) expect(!known.has(String(e.playId)) || shown.has(String(e.playId))).toBe(true);

    const detail = normalizeSummary(summaryAt(timeline, tv), 'nfl', ['NFL'], newDiagnostics())!;
    expect(detail.winProbability).toHaveLength(entries.length);
    expect(detail.summary.lines?.provider).toBe('DraftKings');
  });
});
