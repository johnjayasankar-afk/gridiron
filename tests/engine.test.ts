import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameDetail, GameSummary, LeagueId } from '../shared/model';
import { GridironEngine, type ClientInterest, type EngineMessage } from '../server/engine';
import type { DetailResult, SlateResult, SportsProvider } from '../server/providers/types';
import { detail, game, play } from './helpers/builders';

const TODAY = '20260914';
const YESTERDAY = '20260913';

type SlateImpl = (league: LeagueId, date: string) => Promise<Partial<SlateResult>>;

function fakeProvider() {
  const calls: string[] = [];
  const active = new Map<string, number>();
  let peak = 0;
  let slate: SlateImpl = async () => ({});
  let detailFn: (id: string) => Promise<DetailResult> = async () => ({ ok: false, error: { scope: 'detail', message: 'not found', status: 404 }, receivedAt: Date.now() });
  const provider: SportsProvider = {
    info: { id: 'fake', name: 'Fake', description: 'test', licensed: false, push: false, divisions: ['NFL', 'FBS'] },
    async fetchSlate(league, date) {
      const key = `slate|${league}|${date}`;
      calls.push(key);
      active.set(key, (active.get(key) ?? 0) + 1);
      peak = Math.max(peak, active.get(key)!);
      try {
        const r = await slate(league, date);
        return { league, dateKey: date, games: [], divisions: [], errors: [], failed: false, receivedAt: Date.now(), discovery: '', limitations: [], ...r };
      } finally {
        active.set(key, active.get(key)! - 1);
      }
    },
    async fetchDetail(id) {
      calls.push(`detail|${id}`);
      return detailFn(id);
    },
  };
  return {
    provider,
    calls,
    peak: () => peak,
    setSlate: (f: SlateImpl) => (slate = f),
    setDetail: (f: (id: string) => Promise<DetailResult>) => (detailFn = f),
  };
}

const interest = (o: Partial<ClientInterest> = {}): ClientInterest => ({ date: TODAY, divisions: ['FBS'], focus: [], visible: [], monitored: [], alertsAllGames: false, ...o });
const count = (calls: string[], key: string) => calls.filter((c) => c === key).length;

describe('GridironEngine', () => {
  let engine: GridironEngine;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T18:00:00Z'));
  });
  afterEach(() => {
    engine?.stop();
    vi.useRealTimers();
  });

  const make = (p: SportsProvider) => {
    engine = new GridironEngine({ provider: p, mode: 'live', today: () => TODAY, random: () => 0.5 });
    engine.start();
    return engine;
  };

  it('polls each league once per day however many clients are watching', async () => {
    const f = fakeProvider();
    f.setSlate(async (league) => ({ games: league === 'nfl' ? [game({ id: 'nfl-1' })] : [] }));
    const e = make(f.provider);
    for (let i = 0; i < 16; i++) e.connect(`c${i}`, interest({ visible: ['nfl-1'] }), () => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count(f.calls, `slate|nfl|${TODAY}`)).toBe(1);
    expect(count(f.calls, `slate|cfb|${TODAY}`)).toBe(1);
    await vi.advanceTimersByTimeAsync(26_000);
    expect(count(f.calls, `slate|nfl|${TODAY}`)).toBe(2); // one loop, on the live interval
    expect(f.calls.filter((c) => c.startsWith('detail|nfl-1')).length).toBeLessThanOrEqual(2);
  });

  it('never runs a slow poll on top of itself', async () => {
    const f = fakeProvider();
    f.setSlate(async () => {
      await new Promise((r) => setTimeout(r, 60_000));
      return { games: [game({ id: 'nfl-1' })] };
    });
    make(f.provider);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(f.peak()).toBe(1);
  });

  it('keeps known games and marks them stale when the provider fails', async () => {
    const f = fakeProvider();
    let fail = false;
    f.setSlate(async (league) => (league === 'nfl' ? (fail ? { failed: true, errors: [{ scope: 'NFL scoreboard', message: 'HTTP 503', status: 503 }] } : { games: [game({ id: 'nfl-1' }), game({ id: 'nfl-2' })] }) : {}));
    const e = make(f.provider);
    await vi.advanceTimersByTimeAsync(100);
    fail = true;
    await e.refreshLeague('nfl', TODAY);
    const snap = e.snapshot(TODAY);
    expect(snap.games.map((g) => g.id).sort()).toEqual(['nfl-1', 'nfl-2']);
    expect(snap.freshness.nfl.health).toBe('stale');
    expect(snap.freshness.nfl.error).toContain('HTTP 503');
  });

  it('records a successful fetch without claiming the game changed', async () => {
    const f = fakeProvider();
    f.setSlate(async (league) => ({ games: league === 'nfl' ? [game({ id: 'nfl-1' })] : [] }));
    const e = make(f.provider);
    await vi.advanceTimersByTimeAsync(100);
    const first = e.snapshot(TODAY).freshness.nfl;
    vi.advanceTimersByTime(5_000);
    await e.refreshLeague('nfl', TODAY);
    const second = e.snapshot(TODAY).freshness.nfl;
    expect(second.lastSuccessAt).not.toBe(first.lastSuccessAt);
    expect(second.lastChangeAt).toBe(first.lastChangeAt);
  });

  it('serves one league while the other is unavailable', async () => {
    const f = fakeProvider();
    f.setSlate(async (league) => (league === 'nfl' ? { failed: true, errors: [{ scope: 'NFL scoreboard', message: 'timeout', status: null }] } : { games: [game({ id: 'cfb-9', league: 'cfb' })] }));
    const e = make(f.provider);
    const snap = await e.getSlate(TODAY);
    expect(snap.freshness.nfl.health).toBe('unavailable');
    expect(snap.freshness.cfb.health).toBe('connected');
    expect(snap.games.map((g) => g.id)).toEqual(['cfb-9']);
  });

  it('does not drop games from a division whose request failed', async () => {
    const f = fakeProvider();
    let round = 0;
    f.setSlate(async (league) => {
      if (league === 'nfl') return {};
      round++;
      const fbs = game({ id: 'cfb-1', league: 'cfb', divisions: ['FBS'] });
      const fcs = game({ id: 'cfb-2', league: 'cfb', divisions: ['FCS'] });
      return round === 1
        ? { games: [fbs, fcs], divisions: [{ division: 'FBS', label: 'FBS', providerGroupId: '80', games: 1, health: 'connected' }, { division: 'FCS', label: 'FCS', providerGroupId: '81', games: 1, health: 'connected' }] }
        : { games: [fbs], errors: [{ scope: 'FCS scoreboard', message: 'HTTP 500', status: 500 }], divisions: [{ division: 'FBS', label: 'FBS', providerGroupId: '80', games: 1, health: 'connected' }, { division: 'FCS', label: 'FCS', providerGroupId: '81', games: 0, health: 'unavailable' }] };
    });
    const e = make(f.provider);
    e.connect('a', interest({ divisions: ['FBS', 'FCS'] }), () => {});
    await e.refreshLeague('cfb', TODAY);
    await e.refreshLeague('cfb', TODAY);
    const snap = e.snapshot(TODAY);
    expect(snap.games.map((g) => g.id).sort()).toEqual(['cfb-1', 'cfb-2']);
    expect(snap.freshness.cfb.health).toBe('stale');
  });

  it('stops polling a game when its last viewer leaves', async () => {
    const f = fakeProvider();
    const g = game({ id: 'nfl-7' });
    f.setSlate(async (league) => ({ games: league === 'nfl' ? [g] : [] }));
    f.setDetail(async () => ({ ok: true, detail: detail(g, [play({ n: 1, gameId: 'nfl-7' })]), receivedAt: Date.now() }));
    const e = make(f.provider);
    const disconnect = e.connect('a', interest({ focus: ['nfl-7'] }), () => {});
    await vi.advanceTimersByTimeAsync(30_000);
    const before = count(f.calls, 'detail|nfl-7');
    expect(before).toBeGreaterThanOrEqual(2);
    disconnect();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(count(f.calls, 'detail|nfl-7')).toBeLessThanOrEqual(before + 1);
    expect(e.stats().tasks.some((t) => t.key === 'detail|nfl-7')).toBe(false);
  });

  it('sends a delta to a client holding the previous version and full detail to a newcomer', async () => {
    const f = fakeProvider();
    const g: GameSummary = game({ id: 'nfl-3' });
    let plays = [play({ n: 1, gameId: 'nfl-3' })];
    f.setSlate(async (league) => ({ games: league === 'nfl' ? [g] : [] }));
    f.setDetail(async () => ({ ok: true, detail: detail(g, plays), receivedAt: Date.now() }));
    const e = make(f.provider);
    const a: EngineMessage[] = [];
    e.connect('a', interest({ focus: ['nfl-3'] }), (m) => a.push(m));
    await e.refreshDetail('nfl-3');
    plays = [...plays, play({ n: 2, gameId: 'nfl-3' })];
    await e.refreshDetail('nfl-3');
    const detailMessages = a.filter((m) => m.type === 'detail' || m.type === 'detail-delta');
    expect(detailMessages.map((m) => m.type)).toEqual(['detail', 'detail-delta']);
    const delta = detailMessages[1] as Extract<EngineMessage, { type: 'detail-delta' }>;
    expect(delta.delta.upserts.map((p) => p.id)).toEqual(['nfl-3:p2']);
    const b: EngineMessage[] = [];
    e.connect('b', interest({ focus: ['nfl-3'] }), (m) => b.push(m));
    const full = b.find((m) => m.type === 'detail') as Extract<EngineMessage, { type: 'detail' }>;
    expect((full.detail as GameDetail).plays).toHaveLength(2);
  });

  it("keeps polling yesterday while one of its games runs past midnight, then lets it go", async () => {
    const f = fakeProvider();
    let lateGame = game({ id: 'cfb-5', league: 'cfb', kind: 'in_progress', period: 4 });
    f.setSlate(async (league, date) => ({ games: league === 'cfb' && date === YESTERDAY ? [lateGame] : [] }));
    make(f.provider);
    await vi.advanceTimersByTimeAsync(60_000);
    const whileLive = count(f.calls, `slate|cfb|${YESTERDAY}`);
    expect(whileLive).toBeGreaterThanOrEqual(2);
    lateGame = game({ id: 'cfb-5', league: 'cfb', kind: 'final', period: 4 });
    await vi.advanceTimersByTimeAsync(30_000);
    const afterFinal = count(f.calls, `slate|cfb|${YESTERDAY}`);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(count(f.calls, `slate|cfb|${YESTERDAY}`)).toBe(afterFinal);
  });
});
