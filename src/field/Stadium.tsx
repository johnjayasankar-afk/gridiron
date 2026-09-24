/**
 * The game page's arena around the field: a tiered bowl with a lit front rail,
 * a crowd of seat lights, and four towers with soft beams.
 *
 * It is decoration. It says nothing about the real venue, its size, its crowd or
 * who is in it, and it is the same bowl for every game.
 *
 * All of the geometry is built once and never moves, so the view still renders
 * only on demand. The one thing that changes is the crowd, and only when the
 * provider reports a score or a turnover: for a few seconds the seats take the
 * colour of the team it went for and camera flashes pop through the stands. A
 * turnover is answered more quietly and for less time than a score, because it
 * is a smaller thing. That runs on the same clock as the light on the field,
 * asks for frames while it lasts, and then the arena is static again.
 */
import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { useFrame, useThree } from '@react-three/fiber';
import { useGraphics } from '../state/graphics';
import { scoringZone } from '../../shared/field';
import type { PlayAnimation } from '../../shared/playAnimation';
import { accentFor } from './color';
import { fieldProbe } from './probe';
import { fadeTexture, poolTexture, sparkTexture } from './textures';

const HALF_WIDTH = 160 / 6;
/** How long the stands answer a score, in milliseconds. A turnover is shorter. */
const CHEER_MS = 3400;
const TURNOVER_MS = 2200;

interface Tier {
  /** Centre of the stand's front edge. */
  x: number;
  z: number;
  /** Direction the stand faces (toward the field), as a rotation about y. */
  rotation: number;
  length: number;
  depth: number;
  rows: number;
  rise: number;
}

const TIERS: Tier[] = [
  { x: 0, z: -(HALF_WIDTH + 9), rotation: 0, length: 150, depth: 26, rows: 9, rise: 1.7 },
  { x: 0, z: HALF_WIDTH + 9, rotation: Math.PI, length: 150, depth: 26, rows: 9, rise: 1.7 },
  { x: -79, z: 0, rotation: Math.PI / 2, length: 86, depth: 18, rows: 6, rise: 1.5 },
  { x: 79, z: 0, rotation: -Math.PI / 2, length: 86, depth: 18, rows: 6, rise: 1.5 },
];

const TOWERS: Array<[number, number]> = [
  [-84, -54],
  [84, -54],
  [-84, 54],
  [84, 54],
];

/** The bowl's floor, which everything is measured from. */
const FLOOR = -3.2;
/* A stand is lit from the field, so it is brightest at the rail and falls into
   the dark by the back row. Flat colour made it one grey slab with no bowl in
   it at all. */
const NEAR = new THREE.Color('#0e231c');
const FAR = new THREE.Color('#030a07');
/* The step a row sits on faces up and catches the light; the riser under it
   faces the field and stays in shadow. That difference is what makes the bowl
   read as rows from above, where the risers are hidden and every tread is in
   view. */
const TREAD = new THREE.Color('#1c4235');

const mergeAll = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => mergeGeometries(parts) ?? parts[0];

function place(geometry: THREE.BufferGeometry, tier: Tier): THREE.BufferGeometry {
  geometry.rotateY(tier.rotation);
  geometry.translate(tier.x, 0, tier.z);
  return geometry;
}

/**
 * Shades a step by how high it is and which way it faces, so both survive being
 * merged into one draw call. A material cannot tell one merged step from
 * another, but the vertices can carry it.
 */
function shade(geometry: THREE.BufferGeometry, top: number): THREE.BufferGeometry {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const colors = new Float32Array(position.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const height = THREE.MathUtils.clamp((position.getY(i) - FLOOR) / Math.max(0.001, top - FLOOR), 0, 1);
    const up = Math.max(0, normal.getY(i));
    c.copy(NEAR).lerp(FAR, height ** 0.8).lerp(TREAD, up * (0.78 - height * 0.5));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function build() {
  const steps: THREE.BufferGeometry[] = [];
  const rails: THREE.BufferGeometry[] = [];
  const lights: number[] = [];
  const colors: number[] = [];
  const phases: number[] = [];
  let seed = 20260914;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

  for (const tier of TIERS) {
    const rowDepth = tier.depth / tier.rows;
    const crest = tier.rows * tier.rise + FLOOR;
    // The lit rail along the front of the stand. It is the line that makes a
    // bowl read as a bowl: without it the stands are a dark mass with no edge.
    const rail = new THREE.PlaneGeometry(tier.length, 0.42);
    rail.translate(0, tier.rise + FLOOR - 0.24, 0.06);
    rails.push(place(rail, tier));
    // And a line along the back of the top row. Without it the crowd simply
    // stops against the black and the bowl has no top edge at all.
    const lip = new THREE.PlaneGeometry(tier.length, 0.3);
    lip.rotateX(-Math.PI / 2);
    lip.translate(0, crest + 0.04, -tier.depth + 0.15);
    rails.push(place(lip, tier));

    for (let row = 0; row < tier.rows; row++) {
      const height = (row + 1) * tier.rise;
      // Local frame: the stand runs along x and climbs away from the field toward -z.
      const step = new THREE.BoxGeometry(tier.length, height, rowDepth);
      step.translate(0, height / 2 + FLOOR, -(row + 0.5) * rowDepth);
      steps.push(place(shade(step, crest), tier));
      const count = Math.floor(tier.length / 0.78);
      for (let i = 0; i < count; i++) {
        // Sparse and irregular, like scattered phone and seat lights, not a printed grid.
        if (rand() < 0.46) continue;
        const local = new THREE.Vector3(-tier.length / 2 + rand() * tier.length, height + FLOOR + 0.2 + (rand() - 0.5) * 0.35, -row * rowDepth - 0.2 - rand() * rowDepth * 0.6);
        local.applyAxisAngle(new THREE.Vector3(0, 1, 0), tier.rotation);
        lights.push(local.x + tier.x, local.y, local.z + tier.z);
        const warm = rand() < 0.16;
        const level = 0.32 + rand() ** 2 * 0.86;
        colors.push((warm ? 1 : 0.62) * level, (warm ? 0.82 : 1) * level, (warm ? 0.55 : 0.84) * level);
        // Each seat keeps its own moment in a celebration, so the flashes scatter
        // through the stands instead of the whole crowd blinking at once.
        phases.push(rand());
      }
    }
  }

  const poles: THREE.BufferGeometry[] = [];
  const panels: THREE.BufferGeometry[] = [];
  const cones: THREE.BufferGeometry[] = [];
  const lamps: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const [x, z] of TOWERS) {
    const pole = new THREE.CylinderGeometry(0.5, 0.7, 40, 8);
    pole.translate(x, 17, z);
    poles.push(pole);
    const top = new THREE.Vector3(x, 38, z);
    lamps.push(top.x, top.y, top.z);
    const aim = new THREE.Vector3(x * 0.25, 0, z * 0.2);
    const panel = new THREE.BoxGeometry(7, 3.2, 0.6);
    panel.lookAt(aim.clone().sub(top));
    panel.translate(top.x, top.y, top.z);
    panels.push(panel);
    const direction = top.clone().sub(aim);
    const length = direction.length();
    const cone = new THREE.CylinderGeometry(2.2, 20, length, 28, 1, true);
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()));
    const middle = top.clone().add(aim).multiplyScalar(0.5);
    cone.translate(middle.x, middle.y, middle.z);
    cones.push(cone);
  }

  // Where each tower's beam lands, as a soft pool on the turf. Four of them
  // overlapping is a lit field: brightest between the hashes and falling away to
  // the corners, which is what a floodlit field looks like from above.
  const pools = TOWERS.map(([x, z]) => {
    const pool = new THREE.PlaneGeometry(138, 96);
    pool.rotateX(-Math.PI / 2);
    pool.translate(x * 0.25, 0.03, z * 0.2);
    return pool;
  });

  const lightGeometry = new THREE.BufferGeometry();
  lightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
  lightGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  lightGeometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
  const lampGeometry = new THREE.BufferGeometry();
  lampGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3));

  return {
    stands: mergeAll(steps),
    pools: mergeAll(pools),
    rails: mergeAll(rails),
    lights: lightGeometry,
    poles: mergeAll(poles),
    panels: mergeAll(panels),
    lamps: lampGeometry,
    cones: mergeAll(cones),
  };
}

let cache: ReturnType<typeof build> | null = null;

export interface StadiumProps {
  /** The play the field is showing, so the stands can answer a reported score. */
  animation: PlayAnimation | null;
  homeColor: string | null;
  awayColor: string | null;
}

export const Stadium = memo(function Stadium({ animation, homeColor, awayColor }: StadiumProps) {
  const geometry = (cache ??= build());
  const invalidate = useThree((s) => s.invalidate);

  const uniforms = useMemo(
    () => ({
      uFlash: { value: 0 },
      uPulse: { value: 0 },
      uTeam: { value: new THREE.Color('#ffffff') },
      uMaxSize: { value: 10 },
    }),
    [],
  );

  const materials = useMemo(() => {
    const crowd = new THREE.PointsMaterial({
      map: sparkTexture(),
      size: 1.15,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    /*
     * The celebration is patched into the stock points shader rather than
     * replacing it, so size attenuation stays three.js's own and one crowd is
     * still one draw call. Each seat pops at its own moment, from the phase it
     * was built with, and takes the scoring team's colour as it does.
     */
    crowd.onBeforeCompile = (shader) => {
      shader.uniforms.uFlash = uniforms.uFlash;
      shader.uniforms.uPulse = uniforms.uPulse;
      shader.uniforms.uTeam = uniforms.uTeam;
      shader.uniforms.uMaxSize = uniforms.uMaxSize;
      shader.vertexShader = `attribute float aPhase;\nuniform float uFlash;\nuniform float uPulse;\nuniform float uMaxSize;\nvarying float vFlash;\nvarying float vAway;\n${shader.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tfloat pop = abs(fract(uPulse * 2.6 + aPhase) - 0.5);\n\tvFlash = uFlash * exp(-pop * pop * 520.0);')
        .replace('gl_PointSize = size;', 'gl_PointSize = size * (1.0 + vFlash * 2.2);')
        // Attenuation is right for a seat a hundred yards away and wrong for one
        // in the front row of the near stand, which blooms into a white blob
        // across the bottom of a broadcast shot. A seat is a seat: cap it.
        .replace('#include <clipping_planes_vertex>', '#include <clipping_planes_vertex>\n\tgl_PointSize = min(gl_PointSize, uMaxSize);\n\tvAway = -mvPosition.z;')}`;
      // The wash and the pop do different work: the whole crowd leans to the
      // scoring team's colour while it lasts, and single seats flash white the
      // way a camera does. Tinting with the pop made one white bowl instead.
      shader.fragmentShader = `uniform vec3 uTeam;\nuniform float uFlash;\nvarying float vFlash;\nvarying float vAway;\n${shader.fragmentShader.replace(
        'outgoingLight = diffuseColor.rgb;',
        'vec3 team = uTeam * max(0.3, dot(diffuseColor.rgb, vec3(0.34)) * 2.1);\n\toutgoingLight = (mix(diffuseColor.rgb, team, uFlash * 0.7) + vFlash * 1.3) * (1.0 - smoothstep(110.0, 330.0, vAway) * 0.5);',
      )}`;
    };
    /*
     * Distance falloff for the bowl.
     *
     * Everything in the scene was equally lit however far away it was, so the
     * far side of the stadium read as bright and as sharp as the near touchline
     * and the whole thing sat flat. This darkens the stands with how far they
     * are from the camera, which is haze, and costs two instructions and one
     * varying rather than scene fog, which would have meant turning fog off on
     * every material the field shares with thirteen cards.
     */
    const haze = (material: THREE.Material, strength: number) => {
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = `varying float vAway;\n${shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAway = -(modelViewMatrix * vec4(position, 1.0)).z;')}`;
        shader.fragmentShader = `varying float vAway;\n${shader.fragmentShader.replace(
          'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
          `vec3 outgoingLight = reflectedLight.indirectDiffuse * (1.0 - smoothstep(110.0, 330.0, vAway) * ${strength.toFixed(2)});`,
        )}`;
      };
      return material;
    };

    return {
      stands: haze(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), 0.8),
      rails: haze(new THREE.MeshBasicMaterial({ color: '#7fe9c0', transparent: true, opacity: 0.34, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), 0.62),
      crowd,
      pools: new THREE.MeshBasicMaterial({ map: poolTexture(), color: '#c6f5e2', transparent: true, opacity: 0.075, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      poles: new THREE.MeshStandardMaterial({ color: '#0c1c14', roughness: 0.6, metalness: 0.5 }),
      // Lamp heads glow instead of showing solid white faces, which from a phone's wider view read as a stray card beside the field.
      panels: new THREE.MeshBasicMaterial({ color: '#a8f0d0', transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      lamps: new THREE.PointsMaterial({ map: sparkTexture(), color: '#dffff2', size: 10, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      cones: new THREE.MeshBasicMaterial({ map: fadeTexture('down'), color: '#c9fbe6', transparent: true, opacity: 0.13, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
    };
  }, [uniforms]);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);

  // The cap is in device pixels, and the renderer's resolution moves with the
  // effects setting and with measured frame cost, so it has to move with it.
  const dpr = useGraphics((s) => s.dpr);
  useEffect(() => {
    uniforms.uMaxSize.value = 10 * dpr;
  }, [dpr, uniforms]);

  const teams = useMemo(() => ({ home: new THREE.Color(accentFor(homeColor, true)), away: new THREE.Color(accentFor(awayColor, true)) }), [homeColor, awayColor]);
  const cheer = useRef<{ start: number; length: number; peak: number } | null>(null);
  const key = useRef<string | null>(null);

  useEffect(() => {
    if (!animation || key.current === animation.key) return;
    key.current = animation.key;
    const score = animation.effect === 'touchdown' || animation.effect === 'field_goal';
    const turnover = animation.effect === 'turnover';
    if (!score && !turnover) return;
    if (score) {
      // The stands answer the team whose end zone the ball reached, which is the
      // same reading the field's own light uses.
      const zone = scoringZone(animation.toYard, animation.offenseBefore);
      uniforms.uTeam.value.copy(zone === 1 ? teams.away : teams.home);
    } else {
      // A turnover belongs to whoever the provider says has the ball after it.
      const side = animation.offenseAfter;
      if (!side) return;
      uniforms.uTeam.value.copy(side === 'home' ? teams.home : teams.away);
    }
    cheer.current = { start: performance.now() + animation.durationMs, length: score ? CHEER_MS : TURNOVER_MS, peak: score ? 0.9 : 0.62 };
    fieldProbe.cheerFor = score ? 'score' : 'turnover';
    invalidate();
  }, [animation, invalidate, teams, uniforms]);

  useFrame(() => {
    const c = cheer.current;
    if (!c) return;
    const age = performance.now() - c.start;
    if (age < 0) {
      invalidate();
      return;
    }
    if (age >= c.length) {
      cheer.current = null;
      uniforms.uFlash.value = 0;
      uniforms.uPulse.value = 0;
      fieldProbe.cheer = 0;
      fieldProbe.cheerFor = null;
      invalidate();
      return;
    }
    const t = age / c.length;
    // Loudest as it lands and falling away, never a flat blink.
    uniforms.uFlash.value = c.peak * Math.sin(Math.PI * t) ** 0.6;
    uniforms.uPulse.value = t;
    fieldProbe.cheer = uniforms.uFlash.value;
    invalidate();
  });

  return (
    <group>
      <mesh geometry={geometry.stands} material={materials.stands} />
      <mesh geometry={geometry.pools} material={materials.pools} renderOrder={1} />
      <mesh geometry={geometry.rails} material={materials.rails} renderOrder={1} />
      <points geometry={geometry.lights} material={materials.crowd} />
      <mesh geometry={geometry.poles} material={materials.poles} />
      <mesh geometry={geometry.panels} material={materials.panels} renderOrder={2} />
      <mesh geometry={geometry.cones} material={materials.cones} renderOrder={2} />
      <points geometry={geometry.lamps} material={materials.lamps} renderOrder={3} />
    </group>
  );
});
