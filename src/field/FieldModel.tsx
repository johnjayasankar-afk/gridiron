/**
 * The static miniature: base, turf and markings, team end zones, goal posts,
 * pylons and lighting. The holographic style floats the field over a grid floor
 * on a dark glass slab with a neon rim; the classic style is painted turf.
 */
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { memo, useEffect, useMemo } from 'react';
import type { LeagueId, Team } from '../../shared/model';
import { fieldGeometry, fieldMaterials } from './geometry';
import type { FieldStyle } from './style';
import { fieldProbe } from './probe';
import { acquireEndZone, acquireMidfield, endZoneKey, getFieldTexture, midfieldKey, releaseEndZone, releaseMidfield, retainEndZone, retainMidfield, type EndZoneSide, type FieldSurface, type TextureLevel } from './textures';
import type { Sky } from '../../shared/sky';
import { SKY_STRENGTH, skyLook, skyTint } from '../../shared/sky';

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

/**
 * The home team's mark at the fifty, held for as long as this field shows it.
 * The same shape as the end zone's hook, for the same reason: one texture per
 * team, kept a little after nothing is showing it.
 */
function useMidfield(team: Team, style: FieldStyle, level: TextureLevel) {
  const key = midfieldKey(team, style, level);
  const texture = useMemo(() => acquireMidfield(team, style, level), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    retainMidfield(key);
    // Reported by the game page's field only. A card's field draws the same
    // mark, and thirteen of them would take turns overwriting this.
    if (level === 'high') fieldProbe.midfield = key;
    return () => releaseMidfield(key);
  }, [key, level]);
  return texture;
}

export interface FieldModelProps {
  league: LeagueId;
  home: Team;
  away: Team;
  level: TextureLevel;
  pylons: boolean;
  style: FieldStyle;
  /** The sky the provider reports at this venue, or null where it reported none. */
  sky: Sky | null;
  /** What the venue is played on, where the provider says. */
  surface: FieldSurface;
}

/**
 * The colour the turf is multiplied by so a field is lit by its own sky.
 *
 * The turf, the end zones and the mark at the fifty are unlit textures, which is
 * why they are crisp at card size and cost one draw call each. That means a
 * light cannot reach them, so the sky reaches them here instead: one colour,
 * applied to all three, so the field is lit as one surface rather than a lit
 * field with unlit paint on it. Rebuilt only when the sky changes, which for a
 * game is at most once.
 */
function useSkyTint(sky: Sky | null, holo: boolean): THREE.Color {
  // The arithmetic lives in shared/sky so the 2D field multiplies its own turf by the same colour.
  return useMemo(() => new THREE.Color(skyTint(skyLook(sky), holo ? SKY_STRENGTH.holo : SKY_STRENGTH.classic)), [sky?.kind, sky?.night, holo]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const FieldModel = memo(function FieldModel({ league, home, away, level, pylons, style, sky, surface }: FieldModelProps) {
  const G = fieldGeometry();
  const M = fieldMaterials();
  const holo = style === 'holo';
  const anisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
  const turf = useMemo(() => getFieldTexture(league, anisotropy, style, surface), [league, anisotropy, style, surface]);
  const tint = useSkyTint(sky, holo);
  // Held rather than rebuilt: thirteen card fields each re-derive this on every render otherwise.
  const look = useMemo(() => skyLook(sky), [sky?.kind, sky?.night]); // eslint-disable-line react-hooks/exhaustive-deps
  // Schematic orientation: the away team defends the left end zone, the home team the right.
  const awayZone = useEndZone(away, 'left', level, style);
  const homeZone = useEndZone(home, 'right', level, style);
  const midfield = useMidfield(home, style, level);

  return (
    <group>
      {/* The sky scales what the lights do: less sun and more of the sky itself as the weather closes in, and a roof is its own even light. */}
      <hemisphereLight args={holo ? ['#bff7de', '#020805', 1.5 * (look?.ambient ?? 1)] : ['#f1fff7', '#0b1811', 2.1 * (look?.ambient ?? 1)]} />
      <directionalLight position={sky?.indoor ? [0, 140, 0] : [-40, 120, 80]} intensity={(holo ? 1.1 : 1.6) * (look?.light ?? 1)} color={look?.tint ?? '#ffffff'} />
      {holo && <mesh geometry={G.floor} material={M.holo.floor} position={[0, -3.45, 0]} renderOrder={-2} />}
      <mesh geometry={G.shadow} material={M.shadow} position={[2, -3.4, 5]} renderOrder={-1} />
      <mesh geometry={G.slab} material={holo ? M.holo.slab : M.slab} position={[0, -1.64, 0]} />
      {holo && <mesh geometry={G.rim} material={M.holo.rim} position={[0, -0.02, 0]} />}
      <mesh geometry={G.turf}>
        <meshBasicMaterial map={turf} color={tint} toneMapped={false} />
      </mesh>
      {/* Painted into the turf, so it sits under every line and marker that is
          drawn on top of it, and adds as light on the holographic field rather
          than covering it. */}
      <mesh geometry={G.midfield} position={[0, 0.012, 0]} renderOrder={-1}>
        <meshBasicMaterial map={midfield} color={tint} transparent opacity={holo ? 0.55 : 0.8} depthWrite={false} blending={holo ? THREE.AdditiveBlending : THREE.NormalBlending} toneMapped={false} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-2} />
      </mesh>
      <mesh geometry={G.endZone} position={[-55, 0.02, 0]}>
        <meshBasicMaterial map={awayZone} color={tint} toneMapped={false} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-4} />
      </mesh>
      <mesh geometry={G.endZone} position={[55, 0.02, 0]}>
        <meshBasicMaterial map={homeZone} color={tint} toneMapped={false} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-4} />
      </mesh>
      <mesh geometry={G.posts[league]} material={holo ? M.holo.posts[league] : M.posts[league]} />
      {pylons && <mesh geometry={G.pylons[league]} material={holo ? M.holo.pylon : M.pylon} />}
    </group>
  );
});
