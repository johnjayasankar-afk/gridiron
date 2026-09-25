/**
 * A field on a card, on the wall, or on the game page. It draws into the shared
 * canvas when 3D is available and the field is near the viewport, and as SVG
 * otherwise. The 3D layer is its own chunk, loaded on first use. Everything a
 * viewer must read (messages, labels) is DOM, passed in as children and layered
 * above the field.
 */
import { Component, lazy, memo, Suspense, useEffect, useRef, type ReactNode } from 'react';
import type { DriveTrack } from '../../shared/driveTrack';
import type { GameSummary, Situation } from '../../shared/model';
import type { PlayAnimation } from '../../shared/playAnimation';
import { reloadForMissingChunk } from '../lib/chunks';
import { useNearViewport, useReducedMotion } from '../lib/motion';
import { useFieldMode, useGraphics, type FieldMode } from '../state/graphics';
import type { CameraPreset } from './cameras';
import { FieldSvg } from './FieldSvg';
import type { PointerState } from './frameBus';

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
  const trailFrom = scene.animation && !scene.animation.corrected ? scene.animation.fromYard : null;

  return (
    <div ref={slot} className={`field-slot field-${scene.variant} ${className}`} data-field-mode={mode}>
      <FieldBoundary mode={mode}>
        {mode === '2d' ? (
          <FieldSvg
            game={scene.game}
            situation={scene.hidden ? null : scene.situation}
            compact={scene.variant === 'compact'}
            fromYard={trailFrom}
            historical={scene.historical}
            drive={scene.variant === 'detail' ? (scene.drive ?? null) : null}
          />
        ) : near ? (
          <Suspense fallback={null}>
            <Field3D {...scene} reducedMotion={reducedMotion} />
          </Suspense>
        ) : null}
      </FieldBoundary>
      {children}
    </div>
  );
});
