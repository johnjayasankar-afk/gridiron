/**
 * The 3D side of a field view, loaded on demand so the first paint never waits
 * for three.js. It draws into the shared canvas through a drei View. The game
 * page adds the arena around the field when effects are Full.
 */
import { View } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { worldX } from '../../shared/field';
import { skyFor } from '../../shared/sky';
import { useGraphics } from '../state/graphics';
import { usePrefs } from '../state/prefs';
import { BallLayer } from './BallLayer';
import { CardCamera, DetailCamera } from './cameras';
import { DriveLayer } from './DriveLayer';
import { FieldModel } from './FieldModel';
import { createBallTrack } from './frameBus';
import type { FieldSceneProps } from './FieldView';
import { Stadium } from './Stadium';
import { WeatherLayer } from './WeatherLayer';

type SceneProps = FieldSceneProps & { track: RefObject<HTMLElement | null>; reducedMotion: boolean };

function FieldScene({ track, game, situation, animation, drive, variant, hidden, preset, resetToken, zoomEnabled, zoomRequest, cutToken, lift, pointer, reducedMotion }: SceneProps) {
  useEffect(() => useGraphics.getState().registerView(), []);
  const fieldStyle = usePrefs((s) => s.fieldStyle);
  const effects = usePrefs((s) => s.effects);
  const compact = variant === 'compact';
  const detail = variant === 'detail';
  const yard = hidden ? null : (situation?.spot.schematicYard ?? null);
  /*
   * The sky this game is actually being played under, from the weather the
   * provider reports at the venue and whether that venue has a roof. Where it
   * reports neither the field is lit exactly as it was before there was a sky.
   */
  const sky = useMemo(() => skyFor(game.weather, game.venue?.indoor), [game.weather?.conditionId, game.weather?.temperature, game.weather?.displayValue, game.venue?.indoor]); // eslint-disable-line react-hooks/exhaustive-deps
  const surface = game.venue?.grass === null || game.venue?.grass === undefined ? null : game.venue.grass ? 'grass' : 'turf';
  // The ball layer writes where the ball is; the broadcast camera reads it and
  // pans with the play, the way a camera operator does.
  const [ballTrack] = useState(createBallTrack);
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
          ball={ballTrack}
        />
      ) : (
        <CardCamera track={track} compact={compact} cutToken={cutToken ?? 0} lift={lift ?? false} reducedMotion={reducedMotion} pointer={pointer} />
      )}
      {detail && fieldStyle === 'holo' && effects === 'full' && <Stadium animation={animation} homeColor={game.home.color} awayColor={game.away.color} />}
      {detail && <DriveLayer track={drive ?? null} game={game} />}
      <FieldModel league={game.league} home={game.home} away={game.away} level={detail ? 'high' : 'low'} pylons={!compact} style={fieldStyle} sky={sky} surface={surface} />
      {/* The game page only: thirteen cards each running their own weather would be thirteen of these, for drops a pixel across. */}
      {detail && <WeatherLayer sky={sky} reducedMotion={reducedMotion || effects === 'reduced'} />}
      <BallLayer
        league={game.league}
        situation={situation}
        animation={animation}
        reducedMotion={reducedMotion}
        compact={compact}
        hidden={hidden}
        home={game.home}
        away={game.away}
        style={fieldStyle}
        perspective={detail}
        ballTrack={detail ? ballTrack : null}
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
