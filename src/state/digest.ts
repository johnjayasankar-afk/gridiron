/** The "While you were away" digest currently offered, if any. */
import { create } from 'zustand';
import type { Digest } from '../../shared/digest';

interface DigestStore {
  digest: Digest | null;
  show: (digest: Digest) => void;
  dismiss: () => void;
}

export const useDigest = create<DigestStore>()((set) => ({
  digest: null,
  show: (digest) => set({ digest }),
  dismiss: () => set({ digest: null }),
}));
