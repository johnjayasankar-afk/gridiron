/**
 * The field's own sounds, on a game page and nowhere else.
 *
 * A slate of thirteen games would be thirteen things making a noise at once, so
 * this is only ever mounted by the game page, where the viewer is watching one.
 * What each play sounds like is decided in shared/fieldSound from the reported
 * play alone; this only notices that a new play has arrived and plays it.
 *
 * It follows the same animation the field draws, so it respects the spoiler
 * delay, stays silent through a burst of delayed plays, and sounds a play the
 * viewer steps onto or watches in the reel exactly as it sounds live.
 */
import { useEffect, useRef } from 'react';
import { fieldSoundFor } from '../../shared/fieldSound';
import type { PlayAnimation } from '../../shared/playAnimation';
import { playFieldSound, unlockSound } from '../lib/sound';
import { usePrefs } from '../state/prefs';

export function useFieldSound(animation: PlayAnimation | null) {
  const on = usePrefs((s) => s.fieldSound);
  const played = useRef<string | null>(null);

  useEffect(() => {
    if (on) void unlockSound();
  }, [on]);

  useEffect(() => {
    if (!animation) return;
    // The key changes once per play, so a re-render never sounds one twice.
    if (played.current === animation.key) return;
    played.current = animation.key;
    if (!on) return;
    const sound = fieldSoundFor(animation);
    if (sound) playFieldSound(sound.kind, sound.strength);
  }, [animation, on]);
}
