/**
 * Alert sounds. Off by default; the audio context is created only after the
 * viewer turns sound on (or, on a later visit with sound on, after their first
 * click or key press), because browsers block audio before an interaction.
 */
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
