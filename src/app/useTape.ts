/**
 * Writes the tape from the PRESENTED world, so the recording respects the
 * spoiler delay exactly as the alerts do, and stamps each sample with the
 * moment it was true rather than the moment it was drawn.
 *
 * A new source, a new delay or a replay seek starts a new tape: after a seek
 * the clock has moved somewhere else entirely, and carrying the old samples
 * across would draw a line between two times that never followed each other.
 */
import { useEffect } from 'react';
import { isLiveOrPaused, isOver, type GameId, type GameStatusKind } from '../../shared/model';
import { sampleFrom } from '../../shared/tape';
import { useLive, type Presented, type Source, type World } from '../state/live';
import { bestSummary } from '../state/selectors';
import { useTape } from '../state/tape';

/**
 * What this recording is of. The epoch and the delay are part of it because a
 * seek or a change of delay moves the clock somewhere else: the samples either
 * side of one did not follow each other and must not be drawn as if they did.
 * It is built in one place so the tape restored from session storage is not
 * thrown away by the first update for disagreeing with itself.
 */
const sourceKey = (s: Source, epoch: number, delayMs: number) =>
  `${s.kind === 'live' ? 'live' : `replay:${s.sessionId}`}#${epoch}#${delayMs}`;

/**
 * The clock a sample is stamped with. Live, that is now. In a replay it is the
 * replay's own clock, carried forward from the last reading at the speed it is
 * running, because the bar reads it once a second and samples land between.
 */
export const CLOCK_STALE_MS = 6_000;

/**
 * Whether there is a clock to stamp a sample with yet.
 *
 * Live, now is always the answer. In a replay the clock belongs to the session
 * and the bar publishes it on its own poll, so for the first moment after a
 * replay opens there is no clock here at all. Stamping a sample with wall clock
 * time then would file a September afternoon under today's date, days ahead of
 * every sample that follows it, and the recording would refuse them all. A
 * moment with no clock is not recorded, which costs one reading and keeps the
 * tape honest about what time each sample was true.
 */
export function stampReady(source: Source, replayClock: ReturnType<typeof useLive.getState>['replayClock']): boolean {
  return source.kind === 'live' || replayClock !== null;
}

export function tapeNow(clock: ReturnType<typeof useLive.getState>['replayClock'], now: number): number {
  if (!clock) return now;
  const since = Math.max(0, now - clock.readAt);
  // The bar reads the replay clock every second. A reading older than a few of
  // those means the session has ended or stopped answering, and carrying it
  // forward at replay speed would run the tape hours into an afternoon that is
  // not happening: it held its last reading and stretched the day to 5:27 PM.
  if (since > CLOCK_STALE_MS) return clock.virtual;
  return clock.virtual + since * clock.speed;
}

/** A game under way, or one that has finished today, belongs on the tape. A scheduled one has nothing to record yet. */
const worthRecording = (kind: GameStatusKind) => isLiveOrPaused(kind) || isOver(kind);

export function useTapeRecorder() {
  useEffect(() => {
    let lastWorld: World | null = null;

    const onPresented = (presented: Presented) => {
      const live = useLive.getState();
      // restart() only acts when the key differs, so a tape restored from
      // session storage for the same source survives the first update.
      useTape.getState().restart(sourceKey(live.source, live.timelineEpoch, presented.delayMs));
      if (presented.status !== 'ready' || presented.world === lastWorld) return;
      // Not marked as seen: this world is worth recording, there is just no
      // clock to record it against yet, so the next update takes it.
      if (!stampReady(live.source, live.replayClock)) return;
      const world = presented.world;
      lastWorld = world;

      const at = tapeNow(live.replayClock, Date.now());
      const write = useTape.getState().write;
      for (const id of Object.keys(world.games) as GameId[]) {
        const game = bestSummary(world, id);
        if (!game || !worthRecording(game.status.kind)) continue;
        write(id, sampleFrom(game, at));
      }
    };

    onPresented(useLive.getState().presented);
    const off = useLive.subscribe((s, prev) => {
      if (s.presented !== prev.presented || s.source !== prev.source || s.timelineEpoch !== prev.timelineEpoch) onPresented(s.presented);
    });
    return off;
  }, []);
}
