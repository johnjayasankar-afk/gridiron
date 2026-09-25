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

/*
 * Where the air starts to take the field and where it has taken all it is going
 * to, in units from the camera, and how much of the sky's haze actually reaches
 * the ground.
 *
 * The range is the field's own, not a guess: the isometric camera sits about 158
 * units from the middle, so the near touchline is around 110 away and the far
 * corner around 220. A fade that starts at 60 begins before the field does and
 * greys the half nearest the viewer, which is not what air does. It starts past
 * the near edge and finishes past the far corner, so the near numbers stay sharp
 * and only the far end goes.
 *
 * The strength is deliberately a fraction of the sky's own figure. Mixing sixty
 * per cent of the way to white across half a field is a wipe, not weather; at
 * this fraction fog takes about a fifth of the far end and a clear day takes
 * almost nothing, which is the amount a real 120 yards of air is worth.
 */
const HAZE_NEAR = 130;
const HAZE_FAR = 300;
const HAZE_STRENGTH = 0.38;

/**
 * Atmospheric perspective on the field itself.
 *
 * The turf is one unlit texture, so distance did nothing to it: the far goal
 * line was as sharp and as saturated as the one under the camera, and a field in
 * fog looked exactly like a field in the sun with the lights turned down. Real
 * air does not darken what is far away, it takes its colour, so this mixes the
 * ground toward the colour of its own sky with distance from the camera.
 *
 * It is the same two instructions and one varying the stands already use rather
 * than scene fog, which would have to be turned off again on every material the
 * field shares with thirteen cards. It is applied to materials this field owns,
 * and only on the game page: a card's field is two hundred pixels across and has
 * no distance to lose anything in, and thirteen of them would be thirteen more
 * shader programs for an effect nobody could see.
 */
function hazed<T extends THREE.Material>(material: T, strength: number, colour: string): T {
  material.onBeforeCompile = (shader) => {
    const vertexAnchor = '#include <begin_vertex>';
    if (!shader.vertexShader.includes(vertexAnchor)) throw new Error('FieldModel: the basic vertex shader no longer has begin_vertex for the haze patch');
    shader.vertexShader = `varying float vAway;\n${shader.vertexShader.replace(vertexAnchor, `${vertexAnchor}\n\tvAway = -(modelViewMatrix * vec4(position, 1.0)).z;`)}`;
    const fragmentAnchor = 'vec3 outgoingLight = reflectedLight.indirectDiffuse;';
    if (!shader.fragmentShader.includes(fragmentAnchor)) throw new Error('FieldModel: the basic fragment shader no longer has the outgoing light line the haze patch expects');
    const c = new THREE.Color(colour);
    shader.fragmentShader = `varying float vAway;\n${shader.fragmentShader.replace(
      fragmentAnchor,
      `${fragmentAnchor}\n\toutgoingLight = mix(outgoingLight, vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)}), smoothstep(${HAZE_NEAR.toFixed(1)}, ${HAZE_FAR.toFixed(1)}, vAway) * ${strength.toFixed(3)});`,
    )}`;
  };
  return material;
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
  /*
   * The ground's own materials, so the sky can reach into them.
   *
   * They were inline and shared nothing, which was right while nothing needed
   * patching. Distance haze is a shader patch, and a patch belongs to one field:
   * put on a material the whole slate shares it would fog thirteen cards that
   * have no distance to fog. Built here, disposed with the field, and only
   * patched at all where there is enough haze to see and a field big enough to
   * see it in.
   */
  const ground = useMemo(() => {
    const haze = level === 'high' && look && look.haze > 0.02 ? look.haze * HAZE_STRENGTH : 0;
    const air = look?.tint ?? '#ffffff';
    const make = (extra: THREE.MeshBasicMaterialParameters = {}) => {
      const m = new THREE.MeshBasicMaterial({ toneMapped: false, ...extra });
      return haze > 0 ? hazed(m, haze, air) : m;
    };
    return {
      haze,
      turf: make(),
      midfield: make({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
      away: make({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
      home: make({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    };
  }, [level, look?.haze, look?.tint]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => Object.values(ground).forEach((m) => (m instanceof THREE.Material ? m.dispose() : undefined)), [ground]);

  useEffect(() => {
    // Reported by the game page's field only, the same rule the mark at the fifty follows.
    if (level !== 'high') return;
    fieldProbe.haze = ground.haze;
    return () => {
      fieldProbe.haze = 0;
    };
  }, [level, ground]);

  // Schematic orientation: the away team defends the left end zone, the home team the right.
  const awayZone = useEndZone(away, 'left', level, style);
  const homeZone = useEndZone(home, 'right', level, style);
  const midfield = useMidfield(home, style, level);

  // The maps, the sky's colour and the holographic blend ride on the materials rather than rebuilding them.
  ground.turf.map = turf;
  ground.turf.color = tint;
  ground.midfield.map = midfield;
  ground.midfield.color = tint;
  ground.midfield.opacity = holo ? 0.55 : 0.8;
  ground.midfield.blending = holo ? THREE.AdditiveBlending : THREE.NormalBlending;
  ground.away.map = awayZone;
  ground.away.color = tint;
  ground.home.map = homeZone;
  ground.home.color = tint;

  return (
    <group>
      {/* The sky scales what the lights do: less sun and more of the sky itself as the weather closes in, and a roof is its own even light. */}
      <hemisphereLight args={holo ? ['#bff7de', '#020805', 1.5 * (look?.ambient ?? 1)] : ['#f1fff7', '#0b1811', 2.1 * (look?.ambient ?? 1)]} />
      <directionalLight position={sky?.indoor ? [0, 140, 0] : [-40, 120, 80]} intensity={(holo ? 1.1 : 1.6) * (look?.light ?? 1)} color={look?.tint ?? '#ffffff'} />
      {holo && <mesh geometry={G.floor} material={M.holo.floor} position={[0, -3.45, 0]} renderOrder={-2} />}
      <mesh geometry={G.shadow} material={M.shadow} position={[2, -3.4, 5]} renderOrder={-1} />
      <mesh geometry={G.slab} material={holo ? M.holo.slab : M.slab} position={[0, -1.64, 0]} />
      {holo && <mesh geometry={G.rim} material={M.holo.rim} position={[0, -0.02, 0]} />}
      <mesh geometry={G.turf} material={ground.turf} />
      {/* Painted into the turf, so it sits under every line and marker that is
          drawn on top of it, and adds as light on the holographic field rather
          than covering it. */}
      <mesh geometry={G.midfield} position={[0, 0.012, 0]} renderOrder={-1} material={ground.midfield} />
      <mesh geometry={G.endZone} position={[-55, 0.02, 0]} material={ground.away} />
      <mesh geometry={G.endZone} position={[55, 0.02, 0]} material={ground.home} />
      <mesh geometry={G.posts[league]} material={holo ? M.holo.posts[league] : M.posts[league]} />
      {pylons && <mesh geometry={G.pylons[league]} material={holo ? M.holo.pylon : M.pylon} />}
    </group>
  );
});
