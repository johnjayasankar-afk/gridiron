/**
 * Alert sounds and field sounds. Both are off by default, and the audio context
 * is created only after the viewer turns one on (or, on a later visit with one
 * already on, after their first click or key press), because browsers block
 * audio before an interaction.
 *
 * Everything is synthesised here rather than loaded: no audio files ship, and
 * nothing is fetched to make a noise.
 */
import type { FieldSoundKind } from '../../shared/fieldSound';
let context: AudioContext | null = null;

export async function unlockSound(): Promise<boolean> {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') await context.resume();
    return context.state === 'running';
  } catch {
    return false;
  }
}

export const soundReady = () => context?.state === 'running';

const NOTES: Record<'score' | 'attention' | 'test', number[]> = {
  score: [659.25, 987.77],
  attention: [587.33, 698.46],
  test: [523.25, 783.99],
};

export function playChime(kind: 'score' | 'attention' | 'test'): boolean {
  const ctx = context;
  if (!ctx || ctx.state !== 'running') return false;
  const t0 = ctx.currentTime + 0.01;
  NOTES[kind].forEach((frequency, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    const start = t0 + i * 0.12;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.07, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.32);
  });
  return true;
}

// ---------------------------------------------------------------- field sounds

interface Note {
  /** Hertz. */
  hz: number;
  /** Seconds from the start of the sound. */
  at: number;
  /** Seconds. */
  dur: number;
  /** Peak gain before the sound's own level is applied. */
  gain: number;
  type?: OscillatorType;
}

/*
 * Short, soft and low in the mix. A play on a field is a texture, not an alarm:
 * the alert chime is the thing allowed to ask for attention, and these sit well
 * under it so the two can be on at once without fighting.
 */
const FIELD: Record<FieldSoundKind, Note[]> = {
  land: [{ hz: 300, at: 0, dur: 0.1, gain: 0.5, type: 'triangle' }],
  firstDown: [
    { hz: 523.25, at: 0, dur: 0.12, gain: 0.5 },
    { hz: 659.25, at: 0.08, dur: 0.16, gain: 0.5 },
  ],
  touchdown: [
    { hz: 130.81, at: 0, dur: 0.5, gain: 0.45, type: 'triangle' },
    { hz: 523.25, at: 0.02, dur: 0.2, gain: 0.6 },
    { hz: 659.25, at: 0.1, dur: 0.22, gain: 0.6 },
    { hz: 783.99, at: 0.19, dur: 0.34, gain: 0.6 },
  ],
  fieldGoal: [
    { hz: 659.25, at: 0, dur: 0.16, gain: 0.55 },
    { hz: 880, at: 0.1, dur: 0.26, gain: 0.5 },
  ],
  turnover: [
    { hz: 440, at: 0, dur: 0.16, gain: 0.55, type: 'triangle' },
    { hz: 329.63, at: 0.1, dur: 0.3, gain: 0.55, type: 'triangle' },
  ],
  penalty: [{ hz: 196, at: 0, dur: 0.24, gain: 0.4, type: 'square' }],
};

/** The loudest a field sound is ever allowed to be, well under the alert chime's 0.07. */
const FIELD_CEILING = 0.045;
/** Nothing sounds twice inside this, so a burst of arrivals cannot machine-gun. */
const FIELD_GAP_MS = 220;
let lastFieldAt = 0;

/**
 * A play's sound. `strength` (0 to 1) comes from the ground the play covered, so
 * a two yard run is quieter and a little lower than a long one; it never changes
 * which sound is made, only how much of it there is.
 */
export function playFieldSound(kind: FieldSoundKind, strength = 1): boolean {
  const ctx = context;
  if (!ctx || ctx.state !== 'running') return false;
  const now = Date.now();
  if (now - lastFieldAt < FIELD_GAP_MS) return false;
  lastFieldAt = now;

  const level = FIELD_CEILING * (0.45 + 0.55 * Math.min(1, Math.max(0, strength)));
  const bend = kind === 'land' ? 1 + strength * 0.5 : 1;
  const t0 = ctx.currentTime + 0.01;
  for (const note of FIELD[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = note.type ?? 'sine';
    osc.frequency.value = note.hz * bend;
    const start = t0 + note.at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * note.gain), start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + note.dur + 0.02);
  }
  return true;
}
