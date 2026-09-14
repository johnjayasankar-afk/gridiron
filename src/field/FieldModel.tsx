/**
 * The static miniature: base, turf and markings, team end zones, goal posts,
 * pylons and lighting. The holographic style floats the field over a grid floor
 * on a dark glass slab with a neon rim; the classic style is painted turf.
 */
import { useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo } from 'react';
import type { LeagueId, Team } from '../../shared/model';
import { fieldGeometry, fieldMaterials } from './geometry';
import type { FieldStyle } from './style';
import { acquireEndZone, endZoneKey, getFieldTexture, releaseEndZone, retainEndZone, type EndZoneSide, type TextureLevel } from './textures';

function useEndZone(team: Team, side: EndZoneSide, level: TextureLevel, style: FieldStyle) {
  const key = endZoneKey(team, side, level, style);
  // The key captures everything the texture depends on.
  const texture = useMemo(() => acquireEndZone(team, side, level, style), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    retainEndZone(key);
    return () => releaseEndZone(key);
  }, [key]);
  return texture;
}

export interface FieldModelProps {
  league: LeagueId;
  home: Team;
  away: Team;
  level: TextureLevel;
  pylons: boolean;
  style: FieldStyle;
}

export const FieldModel = memo(function FieldModel({ league, home, away, level, pylons, style }: FieldModelProps) {
  const G = fieldGeometry();
  const M = fieldMaterials();
  const holo = style === 'holo';
  const anisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
  const turf = useMemo(() => getFieldTexture(league, anisotropy, style), [league, anisotropy, style]);
  // Schematic orientation: the away team defends the left end zone, the home team the right.
  const awayZone = useEndZone(away, 'left', level, style);
  const homeZone = useEndZone(home, 'right', level, style);

  return (
    <group>
      <hemisphereLight args={holo ? ['#bff7de', '#020805', 1.5] : ['#f1fff7', '#0b1811', 2.1]} />
      <directionalLight position={[-40, 120, 80]} intensity={holo ? 1.1 : 1.6} />
      {holo && <mesh geometry={G.floor} material={M.holo.floor} position={[0, -3.45, 0]} renderOrder={-2} />}
      <mesh geometry={G.shadow} material={M.shadow} position={[2, -3.4, 5]} renderOrder={-1} />
      <mesh geometry={G.slab} material={holo ? M.holo.slab : M.slab} position={[0, -1.64, 0]} />
      {holo && <mesh geometry={G.rim} material={M.holo.rim} position={[0, -0.02, 0]} />}
      <mesh geometry={G.turf}>
        <meshBasicMaterial map={turf} toneMapped={false} />
      </mesh>
      <mesh geometry={G.endZone} position={[-55, 0.02, 0]}>
        <meshBasicMaterial map={awayZone} toneMapped={false} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-4} />
      </mesh>
      <mesh geometry={G.endZone} position={[55, 0.02, 0]}>
        <meshBasicMaterial map={homeZone} toneMapped={false} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-4} />
      </mesh>
      <mesh geometry={G.posts[league]} material={holo ? M.holo.posts[league] : M.posts[league]} />
      {pylons && <mesh geometry={G.pylons[league]} material={holo ? M.holo.pylon : M.pylon} />}
    </group>
  );
});
