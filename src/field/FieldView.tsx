/**
 * A field on a card, on the wall, or on the game page. It draws into the shared
 * canvas when 3D is available and the field is near the viewport, and as SVG
 * otherwise. The 3D layer is its own chunk, loaded on first use. Everything a
 * viewer must read (messages, labels) is DOM, passed in as children and layered
 * above the field.
 */
import { Component, lazy, memo, Suspense, useRef, type ReactNode } from 'react';
import type { GameSummary, Situation } from '../../shared/model';
import type { PlayAnimation } from '../../shared/playAnimation';
import { reloadForMissingChunk } from '../lib/chunks';
import { useNearViewport, useReducedMotion } from '../lib/motion';
import { useFieldMode, useGraphics } from '../state/graphics';
import type { CameraPreset } from './cameras';
import { FieldSvg } from './FieldSvg';
import type { PointerState } from './frameBus';

export type FieldVariant = 'card' | 'compact' | 'detail';

export interface FieldViewProps {
  game: GameSummary;
  situation: Situation | null;
  animation: PlayAnimation | null;
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
 * A 3D chunk that cannot load falls back to 2D instead of breaking the card. When
 * the chunk is missing because a new version was deployed, the page reloads first.
 */
class FieldBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    if (reloadForMissingChunk(error)) return;
    console.error('Gridiron: a 3D field could not load and fell back to 2D.', error);
    useGraphics.getState().markLost();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export const FieldView = memo(function FieldView({ className = '', children, ...scene }: FieldViewProps) {
  const mode = useFieldMode();
  const reducedMotion = useReducedMotion();
  const slot = useRef<HTMLDivElement>(null);
  const near = useNearViewport(slot, scene.variant === 'detail' ? '120px' : '420px');
  const trailFrom = scene.animation && !scene.animation.corrected ? scene.animation.fromYard : null;

  return (
    <div ref={slot} className={`field-slot field-${scene.variant} ${className}`} data-field-mode={mode}>
      {mode === '2d' ? (
        <FieldSvg game={scene.game} situation={scene.hidden ? null : scene.situation} compact={scene.variant === 'compact'} fromYard={trailFrom} historical={scene.historical} />
      ) : near ? (
        <FieldBoundary>
          <Suspense fallback={null}>
            <Field3D {...scene} reducedMotion={reducedMotion} />
          </Suspense>
        </FieldBoundary>
      ) : null}
      {children}
    </div>
  );
});
