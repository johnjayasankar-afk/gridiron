import { afterEach, describe, expect, it } from 'vitest';
import { GridironEngine, type ClientInterest, type EngineMessage } from '../server/engine';
import type { ProviderPushEvent, SportsProvider } from '../server/providers/types';
import type { GameSummary } from '../shared/model';
import { detail, game, play } from './helpers/builders';

const TODAY = '20260914';
const interest = (o: Partial<ClientInterest> = {}): ClientInterest => ({ date: TODAY, divisions: ['FBS'], focus: [], visible: [], monitored: [], alertsAllGames: false, ...o });

function pushProvider(base: GameSummary) {
  let listener: ((event: ProviderPushEvent) => void) | null = null;
  let unsubscribed = 0;
  const provider: SportsProvider = {
    info: { id: 'push', name: 'Push test', description: 'test', licensed: true, push: true, divisions: ['NFL'] },
    async fetchSlate(league, date) {
      return { league, dateKey: date, games: league === 'nfl' ? [base] : [], divisions: [], errors: [], failed: false, receivedAt: Date.now(), discovery: '', limitations: [] };
    },
    async fetchDetail() {
      return { ok: true, detail: detail(base, []), receivedAt: Date.now() };
    },
    subscribe(onEvent) {
      listener = onEvent;
      return () => {
        listener = null;
        unsubscribed++;
      };
    },
  };
  return { provider, push: (event: ProviderPushEvent) => listener?.(event), subscribed: () => listener !== null, unsubscribed: () => unsubscribed };
}

describe('GridironEngine with a push provider', () => {
  let engine: GridironEngine | null = null;
  afterEach(() => {
    engine?.stop();
    engine = null;
  });

  const make = (provider: SportsProvider) => {
    engine = new GridironEngine({ provider, mode: 'live', today: () => TODAY });
    return engine;
  };

  it('subscribes while running and unsubscribes on stop', () => {
    const fake = pushProvider(game({ id: 'nfl-1' }));
    const e = make(fake.provider);
    expect(fake.subscribed()).toBe(false);
    e.start();
    expect(fake.subscribed()).toBe(true);
    e.stop();
    expect(fake.subscribed()).toBe(false);
    expect(fake.unsubscribed()).toBe(1);
  });

  it('merges a pushed summary into the slate and tells clients, like a poll', async () => {
    const base = game({ id: 'nfl-1', home: 0, away: 0 });
    const fake = pushProvider(base);
    const e = make(fake.provider);
    e.start();
    const messages: EngineMessage[] = [];
    e.connect('client-1234', interest(), (m) => messages.push(m));
    await e.getSlate(TODAY);
    messages.length = 0;
    fake.push({ gameId: 'nfl-1', kind: 'summary', summary: { ...base, score: { home: 7, away: 0 } }, receivedAt: Date.now() + 1_000 });
    const delta = messages.find((m): m is Extract<EngineMessage, { type: 'slate-delta' }> => m.type === 'slate-delta');
    expect(delta?.upserts[0]?.score).toEqual({ home: 7, away: 0 });
    expect(e.knownSummary('nfl-1')?.score.home).toBe(7);
  });

  it('versions pushed detail for followed games and ignores an older push', async () => {
    const base = game({ id: 'nfl-1' });
    const fake = pushProvider(base);
    const e = make(fake.provider);
    e.start();
    const messages: EngineMessage[] = [];
    e.connect('client-1234', interest({ focus: ['nfl-1'] }), (m) => messages.push(m));
    await e.getSlate(TODAY);
    await e.getDetail('nfl-1');
    const before = e.peekDetail('nfl-1')!;
    messages.length = 0;

    const later = Date.now() + 2_000;
    fake.push({ gameId: 'nfl-1', kind: 'detail', detail: detail(base, [play({ n: 1, gameId: 'nfl-1' })]), receivedAt: later });
    const after = e.peekDetail('nfl-1')!;
    expect(after.version).toBe(before.version + 1);
    expect(after.detail?.plays).toHaveLength(1);
    expect(messages.some((m) => (m.type === 'detail' || m.type === 'detail-delta') && m.gameId === 'nfl-1')).toBe(true);

    fake.push({ gameId: 'nfl-1', kind: 'detail', detail: detail(base, []), receivedAt: later - 60_000 });
    expect(e.peekDetail('nfl-1')!.version).toBe(after.version);
    expect(e.peekDetail('nfl-1')!.detail?.plays).toHaveLength(1);
  });

  it('keeps no detail for games nobody follows, but still updates their score', async () => {
    const base = game({ id: 'nfl-1', home: 0, away: 0 });
    const fake = pushProvider(base);
    const e = make(fake.provider);
    e.start();
    e.connect('client-1234', interest(), () => {});
    await e.getSlate(TODAY);
    fake.push({ gameId: 'nfl-1', kind: 'detail', detail: detail({ ...base, score: { home: 3, away: 0 } }, [play({ n: 1, gameId: 'nfl-1' })]), receivedAt: Date.now() + 1_000 });
    expect(e.peekDetail('nfl-1')).toBeNull();
    expect(e.knownSummary('nfl-1')?.score.home).toBe(3);
  });

  it('ignores pushes after stop', async () => {
    const base = game({ id: 'nfl-1', home: 0, away: 0 });
    const fake = pushProvider(base);
    const e = make(fake.provider);
    e.start();
    e.connect('client-1234', interest(), () => {});
    await e.getSlate(TODAY);
    const push = fake.push;
    e.stop();
    push({ gameId: 'nfl-1', kind: 'summary', summary: { ...base, score: { home: 9, away: 0 } }, receivedAt: Date.now() + 1_000 });
    expect(e.knownSummary('nfl-1')?.score.home).toBe(0);
  });
});
