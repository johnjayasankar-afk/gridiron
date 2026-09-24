import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_MS,
  MAX_SAMPLES,
  MIN_GAP_MS,
  convergence,
  record,
  rankByMovement,
  providerPlay,
  sampleFrom,
  stateAt,
  tapeSpan,
  tapeStats,
  type TapeSample,
  type TapeTrack,
} from '../shared/tape';
import type { GameSummary } from '../shared/model';
import { game } from './helpers/builders';

function sample(at: number, o: Partial<TapeSample> = {}): TapeSample {
  return {
    at,
    home: 0,
    away: 0,
    wp: null,
    period: 1,
    clock: '15:00',
    clockSeconds: 900,
    kind: 'in_progress',
    possession: 'home',
    redZone: false,
    play: null,
    ...o,
  };
}

const track = (samples: TapeSample[]): TapeTrack => ({ gameId: 'nfl-1', samples });

/** A summary with a reported win probability and a real clock, which the builder leaves out. */
function live(o: { id?: string; home?: number; away?: number; period?: number; clockSeconds?: number; wp?: number }): GameSummary {
  const g = game({ id: o.id ?? 'nfl-1', home: o.home ?? 0, away: o.away ?? 0, period: o.period ?? 4 });
  return {
    ...g,
    status: { ...g.status, clockSeconds: o.clockSeconds ?? 900 },
    winProbability: o.wp === undefined ? null : { home: o.wp, tie: 0, playId: 'p1', source: 'ESPN' },
  };
}

describe('recording the tape', () => {
  it('keeps a sample only when something changed, and a heartbeat through a quiet stretch', () => {
    let t = track([sample(0)]);
    t = record(t, sample(1_000));
    expect(t.samples).toHaveLength(1);

    // unchanged but long enough to need a point to draw through
    t = record(t, sample(HEARTBEAT_MS));
    expect(t.samples).toHaveLength(2);

    // a change always earns its own point once the minimum gap has passed
    t = record(t, sample(HEARTBEAT_MS + MIN_GAP_MS, { home: 7 }));
    expect(t.samples).toHaveLength(3);
    expect(t.samples[2].home).toBe(7);
  });

  it('returns the very same array when there is nothing to add', () => {
    const t = track([sample(0)]);
    expect(record(t, sample(1_000))).toBe(t);
  });

  it('moves the last point rather than losing a change that arrives too soon', () => {
    let t = track([sample(0, { home: 0 })]);
    t = record(t, sample(1_000, { home: 7 }));
    expect(t.samples).toHaveLength(1);
    expect(t.samples[0].home).toBe(7);
    // and it keeps the earlier time, so the recording never runs ahead of itself
    expect(t.samples[0].at).toBe(0);
  });

  it('ignores a sample older than the one before it', () => {
    // Inside the recording, which is jitter in reading the clock. A sample
    // before the whole recording is a different clock and is handled by
    // "a clock that changes under the recording" below.
    const t = track([sample(1_000), sample(5_000 + HEARTBEAT_MS)]);
    expect(record(t, sample(5_000, { home: 7 }))).toBe(t);
  });

  it('treats a win probability change below the epsilon as no change', () => {
    let t = track([sample(0, { wp: 0.5 })]);
    t = record(t, sample(MIN_GAP_MS + 1, { wp: 0.5005 }));
    expect(t.samples).toHaveLength(1);
    t = record(t, sample(2 * MIN_GAP_MS + 2, { wp: 0.53 }));
    expect(t.samples).toHaveLength(2);
  });

  it('never grows past the cap, and drops the oldest first', () => {
    let t = track([]);
    for (let i = 0; i < MAX_SAMPLES + 50; i++) t = record(t, sample(i * MIN_GAP_MS, { home: i }));
    expect(t.samples).toHaveLength(MAX_SAMPLES);
    expect(t.samples[t.samples.length - 1].home).toBe(MAX_SAMPLES + 49);
  });

  it('reads a sample off a summary without inventing a win probability', () => {
    const withNone = sampleFrom(live({}), 1_000);
    expect(withNone.wp).toBeNull();
    const withOne = sampleFrom(live({ wp: 0.62 }), 1_000);
    expect(withOne.wp).toBe(0.62);
  });
});

describe('what the recording measures', () => {
  it('adds up every reported change, and names the biggest', () => {
    const t = track([
      sample(0, { wp: 0.5 }),
      sample(1_000, { wp: 0.6 }),
      sample(2_000, { wp: 0.25 }),
      sample(3_000, { wp: 0.3 }),
    ]);
    const s = tapeStats(t);
    // 0.10 up, 0.35 down, 0.05 up
    expect(s.movement).toBeCloseTo(0.5, 6);
    expect(s.biggest?.swing).toBeCloseTo(-0.35, 6);
    expect(s.biggest?.sample.at).toBe(2_000);
  });

  it('reports no movement at all when the provider reported no win probability', () => {
    const s = tapeStats(track([sample(0), sample(1_000, { home: 7 })]));
    expect(s.movement).toBeNull();
    expect(s.biggest).toBeNull();
  });

  it('counts a lead change only when the other side goes in front', () => {
    const s = tapeStats(
      track([
        sample(0, { home: 7, away: 0 }), // home in front
        sample(1_000, { home: 7, away: 7 }), // tied: not a change
        sample(2_000, { home: 7, away: 10 }), // away in front: one
        sample(3_000, { home: 14, away: 10 }), // home in front: two
      ]),
    );
    expect(s.leadChanges).toBe(2);
    expect(s.closest).toBe(0);
  });

  it('knows whether the game was still live at the last sample', () => {
    expect(tapeStats(track([sample(0), sample(1_000, { kind: 'final' })])).live).toBe(false);
    expect(tapeStats(track([sample(0)])).live).toBe(true);
  });

  it('measures nothing from an empty track', () => {
    const s = tapeStats(track([]));
    expect(s).toMatchObject({ movement: null, biggest: null, leadChanges: 0, closest: null, samples: 0, live: false });
  });
});

describe('reading the tape at a moment', () => {
  const t = track([sample(1_000, { home: 0 }), sample(2_000, { home: 7 }), sample(5_000, { home: 14 })]);

  it('gives the state that was true then, not the next one', () => {
    expect(stateAt(t, 2_500)?.home).toBe(7);
    expect(stateAt(t, 2_000)?.home).toBe(7);
    expect(stateAt(t, 4_999)?.home).toBe(7);
    expect(stateAt(t, 5_000)?.home).toBe(14);
  });

  it('says nothing before the recording began, and holds the last state after it', () => {
    expect(stateAt(t, 999)).toBeNull();
    expect(stateAt(t, 9_000)?.home).toBe(14);
  });

  it('spans every track it is given', () => {
    expect(tapeSpan([t, track([sample(500)])])).toEqual({ from: 500, to: 5_000 });
    expect(tapeSpan([track([])])).toBeNull();
  });
});

describe('ordering the day', () => {
  it('puts live games first, then the most reported movement', () => {
    const quiet: TapeTrack = { gameId: 'a', samples: [sample(0, { wp: 0.5 }), sample(1_000, { wp: 0.52 })] };
    const wild: TapeTrack = { gameId: 'b', samples: [sample(0, { wp: 0.5 }), sample(1_000, { wp: 0.9 })] };
    const done: TapeTrack = { gameId: 'c', samples: [sample(0, { wp: 0.5 }), sample(1_000, { wp: 0.05, kind: 'final' })] };
    expect(rankByMovement([quiet, done, wild]).map((r) => r.gameId)).toEqual(['b', 'a', 'c']);
  });

  it('names the measurement that placed a game, and claims no movement it does not have', () => {
    const scored: TapeTrack = { gameId: 'a', samples: [sample(0, { home: 0, away: 3 }), sample(1_000, { home: 7, away: 3 })] };
    const [row] = rankByMovement([scored]);
    expect(row.reasons.some((r) => r.includes('win probability'))).toBe(false);
    expect(row.reasons).toContain('1 lead change');
  });

  it('leaves out a game with nothing recorded', () => {
    expect(rankByMovement([{ gameId: 'a', samples: [] }])).toEqual([]);
  });
});

describe('games arriving at the end together', () => {
  it('needs at least two, close and late', () => {
    const a = live({ id: 'a', home: 20, away: 17, period: 4, clockSeconds: 120 });
    const b = live({ id: 'b', home: 14, away: 14, period: 4, clockSeconds: 240 });
    expect(convergence([a])).toBeNull();
    const got = convergence([a, b]);
    expect(got?.games).toEqual(['a', 'b']);
    expect(got?.soonest).toBe(120);
  });

  it('leaves out a game that is not close, not late, or not in its last period', () => {
    const close = live({ id: 'a', home: 20, away: 17, period: 4, clockSeconds: 120 });
    const blowout = live({ id: 'b', home: 40, away: 3, period: 4, clockSeconds: 120 });
    const early = live({ id: 'c', home: 7, away: 7, period: 2, clockSeconds: 120 });
    const notLate = live({ id: 'd', home: 7, away: 7, period: 4, clockSeconds: 800 });
    expect(convergence([close, blowout, early, notLate])).toBeNull();
  });

  it('counts overtime however much clock is left, and sorts it first', () => {
    const ot = live({ id: 'a', home: 20, away: 20, period: 5, clockSeconds: 600 });
    const late = live({ id: 'b', home: 20, away: 17, period: 4, clockSeconds: 60 });
    const got = convergence([ot, late]);
    expect(got?.games).toEqual(['a', 'b']);
  });

  it('never counts a game whose score or clock was not reported', () => {
    const known = live({ id: 'a', home: 20, away: 17, period: 4, clockSeconds: 120 });
    const noClock = { ...live({ id: 'b', home: 20, away: 17, period: 4 }), status: { ...live({ id: 'b' }).status, period: 4, clockSeconds: null } };
    expect(convergence([known, noClock as GameSummary])).toBeNull();
  });
});

describe('a moment on a lane is a play on the field', () => {
  it('keeps the provider half of a play id, which is what a link wants', () => {
    expect(providerPlay('nfl-401872659:401872659210', 'nfl-401872659')).toBe('401872659210');
    // already bare, or from somewhere else: left alone rather than mangled
    expect(providerPlay('401872659210', 'nfl-401872659')).toBe('401872659210');
    expect(providerPlay(null, 'nfl-1')).toBeNull();
    expect(providerPlay(undefined, 'nfl-1')).toBeNull();
  });

  it('records the play a reading followed, and nothing when none was reported', () => {
    const g = game({ id: 'nfl-9' });
    expect(sampleFrom(g, 1_000).play).toBeNull();
    const withPlay = { ...g, winProbability: { home: 0.6, tie: 0, playId: 'nfl-9:12345', source: 'ESPN' } };
    expect(sampleFrom(withPlay, 1_000).play).toBe('12345');
  });

  it('reads the play that was current at a moment', () => {
    const t = track([
      sample(1_000, { play: 'a' }),
      sample(2_000, { play: 'b' }),
      sample(3_000, { play: null }),
    ]);
    expect(stateAt(t, 1_500)?.play).toBe('a');
    expect(stateAt(t, 2_900)?.play).toBe('b');
    // a moment the provider reported no play for opens nothing rather than the wrong thing
    expect(stateAt(t, 3_500)?.play).toBeNull();
  });
});

describe('keeping the tape across a reload', () => {
  it('round trips every field of a sample through the stored encoding', async () => {
    const { pack, unpack } = await import('../src/state/tape');
    const full: TapeSample = {
      at: 1_700_000_000_123,
      home: 21,
      away: 17,
      wp: 0.6234,
      period: 5,
      clock: '2:14',
      clockSeconds: 134,
      kind: 'in_progress',
      possession: 'away',
      redZone: true,
      play: '401872658123',
    };
    expect(unpack(pack(full))).toEqual(full);

    // and the shape a provider that reported almost nothing produces
    const sparse: TapeSample = {
      at: 1_700_000_000_000,
      home: null,
      away: null,
      wp: null,
      period: null,
      clock: null,
      clockSeconds: null,
      kind: 'scheduled',
      possession: null,
      redZone: false,
      play: null,
    };
    expect(unpack(pack(sparse))).toEqual(sparse);
  });

  it('rounds the chance rather than storing a float nobody needs', async () => {
    const { pack } = await import('../src/state/tape');
    expect(pack({ ...sample(0), wp: 0.123456789 })[3]).toBe(0.1235);
  });
});

/**
 * The failure this covers was silent and total. A replay opens, the first world
 * arrives before the replay bar has published the session clock, and that one
 * sample is stamped with wall clock time: today. Every sample after it carries
 * the replay's own clock, which for a Sunday in the past is days EARLIER, so
 * record() saw time running backwards and refused all of them. The tape drew
 * twelve lanes reading "none" for a full afternoon, and nothing anywhere said
 * why. Both ends are covered: the recorder waits for a clock, and the store
 * survives a wrong one rather than dying quietly.
 */
describe('a clock that changes under the recording', () => {
  it('starts the track again when a sample lands before the whole recording', () => {
    const recorded = track([sample(9_000), sample(9_000 + HEARTBEAT_MS)]);
    // nine days earlier: a different clock, not this recording's
    const elsewhere = sample(9_000 - 9 * 86_400_000, { home: 7 });
    const next = record(recorded, elsewhere);
    expect(next.samples).toEqual([elsewhere]);

    // and the track keeps recording from there rather than refusing forever
    const after = record(next, { ...elsewhere, at: elsewhere.at + HEARTBEAT_MS });
    expect(after.samples).toHaveLength(2);
  });

  it('still drops a sample that lands inside the recording, which is jitter', () => {
    const recorded = track([sample(0), sample(HEARTBEAT_MS), sample(HEARTBEAT_MS * 2)]);
    const late = sample(HEARTBEAT_MS + 10, { home: 7 });
    expect(record(recorded, late)).toBe(recorded);
  });

  it('does not record a replay moment until there is a replay clock to stamp it with', async () => {
    const { stampReady } = await import('../src/app/useTape');
    const clock = { virtual: 1_700_000_000_000, readAt: 1_700_000_000_000, speed: 60 };
    const replay = { kind: 'replay', sessionId: 's1', scenario: 'nfl-week1-sunday', label: 'Replay' } as const;
    expect(stampReady(replay, null)).toBe(false);
    expect(stampReady(replay, clock)).toBe(true);
    // live is always stampable: now is the answer, and there is nothing to wait for
    expect(stampReady({ kind: 'live' }, null)).toBe(true);
  });
});
