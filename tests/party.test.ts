import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartyHub, validatePartyState, type PartyEvent, type PartyState, type Result } from '../server/party';

function baseState(): PartyState {
  return { route: { name: 'slate', id: null }, focusGames: [], source: { kind: 'live' }, inspection: null, delaySeconds: 0, date: null, league: 'all' };
}

/** A valid state with some fields replaced. Untyped on purpose, so invalid shapes can be tried. */
const withState = (fields: Record<string, unknown>): Record<string, unknown> => ({ ...baseState(), ...fields });

const accepts = (value: unknown) => validatePartyState(value).ok;

function errorOf(value: unknown): string {
  const result = validatePartyState(value);
  if (result.ok) throw new Error('Expected the state to be refused');
  return result.error;
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${result.status}: ${result.error}`);
  return result.value;
}

function fakeClock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe('validatePartyState', () => {
  it('accepts a complete state and returns a rebuilt copy', () => {
    const input = {
      route: { name: 'game', id: 'nfl-401' },
      focusGames: ['nfl-401', 'cfb-402', 'nfl-401'],
      source: { kind: 'replay', sessionId: '3f2c9a1e-0000-4000-8000-000000000001' },
      inspection: { gameId: 'nfl-401', playId: 'nfl-401:4012' },
      delaySeconds: 30,
      date: '20260913',
      league: 'nfl',
    };
    const result = validatePartyState(input);
    expect(result).toEqual({ ok: true, state: { ...input, focusGames: ['nfl-401', 'cfb-402'] } });
    if (!result.ok) return;
    expect(result.state.route).not.toBe(input.route);
    expect(result.state.inspection).not.toBe(input.inspection);
  });

  it('keeps only the known fields inside nested objects', () => {
    const result = validatePartyState(withState({ route: { name: 'wall', id: null, note: 'dropped' }, source: { kind: 'live', sessionId: 'abcd-1234' } }));
    expect(result).toEqual({ ok: true, state: { ...baseState(), route: { name: 'wall', id: null } } });
  });

  it('checks route ids against the route name', () => {
    for (const name of ['slate', 'focus', 'wall']) {
      expect(accepts(withState({ route: { name, id: null } }))).toBe(true);
      expect(errorOf(withState({ route: { name, id: 'nfl-401' } }))).toContain('route.id must be null');
      expect(accepts(withState({ route: { name } }))).toBe(false);
    }
    expect(accepts(withState({ route: { name: 'game', id: 'cfb-401' } }))).toBe(true);
    expect(accepts(withState({ route: { name: 'game', id: null } }))).toBe(false);
    expect(accepts(withState({ route: { name: 'game', id: 'mlb-401' } }))).toBe(false);
    expect(accepts(withState({ route: { name: 'team', id: 'nfl-12' } }))).toBe(true);
    expect(accepts(withState({ route: { name: 'team', id: 'cfb-123456' } }))).toBe(true);
    expect(accepts(withState({ route: { name: 'team', id: 'cfb-1234567' } }))).toBe(false);
    expect(accepts(withState({ route: { name: 'team', id: 'nfl-' } }))).toBe(false);
    expect(accepts(withState({ route: { name: 'team', id: 'nfl-abc' } }))).toBe(false);
    expect(accepts(withState({ route: { name: 'team', id: null } }))).toBe(false);
    expect(errorOf(withState({ route: { name: 'settings', id: null } }))).toContain('route.name');
    expect(accepts(withState({ route: 'slate' }))).toBe(false);
  });

  it('allows at most four different, valid focus games and drops repeats', () => {
    const four = ['nfl-1', 'nfl-2', 'cfb-3', 'cfb-4'];
    expect(validatePartyState(withState({ focusGames: [...four, 'nfl-1', 'cfb-4'] }))).toEqual({ ok: true, state: { ...baseState(), focusGames: four } });
    expect(errorOf(withState({ focusGames: [...four, 'nfl-5'] }))).toContain('at most 4');
    expect(errorOf(withState({ focusGames: ['nfl-1', 'nfl 2'] }))).toContain('only game ids');
    expect(accepts(withState({ focusGames: ['nfl-1', 42] }))).toBe(false);
    expect(accepts(withState({ focusGames: 'nfl-1' }))).toBe(false);
  });

  it('accepts a live source or a replay with a valid session id', () => {
    expect(accepts(withState({ source: { kind: 'replay', sessionId: 'abcd-123' } }))).toBe(true);
    expect(accepts(withState({ source: { kind: 'replay', sessionId: 'a'.repeat(64) } }))).toBe(true);
    expect(accepts(withState({ source: { kind: 'replay', sessionId: 'abc-123' } }))).toBe(false);
    expect(accepts(withState({ source: { kind: 'replay', sessionId: 'a'.repeat(65) } }))).toBe(false);
    expect(accepts(withState({ source: { kind: 'replay', sessionId: 'abcd_1234' } }))).toBe(false);
    expect(accepts(withState({ source: { kind: 'replay' } }))).toBe(false);
    expect(errorOf(withState({ source: { kind: 'broadcast' } }))).toContain('source.kind');
    expect(accepts(withState({ source: null }))).toBe(false);
  });

  it('checks the inspected game and play', () => {
    expect(accepts(withState({ inspection: { gameId: 'cfb-401', playId: null } }))).toBe(true);
    expect(accepts(withState({ inspection: { gameId: 'cfb-401', playId: 'cfb-401:40154.1_a-b' } }))).toBe(true);
    expect(accepts(withState({ inspection: { gameId: 'cfb-401', playId: 'p'.repeat(64) } }))).toBe(true);
    expect(accepts(withState({ inspection: { gameId: 'cfb-401', playId: 'p'.repeat(65) } }))).toBe(false);
    expect(accepts(withState({ inspection: { gameId: 'cfb-401', playId: 'play 7' } }))).toBe(false);
    expect(accepts(withState({ inspection: { gameId: 'cfb-401', playId: '' } }))).toBe(false);
    expect(accepts(withState({ inspection: { gameId: 'cfb-401' } }))).toBe(false);
    expect(errorOf(withState({ inspection: { gameId: 'game-401', playId: null } }))).toContain('inspection.gameId');
    expect(accepts(withState({ inspection: 'cfb-401' }))).toBe(false);
  });

  it('requires a whole number delay from 0 to 300 seconds', () => {
    for (const delaySeconds of [0, 45, 300]) expect(accepts(withState({ delaySeconds }))).toBe(true);
    for (const delaySeconds of [-1, 301, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '30', null]) expect(accepts(withState({ delaySeconds }))).toBe(false);
  });

  it('accepts a null date or a date key, and only the all, nfl and cfb leagues', () => {
    expect(accepts(withState({ date: '20260913' }))).toBe(true);
    for (const date of ['2026-09-13', '202609', 20260913]) expect(accepts(withState({ date }))).toBe(false);
    for (const league of ['nfl', 'cfb']) expect(accepts(withState({ league }))).toBe(true);
    for (const league of ['nba', 'NFL', null]) expect(accepts(withState({ league }))).toBe(false);
  });

  it('refuses unknown top-level keys, missing keys and values that are not objects', () => {
    expect(errorOf(withState({ guestName: 'Sam' }))).toContain('guestName');
    const polluted: unknown = JSON.parse(`{"__proto__":{"host":true},${JSON.stringify(baseState()).slice(1)}`);
    expect(errorOf(polluted)).toContain('__proto__');
    for (const key of Object.keys(baseState())) {
      const state = withState({});
      delete state[key];
      expect(accepts(state)).toBe(false);
    }
    for (const value of [null, undefined, 'state', 42, []]) expect(errorOf(value)).toBe('Party state must be an object');
  });

  it('refuses a state over 4,096 bytes of JSON, counting bytes rather than characters', () => {
    const padded = (bytes: number) => {
      const room = bytes - Buffer.byteLength(JSON.stringify(withState({ route: { name: 'slate', id: null, pad: '' } })));
      return withState({ route: { name: 'slate', id: null, pad: 'x'.repeat(room) } });
    };
    expect(Buffer.byteLength(JSON.stringify(padded(4_096)))).toBe(4_096);
    expect(accepts(padded(4_096))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(padded(4_097)))).toBe(4_097);
    expect(errorOf(padded(4_097))).toContain('4096 bytes');

    const wide = withState({ route: { name: 'slate', id: null, pad: 'é'.repeat(2_100) } });
    expect(JSON.stringify(wide).length).toBeLessThan(4_096);
    expect(accepts(wide)).toBe(false);

    const route: Record<string, unknown> = { name: 'slate', id: null };
    route.self = route;
    expect(errorOf(withState({ route }))).toContain('plain JSON');
  });
});

describe('PartyHub', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(options: ConstructorParameters<typeof PartyHub>[0] = {}) {
    const clock = fakeClock();
    return { clock, hub: new PartyHub({ now: clock.now, ...options }) };
  }

  function listen(hub: PartyHub, id: string) {
    const events: PartyEvent[] = [];
    const leave = ok(hub.subscribe(id, (event) => events.push(event)));
    return { events, leave };
  }

  it('creates a party and serves its view', () => {
    const { clock, hub } = setup({ randomId: () => 'party-one', randomToken: () => 'host-token-one' });
    const state = withState({ route: { name: 'game', id: 'nfl-401' }, delaySeconds: 20 });
    const expected = { id: 'party-one', state, rev: 0, members: 0, createdAt: clock.now(), updatedAt: clock.now() };
    expect(ok(hub.create(state))).toEqual({ id: 'party-one', hostToken: 'host-token-one', view: expected });
    clock.advance(5_000);
    expect(hub.view('party-one')).toEqual({ ok: true, value: expected });
    expect(hub.stats()).toEqual({ parties: 1, members: 0 });

    expect(hub.create(withState({ delaySeconds: 301 }))).toEqual({ ok: false, status: 400, error: expect.stringContaining('delaySeconds') });
    // An id that is already taken never replaces the party holding it.
    expect(hub.create(baseState())).toMatchObject({ ok: false, status: 503 });
    expect(hub.stats()).toEqual({ parties: 1, members: 0 });
    expect(ok(hub.update('party-one', 'host-token-one', baseState())).rev).toBe(1);
  });

  it('uses random UUIDs and 32-byte base64url host tokens by default', () => {
    const hub = new PartyHub();
    const first = ok(hub.create(baseState()));
    const second = ok(hub.create(baseState()));
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.hostToken, 'base64url')).toHaveLength(32);
    expect(second.id).not.toBe(first.id);
    expect(second.hostToken).not.toBe(first.hostToken);
  });

  it('never exposes the host token in views or events', () => {
    const { hub } = setup();
    const { id, hostToken, view } = ok(hub.create(baseState()));
    const { events } = listen(hub, id);
    ok(hub.update(id, hostToken, withState({ league: 'cfb' })));
    const latest = ok(hub.view(id));
    ok(hub.end(id, hostToken));
    expect(Object.keys(latest).sort()).toEqual(['createdAt', 'id', 'members', 'rev', 'state', 'updatedAt']);
    for (const seen of [view, latest, ...events]) expect(JSON.stringify(seen)).not.toContain(hostToken);
  });

  it('applies an update with the host token, bumps rev and broadcasts the new view', () => {
    const { clock, hub } = setup();
    const { id, hostToken, view: created } = ok(hub.create(baseState()));
    const a = listen(hub, id);
    const b = listen(hub, id);
    a.events.length = 0;
    b.events.length = 0;
    clock.advance(1_500);
    const next = withState({ route: { name: 'focus', id: null }, focusGames: ['nfl-1', 'nfl-2'] });
    const updated = ok(hub.update(id, hostToken, next));
    expect(updated).toEqual({ id, state: next, rev: 1, members: 2, createdAt: created.createdAt, updatedAt: created.createdAt + 1_500 });
    expect(a.events).toEqual([{ type: 'state', view: updated }]);
    expect(b.events).toEqual([{ type: 'state', view: updated }]);
    expect(ok(hub.view(id))).toEqual(updated);

    // A listener that edits what it received cannot reach the stored state.
    const received = a.events[0];
    if (received.type === 'state') received.view.state.focusGames.push('cfb-9');
    expect(ok(hub.view(id)).state.focusGames).toEqual(['nfl-1', 'nfl-2']);
    expect(ok(hub.update(id, hostToken, baseState())).rev).toBe(2);
  });

  it('refuses a wrong token with 403, an unknown party with 404 and an invalid state with 400', () => {
    const { hub } = setup();
    const { id, hostToken } = ok(hub.create(baseState()));
    const { events } = listen(hub, id);
    const sameLength = `${hostToken.slice(0, -1)}${hostToken.endsWith('A') ? 'B' : 'A'}`;
    for (const token of [sameLength, 'short', '', `${hostToken}x`]) {
      expect(hub.update(id, token, withState({ league: 'nfl' }))).toMatchObject({ ok: false, status: 403 });
      expect(hub.end(id, token)).toMatchObject({ ok: false, status: 403 });
    }
    expect(hub.update(id, 'short', withState({ delaySeconds: -5 }))).toMatchObject({ ok: false, status: 403 });
    expect(hub.update('no-such-party', hostToken, baseState())).toMatchObject({ ok: false, status: 404 });
    expect(hub.end('no-such-party', hostToken)).toMatchObject({ ok: false, status: 404 });
    expect(hub.view('no-such-party')).toMatchObject({ ok: false, status: 404 });
    expect(hub.subscribe('no-such-party', () => {})).toMatchObject({ ok: false, status: 404 });
    expect(hub.update(id, hostToken, withState({ delaySeconds: -5 }))).toEqual({ ok: false, status: 400, error: expect.stringContaining('delaySeconds') });
    expect(ok(hub.view(id)).rev).toBe(0);
    expect(events.filter((event) => event.type === 'state')).toHaveLength(1);
  });

  it('rate limits host updates with a sliding one-second window', () => {
    const { clock, hub } = setup({ maxUpdatesPerSecond: 3 });
    const { id, hostToken } = ok(hub.create(baseState()));
    const update = () => hub.update(id, hostToken, baseState());
    expect(update().ok).toBe(true);
    clock.advance(500);
    expect(update().ok).toBe(true);
    expect(update().ok).toBe(true);
    expect(update()).toMatchObject({ ok: false, status: 429 });
    clock.advance(499);
    expect(update()).toMatchObject({ ok: false, status: 429 });
    clock.advance(1);
    // Only the first update has left the window, so exactly one more fits.
    expect(update().ok).toBe(true);
    expect(update()).toMatchObject({ ok: false, status: 429 });
    clock.advance(500);
    expect(update().ok).toBe(true);
    expect(update().ok).toBe(true);
    expect(update()).toMatchObject({ ok: false, status: 429 });
    expect(ok(hub.view(id)).rev).toBe(6);
    // A clock that steps back cannot lock the host out.
    clock.advance(-60_000);
    expect(update().ok).toBe(true);
  });

  it('does not let refused updates spend the host rate', () => {
    const { hub } = setup({ maxUpdatesPerSecond: 2 });
    const { id, hostToken } = ok(hub.create(baseState()));
    for (let i = 0; i < 5; i++) {
      expect(hub.update(id, 'not-the-token', baseState()).ok).toBe(false);
      expect(hub.update(id, hostToken, withState({ league: 'nba' })).ok).toBe(false);
    }
    expect(hub.update(id, hostToken, baseState()).ok).toBe(true);
    expect(hub.update(id, hostToken, baseState()).ok).toBe(true);
    expect(hub.update(id, hostToken, baseState())).toMatchObject({ ok: false, status: 429 });
  });

  it('sends a new member the current view first, then member counts to everyone', () => {
    const { hub } = setup();
    const { id, hostToken } = ok(hub.create(baseState()));
    const current = ok(hub.update(id, hostToken, withState({ league: 'nfl' })));
    const a = listen(hub, id);
    expect(a.events).toEqual([{ type: 'state', view: { ...current, members: 1 } }, { type: 'members', members: 1 }]);
    const b = listen(hub, id);
    expect(b.events).toEqual([{ type: 'state', view: { ...current, members: 2 } }, { type: 'members', members: 2 }]);
    expect(a.events.at(-1)).toEqual({ type: 'members', members: 2 });
    expect(hub.stats()).toEqual({ parties: 1, members: 2 });

    b.leave();
    expect(a.events.at(-1)).toEqual({ type: 'members', members: 1 });
    const heard = a.events.length;
    b.leave();
    expect(a.events).toHaveLength(heard);
    expect(hub.stats()).toEqual({ parties: 1, members: 1 });
    expect(ok(hub.view(id)).members).toBe(1);
    ok(hub.update(id, hostToken, baseState()));
    expect(b.events).toHaveLength(2);
  });

  it('refuses members beyond maxMembers with 429 until someone leaves', () => {
    const { hub } = setup({ maxMembers: 2 });
    const { id } = ok(hub.create(baseState()));
    const a = listen(hub, id);
    listen(hub, id);
    const heard = a.events.length;
    const late = vi.fn();
    expect(hub.subscribe(id, late)).toMatchObject({ ok: false, status: 429 });
    expect(late).not.toHaveBeenCalled();
    expect(a.events).toHaveLength(heard);
    a.leave();
    expect(hub.subscribe(id, late).ok).toBe(true);
    expect(hub.stats().members).toBe(2);
  });

  it('refuses parties beyond maxParties with 503, sweeping idle ones to make room', () => {
    const { clock, hub } = setup({ maxParties: 2, idleMs: 60_000 });
    const first = ok(hub.create(baseState()));
    const second = ok(hub.create(baseState()));
    expect(hub.create(baseState())).toMatchObject({ ok: false, status: 503 });
    ok(hub.end(first.id, first.hostToken));
    const third = ok(hub.create(baseState()));
    expect(hub.create(baseState())).toMatchObject({ ok: false, status: 503 });
    listen(hub, third.id);
    clock.advance(60_001);
    expect(hub.create(baseState()).ok).toBe(true);
    expect(hub.view(second.id)).toMatchObject({ ok: false, status: 404 });
    expect(hub.view(third.id).ok).toBe(true);
    expect(hub.stats()).toEqual({ parties: 2, members: 1 });
  });

  it('ends a party: every listener hears ended, then the party is gone', () => {
    const { hub } = setup();
    const { id, hostToken } = ok(hub.create(baseState()));
    const a = listen(hub, id);
    // A transport may close its stream, and so leave, the moment it hears the party ended.
    const closing: PartyEvent[] = [];
    let close = () => {};
    close = ok(
      hub.subscribe(id, (event) => {
        closing.push(event);
        if (event.type === 'ended') close();
      }),
    );
    const b = listen(hub, id);
    const before = b.events.length;
    expect(hub.end(id, hostToken)).toEqual({ ok: true, value: true });
    expect(a.events.at(-1)).toEqual({ type: 'ended' });
    expect(closing.at(-1)).toEqual({ type: 'ended' });
    expect(b.events.slice(before)).toEqual([{ type: 'ended' }]);
    expect(hub.view(id)).toMatchObject({ ok: false, status: 404 });
    expect(hub.update(id, hostToken, baseState())).toMatchObject({ ok: false, status: 404 });
    expect(hub.subscribe(id, () => {})).toMatchObject({ ok: false, status: 404 });
    expect(hub.end(id, hostToken)).toMatchObject({ ok: false, status: 404 });
    expect(hub.stats()).toEqual({ parties: 0, members: 0 });
    a.leave();
    expect(a.events.at(-1)).toEqual({ type: 'ended' });
  });

  it('sweeps only parties that are empty and idle', () => {
    const { clock, hub } = setup({ idleMs: 1_000 });
    const quiet = ok(hub.create(baseState()));
    const watched = ok(hub.create(baseState()));
    const updated = ok(hub.create(baseState()));
    const departed = ok(hub.create(baseState()));
    const watcher = listen(hub, watched.id);
    const visitor = listen(hub, departed.id);
    clock.advance(500);
    ok(hub.update(updated.id, updated.hostToken, baseState()));
    clock.advance(100);
    visitor.leave();
    clock.advance(400);
    // Idle for exactly idleMs is not older than idleMs.
    expect(hub.sweep()).toBe(0);
    clock.advance(1);
    expect(hub.sweep()).toBe(1);
    expect(hub.view(quiet.id).ok).toBe(false);
    clock.advance(500);
    expect(hub.sweep()).toBe(1);
    expect(hub.view(updated.id).ok).toBe(false);
    clock.advance(100);
    expect(hub.sweep()).toBe(1);
    expect(hub.view(departed.id).ok).toBe(false);

    clock.advance(10_000);
    const heard = watcher.events.length;
    expect(hub.sweep()).toBe(0);
    expect(hub.view(watched.id).ok).toBe(true);
    expect(watcher.events).toHaveLength(heard);
    watcher.leave();
    clock.advance(1_001);
    expect(hub.sweep()).toBe(1);
    expect(hub.stats()).toEqual({ parties: 0, members: 0 });
  });

  it('sweeps on a timer once started, and stops when told', () => {
    vi.useFakeTimers();
    const { clock, hub } = setup({ idleMs: 1_000 });
    const first = ok(hub.create(baseState()));
    clock.advance(1_001);
    hub.start(5_000);
    vi.advanceTimersByTime(4_999);
    expect(hub.view(first.id).ok).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hub.view(first.id).ok).toBe(false);
    hub.stop();
    const second = ok(hub.create(baseState()));
    clock.advance(1_001);
    vi.advanceTimersByTime(60_000);
    expect(hub.view(second.id).ok).toBe(true);
    hub.stop();
  });

  it('never keeps the process alive with its sweep timer', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const hub = new PartyHub();
    hub.start();
    const timer = spy.mock.results[0]?.value as unknown as { hasRef(): boolean };
    expect(timer.hasRef()).toBe(false);
    hub.stop();
  });

  it('keeps broadcasting to other listeners when one throws', () => {
    const { hub } = setup();
    const { id, hostToken } = ok(hub.create(baseState()));
    const broken = vi.fn(() => {
      throw new Error('stream closed');
    });
    expect(hub.subscribe(id, broken).ok).toBe(true);
    const healthy = listen(hub, id);
    const next = ok(hub.update(id, hostToken, withState({ delaySeconds: 15 })));
    expect(broken).toHaveBeenCalledWith({ type: 'state', view: next });
    expect(healthy.events.at(-1)).toEqual({ type: 'state', view: next });
    ok(hub.end(id, hostToken));
    expect(broken).toHaveBeenLastCalledWith({ type: 'ended' });
    expect(healthy.events.at(-1)).toEqual({ type: 'ended' });
  });
});
