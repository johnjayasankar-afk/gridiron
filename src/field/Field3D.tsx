/**
 * The 3D side of a field view, loaded on demand so the first paint never waits
 * for three.js. It draws into the shared canvas through a drei View. The game
 * page adds the arena around the field when effects are Full.
 */
import { View } from '@react-three/drei';
import { useEffect, useRef, type RefObject } from 'react';
import { worldX } from '../../shared/field';
import { useGraphics } from '../state/graphics';
import { usePrefs } from '../state/prefs';
import { BallLayer } from './BallLayer';
import { CardCamera, DetailCamera } from './cameras';
import { FieldModel } from './FieldModel';
import type { FieldSceneProps } from './FieldView';
import { Stadium } from './Stadium';

type SceneProps = FieldSceneProps & { track: RefObject<HTMLElement | null>; reducedMotion: boolean };

function FieldScene({ track, game, situation, animation, variant, hidden, preset, resetToken, zoomEnabled, zoomRequest, cutToken, lift, pointer, reducedMotion }: SceneProps) {
  useEffect(() => useGraphics.getState().registerView(), []);
  const fieldStyle = usePrefs((s) => s.fieldStyle);
  const effects = usePrefs((s) => s.effects);
  const compact = variant === 'compact';
  const detail = variant === 'detail';
  const yard = hidden ? null : (situation?.spot.schematicYard ?? null);
  return (
    <>
      {detail ? (
        <DetailCamera
          track={track}
          preset={preset ?? 'isometric'}
          resetToken={resetToken ?? 0}
          focusX={yard === null ? 0 : worldX(yard)}
          reducedMotion={reducedMotion}
          zoomEnabled={zoomEnabled ?? false}
          zoomRequest={zoomRequest ?? { token: 0, factor: 1 }}
          flyIn={effects === 'full'}
        />
      ) : (
        <CardCamera track={track} compact={compact} cutToken={cutToken ?? 0} lift={lift ?? false} reducedMotion={reducedMotion} pointer={pointer} />
      )}
      {detail && fieldStyle === 'holo' && effects === 'full' && <Stadium />}
      <FieldModel league={game.league} home={game.home} away={game.away} level={detail ? 'high' : 'low'} pylons={!compact} style={fieldStyle} />
      <BallLayer
        league={game.league}
        situation={situation}
        animation={animation}
        reducedMotion={reducedMotion}
        compact={compact}
        hidden={hidden}
        homeColor={game.home.color}
        awayColor={game.away.color}
        style={fieldStyle}
        perspective={detail}
      />
    </>
  );
}

export default function Field3D(props: FieldSceneProps & { reducedMotion: boolean }) {
  const viewRef = useRef<HTMLElement | null>(null);
  return (
    <View ref={viewRef as never} className="field-view">
      <FieldScene {...props} track={viewRef} />
    </View>
  );
}
