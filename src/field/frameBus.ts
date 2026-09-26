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

/**
 * How many frames the shared canvas has drawn, and a way to be told when it
 * draws another.
 *
 * A mounted 3D view is an empty box until the canvas has drawn into it, so the
 * flat field stands in and has to know when to get out of the way. Counting
 * frames rather than listening for a mount is the only honest signal: the view
 * existing says nothing about whether anything has been painted in it.
 */
let framesDrawn = 0;
const drawnListeners = new Set<() => void>();

export function noteFieldFrameDrawn() {
  framesDrawn += 1;
  for (const fn of drawnListeners) fn();
}

export function fieldFramesDrawn(): number {
  return framesDrawn;
}

export function onFieldFrameDrawn(fn: () => void): () => void {
  drawnListeners.add(fn);
  return () => {
    drawnListeners.delete(fn);
  };
}

export interface PointerState {
  /** -1 (left) to 1 (right) across the card. */
  x: number;
  /** -1 (top) to 1 (bottom) across the card. */
  y: number;
  active: boolean;
}

export const createPointerState = (): PointerState => ({ x: 0, y: 0, active: false });

/**
 * Where the ball is, shared between the layer that draws it and the camera that
 * watches it, as a plain mutable object for the same reason the pointer is one:
 * it changes sixty times a second and must never re-render React to do it.
 */
export interface BallTrack {
  /** World x of the ball. */
  x: number;
  /** True only while the ball is running a play, rather than sitting at a spot. */
  live: boolean;
}

export const createBallTrack = (): BallTrack => ({ x: 0, live: false });
