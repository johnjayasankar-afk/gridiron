/**
 * Live ingestion and the presentation timeline.
 *
 * `world` is everything received from the server, updated as messages arrive.
 * It is never rendered directly. Every received world is also stored in the
 * presentation buffer with its receipt time, and `presented` is the newest
 * world received at least `delay` ago. The whole UI (scores, fields, plays,
 * alerts, Watch next, sorting) reads `presented`, which is what makes the
 * spoiler delay coherent: one timeline, no leaks.
 */
import { create } from 'zustand';
import { applyDetailDelta } from '../../shared/detailDelta';
import { PresentationBuffer } from '../../shared/delay';
import type { CoverageReport, Freshness, GameDetail, GameId, GameSummary, LeagueId } from '../../shared/model';
import { EMPTY_FRESHNESS, isLiveOrPaused } from '../../shared/model';
import { shiftDateKey } from '../../shared/util';
import { getJson, type Health } from '../data/api';
import { Transport, type ConnectionStatus, type Hello, type Incoming, type Interest } from '../data/transport';
import type { SlateSnapshot } from '../../shared/model';

export interface DetailState {
  version: number;
  detail: GameDetail | null;
  freshness: Freshness;
  receivedAt: number;
}

export interface World {
  rev: number;
  receivedAt: number;
  /** The first world after a reconnect: alerts built from it are marked as late updates. */
  afterGap: boolean;
  mode: 'live' | 'replay';
  replayLabel: string | null;
  date: string | null;
  loaded: boolean;
  games: Record<GameId, GameSummary>;
  gameDates: Record<GameId, string>;
  details: Record<GameId, DetailState>;
  freshness: Record<LeagueId, Freshness>;
  coverage: CoverageReport | null;
}

export const EMPTY_WORLD: World = {
  rev: 0,
  receivedAt: 0,
  afterGap: false,
  mode: 'live',
  replayLabel: null,
  date: null,
  loaded: false,
  games: {},
  gameDates: {},
  details: {},
  freshness: { nfl: EMPTY_FRESHNESS, cfb: EMPTY_FRESHNESS },
  coverage: null,
};

export type Source = { kind: 'live' } | { kind: 'replay'; sessionId: string; scenario: string; label: string };

export interface Connection {
  status: ConnectionStatus | 'idle';
  transport: 'sse' | 'poll' | null;
  error: string | null;
  lastMessageAt: number | null;
}

export interface Presented {
  status: 'ready' | 'buffering' | 'empty';
  world: World;
  readyInMs: number;
  delayMs: number;
  receivedAt: number;
}

interface LiveState {
  source: Source;
  health: Health | null;
  hello: Hello | null;
  connection: Connection;
  world: World;
  presented: Presented;
  gaps: number;
  /** Increases when the viewer jumps the timeline (a replay seek), so alerts start a fresh baseline. */
  timelineEpoch: number;
  /** Increases to start a new replay session for the same scenario after the old one ended. */
  sessionNonce: number;
  /**
   * The replay's own clock, published by the replay bar, which already reads it
   * every second. The tape stamps its samples with the moment they were true,
   * and in a replay that is this clock and not the wall clock: a Sunday played
   * back at thirty times speed is still a Sunday, six minutes long only to the
   * person watching it.
   */
  replayClock: { virtual: number; readAt: number; speed: number } | null;
}

interface LiveActions {
  connect: (source: Source, interest: Interest) => Promise<void>;
  disconnect: () => void;
  updateInterest: (interest: Interest) => void;
  setDelay: (ms: number) => void;
  /** In Live mode, also follow yesterday's games that are still going past midnight. */
  followYesterday: (enabled: boolean) => void;
  markTimelineJump: () => void;
  restartSession: () => void;
  setReplayClock: (clock: { virtual: number; readAt: number; speed: number } | null) => void;
}

const buffer = new PresentationBuffer<World>(6 * 60_000);
let transport: Transport | null = null;
let delayMs = 0;
let pendingGap = false;
let presentTimer: ReturnType<typeof setInterval> | null = null;
let yesterdayTimer: ReturnType<typeof setTimeout> | null = null;
let yesterdayEnabled = false;
const yesterdayFollowed = new Set<GameId>();
let connectToken = 0;

function reduce(world: World, m: Incoming, now: number): World | null {
  switch (m.type) {
    case 'slate':
      return applySnapshot(world, m.snapshot, now, true);
    case 'slate-delta': {
      if (m.date !== world.date) return null;
      const games = { ...world.games };
      const gameDates = { ...world.gameDates };
      for (const g of m.upserts) {
        games[g.id] = g;
        gameDates[g.id] = m.date;
      }
      for (const id of m.removed) {
        if (gameDates[id] === m.date) {
          delete games[id];
          delete gameDates[id];
        }
      }
      return { ...world, rev: world.rev + 1, receivedAt: now, games, gameDates, freshness: m.freshness, coverage: m.coverage, afterGap: false };
    }
    case 'detail':
      return {
        ...world,
        rev: world.rev + 1,
        receivedAt: now,
        afterGap: false,
        details: { ...world.details, [m.gameId]: { version: m.version, detail: m.detail, freshness: m.freshness, receivedAt: now } },
      };
    case 'detail-delta': {
      const prev = world.details[m.gameId];
      if (!prev?.detail || prev.version !== m.delta.baseVersion) {
        void transport?.refetchDetail(m.gameId);
        return null;
      }
      try {
        const detail = applyDetailDelta(prev.detail, m.delta);
        return { ...world, rev: world.rev + 1, receivedAt: now, afterGap: false, details: { ...world.details, [m.gameId]: { version: m.delta.version, detail, freshness: m.freshness, receivedAt: now } } };
      } catch {
        void transport?.refetchDetail(m.gameId);
        return null;
      }
    }
    case 'detail-freshness': {
      const prev = world.details[m.gameId];
      if (!prev || prev.version !== m.version) return null;
      if (prev.freshness.lastSuccessAt === m.freshness.lastSuccessAt && prev.freshness.health === m.freshness.health) return null;
      return { ...world, rev: world.rev + 1, receivedAt: now, afterGap: false, details: { ...world.details, [m.gameId]: { ...prev, freshness: m.freshness } } };
    }
    default:
      return null;
  }
}

function applySnapshot(world: World, s: SlateSnapshot, now: number, primary: boolean): World {
  const games = { ...world.games };
  const gameDates = { ...world.gameDates };
  if (primary) {
    for (const [id, d] of Object.entries(gameDates)) {
      if (d === s.date || (world.date && d === world.date && s.date !== world.date && !yesterdayFollowed.has(id))) {
        delete games[id];
        delete gameDates[id];
      }
    }
    for (const g of s.games) {
      games[g.id] = g;
      gameDates[g.id] = s.date;
    }
    return {
      ...world,
      rev: world.rev + 1,
      receivedAt: now,
      afterGap: pendingGap,
      mode: s.mode,
      replayLabel: s.replayLabel,
      date: s.date,
      loaded: true,
      games,
      gameDates,
      freshness: s.freshness,
      coverage: s.coverage,
    };
  }
  // Yesterday's slate in Live mode: keep games still going, and any we were already following until they finish.
  for (const g of s.games) {
    if (isLiveOrPaused(g.status.kind) || yesterdayFollowed.has(g.id)) {
      yesterdayFollowed.add(g.id);
      games[g.id] = g;
      gameDates[g.id] = s.date;
    }
  }
  return { ...world, rev: world.rev + 1, receivedAt: now, games, gameDates };
}

export const useLive = create<LiveState & LiveActions>()((set, get) => {
  const recompute = () => {
    const r = buffer.present(Date.now(), delayMs);
    const cur = get().presented;
    const latest = buffer.latest()?.value;
    if (r.status === 'ready') {
      if (cur.status !== 'ready' || cur.world !== r.state.value || cur.delayMs !== delayMs) {
        set({ presented: { status: 'ready', world: r.state.value, readyInMs: 0, delayMs, receivedAt: r.state.receivedAt } });
      }
    } else if (r.status === 'buffering') {
      const readyInMs = Math.ceil(r.readyInMs / 1000) * 1000;
      if (cur.status !== 'buffering' || cur.readyInMs !== readyInMs || cur.delayMs !== delayMs) {
        set({ presented: { status: 'buffering', world: { ...EMPTY_WORLD, mode: latest?.mode ?? 'live', replayLabel: latest?.replayLabel ?? null, date: latest?.date ?? null }, readyInMs, delayMs, receivedAt: 0 } });
      }
    } else if (cur.status !== 'empty') {
      set({ presented: { status: 'empty', world: EMPTY_WORLD, readyInMs: 0, delayMs, receivedAt: 0 } });
    }
  };

  const ensureTimer = () => {
    if (delayMs > 0 && !presentTimer) presentTimer = setInterval(recompute, 250);
    if (delayMs === 0 && presentTimer) {
      clearInterval(presentTimer);
      presentTimer = null;
    }
  };

  const ingest = (next: World) => {
    buffer.push(next, next.receivedAt);
    set({ world: next });
    if (delayMs === 0) recompute();
  };

  const handle = (m: Incoming) => {
    const now = Date.now();
    switch (m.type) {
      case 'hello':
        set({ hello: m.hello });
        return;
      case 'connection':
        set({ connection: { status: m.status, transport: m.transport, error: m.error, lastMessageAt: get().connection.lastMessageAt } });
        return;
      case 'gap':
        pendingGap = true;
        set({ gaps: get().gaps + 1 });
        return;
      default: {
        const next = reduce(get().world, m, now);
        set({ connection: { ...get().connection, lastMessageAt: now } });
        if (!next) return;
        if (m.type === 'slate') pendingGap = false;
        ingest(next);
      }
    }
  };

  const pollYesterday = async () => {
    if (yesterdayTimer) clearTimeout(yesterdayTimer);
    yesterdayTimer = null;
    const world = get().world;
    const source = get().source;
    if (!yesterdayEnabled || !world.date) return;
    const base = source.kind === 'live' ? '/api' : `/api/replay/s/${source.sessionId}`;
    try {
      const snapshot = await getJson<SlateSnapshot>(`${base}/slate?date=${shiftDateKey(world.date, -1)}`);
      if (yesterdayEnabled && get().world.date === world.date) ingest(applySnapshot(get().world, snapshot, Date.now(), false));
    } catch {
      /* yesterday is a courtesy; the primary slate carries its own health */
    } finally {
      if (yesterdayEnabled) yesterdayTimer = setTimeout(() => void pollYesterday(), 30_000);
    }
  };

  return {
    source: { kind: 'live' },
    health: null,
    hello: null,
    connection: { status: 'idle', transport: null, error: null, lastMessageAt: null },
    world: EMPTY_WORLD,
    presented: { status: 'empty', world: EMPTY_WORLD, readyInMs: 0, delayMs: 0, receivedAt: 0 },
    gaps: 0,
    timelineEpoch: 0,
    sessionNonce: 0,
    replayClock: null,

    setReplayClock(clock) {
      const prev = get().replayClock;
      // Every second, so it only lands in the store when it has actually moved.
      if (prev === clock) return;
      if (prev && clock && prev.virtual === clock.virtual && prev.speed === clock.speed) return;
      set({ replayClock: clock });
    },

    markTimelineJump() {
      set({ timelineEpoch: get().timelineEpoch + 1 });
    },

    restartSession() {
      set({ sessionNonce: get().sessionNonce + 1 });
    },

    async connect(source, interest) {
      const token = ++connectToken;
      transport?.stop();
      transport = null;
      buffer.clear();
      yesterdayFollowed.clear();
      pendingGap = false;
      set({ source, hello: null, world: EMPTY_WORLD, presented: { status: 'empty', world: EMPTY_WORLD, readyInMs: 0, delayMs, receivedAt: 0 }, connection: { status: 'connecting', transport: null, error: null, lastMessageAt: null } });
      let polling = false;
      if (source.kind === 'live') {
        try {
          const health = await getJson<Health>('/api/health');
          if (token !== connectToken) return;
          set({ health });
          polling = health.transport === 'poll';
        } catch (e) {
          if (token !== connectToken) return;
          set({ connection: { status: 'reconnecting', transport: null, error: `The Gridiron server did not answer: ${(e as Error).message}`, lastMessageAt: null } });
        }
      }
      if (token !== connectToken) return;
      const base = source.kind === 'live' ? '/api' : `/api/replay/s/${source.sessionId}`;
      transport = new Transport({ base, emit: handle, polling }, interest);
      transport.start();
      if (yesterdayEnabled) setTimeout(() => void pollYesterday(), 2_000);
    },

    disconnect() {
      connectToken++;
      transport?.stop();
      transport = null;
      set({ connection: { status: 'idle', transport: null, error: null, lastMessageAt: null } });
    },

    updateInterest(interest) {
      transport?.setInterest(interest);
    },

    setDelay(ms) {
      delayMs = Math.max(0, ms);
      ensureTimer();
      recompute();
    },

    followYesterday(enabled) {
      if (enabled === yesterdayEnabled) return;
      yesterdayEnabled = enabled;
      if (enabled) void pollYesterday();
      else if (yesterdayTimer) {
        clearTimeout(yesterdayTimer);
        yesterdayTimer = null;
      }
    },
  };
});

/** The presented world, the only state views should render. */
export const usePresentedWorld = () => useLive((s) => s.presented.world);
