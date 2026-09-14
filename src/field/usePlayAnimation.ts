/**
 * Watches one game's presented plays and decides when its field animates.
 * The first sight of a game only records a baseline, so history never replays.
 * A burst of several new plays settles instead of animating each one, and a
 * revised play shows "Play corrected" without celebrating again.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BallSpot, GameDetail, Situation } from '../../shared/model';
import { planPlayAnimation, playInputFromBrief, playInputFromEvent, type PlayAnimation, type PlayInput } from '../../shared/playAnimation';
import { inspectablePlays } from '../../shared/replayFrames';

export interface FieldMoment {
  animation: PlayAnimation | null;
  label: string | null;
  /** Changes whenever a new label appears. */
  labelKey: string | null;
  corrected: boolean;
}

interface Seen {
  pid: string;
  revision: string;
  source: PlayInput['source'];
  count: number;
  recent: Map<string, string>;
  spot: BallSpot | null;
}

/** Play ids are namespaced by game (`nfl-1:123`); scoreboard briefs may carry the provider id alone. */
const providerPlayId = (id: string) => id.slice(id.lastIndexOf(':') + 1);

export interface PlayAnimationOptions {
  reducedMotion: boolean;
  /** The presented update followed a connection gap. */
  afterGap: boolean;
  /** Historical inspection is showing an older play; live changes wait. */
  paused: boolean;
}

export function usePlayAnimation(detail: GameDetail | null, situation: Situation | null, options: PlayAnimationOptions): FieldMoment {
  const [moment, setMoment] = useState<FieldMoment>({ animation: null, label: null, labelKey: null, corrected: false });
  const seen = useRef<Seen | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latest = useMemo(() => {
    if (!detail) return null;
    const plays = inspectablePlays(detail);
    if (!plays.length) return null;
    return {
      input: playInputFromEvent(plays[plays.length - 1]),
      count: plays.length,
      recent: new Map(plays.slice(-8).map((p) => [p.id, p.revision])),
    };
  }, [detail]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const { paused, afterGap, reducedMotion } = options;
  useEffect(() => {
    if (paused) return;
    const prev = seen.current;
    const spot = situation?.spot ?? null;
    let input: PlayInput | null = null;
    let count = prev?.count ?? 0;
    let recent = prev?.recent ?? new Map<string, string>();
    if (latest) {
      input = latest.input;
      count = latest.count;
      recent = latest.recent;
    } else if (situation?.lastPlay) {
      input = playInputFromBrief(situation.lastPlay, prev?.spot ?? null, spot);
    }
    if (!input) {
      if (prev) prev.spot = spot;
      return;
    }
    const next: Seen = { pid: providerPlayId(input.id), revision: input.revision, source: input.source, count, recent, spot };
    seen.current = next;
    if (!prev) return;
    // The same play, now described by full play-by-play instead of the scoreboard brief.
    if (prev.pid === next.pid && prev.source !== next.source) return;

    let correctedEarlier = false;
    if (input.source === 'play' && prev.source === 'play') {
      for (const [id, revision] of recent) {
        const before = prev.recent.get(id);
        if (before !== undefined && before !== revision && providerPlayId(id) !== next.pid) correctedEarlier = true;
      }
    }
    const burst = afterGap || (input.source === 'play' && prev.source === 'play' && count - prev.count > 1);
    const plan = planPlayAnimation({ id: prev.pid === next.pid ? input.id : `previous:${prev.pid}`, revision: prev.revision }, input, { reducedMotion, burst });
    if (!plan && !correctedEarlier) return;

    const label = plan ? plan.label : 'Play corrected';
    const labelKey = plan ? plan.key : `corrected:${next.pid}:${recent.size}:${Date.now()}`;
    setMoment((m) => ({ animation: plan ?? m.animation, label, labelKey: label ? labelKey : null, corrected: plan ? plan.corrected : true }));
    if (timer.current) clearTimeout(timer.current);
    const hold = Math.max(2800, (plan?.durationMs ?? 0) + (plan?.effectMs ?? 0) + 1800);
    timer.current = setTimeout(() => setMoment((m) => ({ ...m, label: null, labelKey: null })), hold);
  }, [latest, situation, paused, afterGap, reducedMotion]);

  return moment;
}
