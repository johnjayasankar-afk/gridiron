/**
 * A field on a card, on the wall, or on the game page. It draws into the shared
 * canvas when 3D is available and the field is near the viewport, and as SVG
 * otherwise. The 3D layer is its own chunk, loaded on first use. Everything a
 * viewer must read (messages, labels) is DOM, passed in as children and layered
 * above the field.
 */
import { Component, lazy, memo, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DriveTrack } from '../../shared/driveTrack';
import type { GameSummary, Situation } from '../../shared/model';
import type { PlayAnimation } from '../../shared/playAnimation';
import { reloadForMissingChunk } from '../lib/chunks';
import { useNearViewport, useReducedMotion } from '../lib/motion';
import { useFieldMode, useGraphics, type FieldMode } from '../state/graphics';
import type { CameraPreset } from './cameras';
import { FieldSvg } from './FieldSvg';
import { fieldFramesDrawn, onFieldFrameDrawn, requestFieldFrame, type PointerState } from './frameBus';

export type FieldVariant = 'card' | 'compact' | 'detail';

export interface FieldViewProps {
  game: GameSummary;
  situation: Situation | null;
  animation: PlayAnimation | null;
  /** The game page only: the drive the field draws behind the ball. */
  drive?: DriveTrack | null;
  variant: FieldVariant;
  /** Draw no ball: the game has not started, is over, or has no reported spot to show. */
  hidden: boolean;
  historical?: boolean;
  preset?: CameraPreset;
  resetToken?: number;
  zoomEnabled?: boolean;
  zoomRequest?: { token: number; factor: number };
  /** Card fields: a changed token makes the camera cut in (Director mode). */
  cutToken?: number;
  /** Card fields: ease the camera to a slightly lower angle while the card is hovered or focused. */
  lift?: boolean;
  /** Card fields: the pointer over the card, which the camera leans toward. A stable mutable object. */
  pointer?: PointerState;
  className?: string;
  children?: ReactNode;
}

export type FieldSceneProps = Omit<FieldViewProps, 'className' | 'children'>;

const Field3D = lazy(() => import('./Field3D'));

/**
 * A field that cannot draw itself falls back rather than breaking the page.
 *
 * In 3D that means falling back to 2D: the chunk may be missing because a new
 * version was deployed, in which case the page reloads to fetch it, and anything
 * else is reported as a lost context so every other field on the page drops to
 * 2D with it.
 *
 * In 2D there is nowhere left to fall back to, so the field is simply left out
 * and the rest of the page carries on. This covers the 2D branch because it has
 * to: a failure there used to pass straight through to the view's own boundary
 * and take the whole game page down with it, which is the one thing a decorative
 * field must never do, and it did it at exactly the worst moment, when a lost
 * context had just handed 2D the job.
 */
class FieldBoundary extends Component<{ children: ReactNode; mode: FieldMode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    if (reloadForMissingChunk(error)) return;
    if (this.props.mode === '3d') {
      console.error('Gridiron: a 3D field could not load and fell back to 2D.', error);
      useGraphics.getState().markLost();
      return;
    }
    // Already 2D. Saying the context was lost again would only loop the banner.
    console.error('Gridiron: a 2D field could not be drawn and was left out.', error);
  }
  override componentDidUpdate(previous: { mode: FieldMode }) {
    // A field that failed in 3D is given its chance again in 2D, and vice versa.
    if (previous.mode !== this.props.mode && this.state.failed) this.setState({ failed: false });
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export const FieldView = memo(function FieldView({ className = '', children, ...scene }: FieldViewProps) {
  const mode = useFieldMode();
  const reducedMotion = useReducedMotion();
  const slot = useRef<HTMLDivElement>(null);
  // Tells the app there is a field on this page, so the shared canvas is built where one is wanted and nowhere else.
  useEffect(() => useGraphics.getState().registerSlot(), []);
  const near = useNearViewport(slot, scene.variant === 'detail' ? '120px' : '420px');

  /*
   * The flat field stands in until the canvas has actually painted this view,
   * and then gets out of the way. It has to leave, rather than sit underneath:
   * the 3D field is drawn in perspective and does not fill its box to the
   * corners, so anything left behind it shows around the edges as a second,
   * flatter field.
   *
   * Two drawn frames, not one. The frame that mounts a view is often the frame
   * that clears its rectangle; the next one is the first with a field in it.
   */
  const [painted, setPainted] = useState(false);
  const live = mode === '3d' && near;
  useEffect(() => {
    if (!live) {
      setPainted(false);
      return;
    }
    const from = fieldFramesDrawn();
    let done = false;
    const check = () => {
      if (done || fieldFramesDrawn() < from + 2) return;
      done = true;
      setPainted(true);
    };
    const off = onFieldFrameDrawn(check);
    requestFieldFrame();
    return () => {
      off();
    };
  }, [live, scene.game.id]);
  const trailFrom = scene.animation && !scene.animation.corrected ? scene.animation.fromYard : null;

  /*
   * The flat field, which is what 2D mode draws for every card and what stands
   * in until the 3D one is up.
   *
   * It used to render nothing there. A card reaching the screen before its 3D
   * view had mounted showed an empty box, and then the field appeared in it:
   * measured at up to 1.7 seconds on a slate that reorders itself while you
   * read, because a card can be moved into view rather than scrolled into it,
   * and the observer that mounts the view only fires once it is already there.
   * That wait is what reads as the field being late and then snapping into
   * place. There is no hole now: the same spot, the same yard line, the same
   * reported ball, drawn flat, and the 3D field takes over when it is ready.
   */
  const flat = (
    <FieldSvg
      game={scene.game}
      situation={scene.hidden ? null : scene.situation}
      compact={scene.variant === 'compact'}
      fromYard={trailFrom}
      historical={scene.historical}
      drive={scene.variant === 'detail' ? (scene.drive ?? null) : null}
    />
  );

  /* The same field with nothing on it: the turf, the lines, the end zones and
     no situation, drive or trail. It stands in for the 3D field for the frame
     or two before the canvas draws, and everything it leaves out is about to be
     drawn over anyway. The full one costs enough during a scroll to be worth
     not drawing twice. */
  const bare = (
    <FieldSvg
      game={scene.game}
      situation={null}
      compact={scene.variant === 'compact'}
      fromYard={null}
      historical={scene.historical}
      drive={null}
    />
  );

  return (
    <div ref={slot} className={`field-slot field-${scene.variant} ${className}`} data-field-mode={mode}>
      <FieldBoundary mode={mode}>
        {/*
          * The flat field sits underneath, from the moment this slot comes
          * within reach of the viewport. A mounted 3D view is an empty div: its
          * pixels come from the shared canvas, which is fixed over the page and
          * scissors into the view's rectangle, so between the view mounting and
          * the canvas drawing there is nothing in the box at all. That gap is
          * what reads as the field arriving late and snapping into place, and
          * on a slate that reorders itself while you read it is not rare.
          *
          * On the same gate as the 3D view rather than always: drawing it for
          * every slot on the page, mounted or not, cost three times the blocked
          * time during a scroll, which is the other half of the same complaint.
          * Both appear in the same commit, the flat one paints immediately
          * because it is DOM, and the 3D one paints over it on the next frame.
          */}
        {mode === '2d' ? flat : live && !painted ? bare : null}
        {mode === '3d' && near ? (
          <Suspense fallback={null}>
            <Field3D {...scene} reducedMotion={reducedMotion} />
          </Suspense>
        ) : null}
      </FieldBoundary>
      {children}
    </div>
  );
});
