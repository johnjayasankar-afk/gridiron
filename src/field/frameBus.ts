/**
 * Lets DOM code ask the shared 3D canvas for a frame without importing three.js,
 * which lives in a lazily loaded chunk. The canvas registers a requester when it
 * mounts; before that, requests are ignored. Pointer state for card cameras is a
 * plain mutable object, so moving the mouse never re-renders React.
 */
let requester: (() => void) | null = null;

export function registerFieldFrameRequester(fn: (() => void) | null) {
  requester = fn;
}

export function requestFieldFrame() {
  requester?.();
}

export interface PointerState {
  /** -1 (left) to 1 (right) across the card. */
  x: number;
  /** -1 (top) to 1 (bottom) across the card. */
  y: number;
  active: boolean;
}

export const createPointerState = (): PointerState => ({ x: 0, y: 0, active: false });
