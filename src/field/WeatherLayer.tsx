/**
 * What is falling on the field, when the provider says something is.
 *
 * The weather at a venue is reported, so a game played in the snow is drawn in
 * the snow. Nothing here is a forecast or a mood: rain appears when the reported
 * condition is rain or a thunderstorm, snow when it is snow or ice, and nothing
 * at all otherwise, which is most games. Indoors there is never anything, which
 * is the point of a roof.
 *
 * It is one Points draw over the field, moved on the GPU: a vertex shader walks
 * each drop down its own column at its own speed and wraps it back to the top,
 * so a frame costs one uniform write and nothing is rebuilt while it falls. Rain
 * is drawn as a streak by the same trick the trail uses, stretched along its
 * fall; snow drifts sideways as it comes down, because it does.
 *
 * Only ever built for the game page. Thirteen cards each running their own
 * weather would be thirteen of these, for drops a pixel across.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Sky } from '../../shared/sky';
import { fieldProbe } from './probe';

/** The volume weather falls through: the field and a little past its sidelines. */
const SPAN_X = 132;
const SPAN_Z = 64;
const TOP = 46;

const COUNT = { rain: 1800, snow: 1100 };
/** Yards a second. Rain falls hard; snow does not. */
const FALL = { rain: 78, snow: 9 };

function dropGeometry(count: number, random: () => number): THREE.BufferGeometry {
  const position = new Float32Array(count * 3);
  // Each drop keeps its own phase and its own speed, so nothing falls in ranks.
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    position[i * 3] = (random() - 0.5) * SPAN_X;
    position[i * 3 + 1] = 0;
    position[i * 3 + 2] = (random() - 0.5) * SPAN_Z;
    phase[i] = random();
    speed[i] = 0.7 + random() * 0.6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, TOP / 2, 0), 120);
  return g;
}

export const WeatherLayer = memo(function WeatherLayer({ sky, reducedMotion }: { sky: Sky | null; reducedMotion: boolean }) {
  const kind = sky?.precipitation ?? null;
  const invalidate = useThree((s) => s.invalidate);
  const time = useRef({ value: 0 });
  const snow = kind === 'snow';

  const { geometry, material } = useMemo(() => {
    if (!kind) return { geometry: null, material: null };
    let seed = snow ? 20260101 : 19790101;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const g = dropGeometry(COUNT[kind], random);
    const m = new THREE.PointsMaterial({
      size: snow ? 0.42 : 0.2,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      // Falling water and snow catch light rather than block it.
      blending: THREE.AdditiveBlending,
      color: new THREE.Color(snow ? '#f2f8ff' : '#cfe0f5'),
      opacity: snow ? 0.72 : 0.42,
      toneMapped: false,
    });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time.current;
      shader.uniforms.uFall = { value: FALL[kind] };
      shader.uniforms.uDrift = { value: snow ? 1 : 0 };
      const head = `
        uniform float uTime;
        uniform float uFall;
        uniform float uDrift;
        attribute float aPhase;
        attribute float aSpeed;
        varying float vFade;
      `;
      shader.vertexShader = head + shader.vertexShader;
      /*
       * The drop's height is its own phase carried down by the clock and wrapped
       * with fract, so it never runs out of sky and nothing is written back to
       * the buffer. Snow is given a slow sideways wander from the same phase, so
       * two flakes beside each other never drift together.
       */
      const anchor = '#include <begin_vertex>';
      if (!shader.vertexShader.includes(anchor)) throw new Error('WeatherLayer: the points vertex shader no longer has begin_vertex to patch');
      shader.vertexShader = shader.vertexShader.replace(
        anchor,
        `${anchor}
        float fall = fract(aPhase + uTime * uFall * aSpeed / ${TOP.toFixed(1)});
        transformed.y = ${TOP.toFixed(1)} * (1.0 - fall);
        transformed.x += uDrift * sin(uTime * 0.7 * aSpeed + aPhase * 39.0) * 4.0;
        transformed.z += uDrift * cos(uTime * 0.5 * aSpeed + aPhase * 17.0) * 3.0;
        // Fades in at the top and out as it reaches the grass, so nothing pops.
        vFade = smoothstep(0.0, 0.08, fall) * (1.0 - smoothstep(0.86, 1.0, fall));`,
      );
      const size = 'gl_PointSize = size;';
      if (!shader.vertexShader.includes(size)) throw new Error('WeatherLayer: the points vertex shader no longer sets gl_PointSize the way this patch expects');
      // Rain is a streak rather than a dot: the same point drawn tall.
      shader.vertexShader = shader.vertexShader.replace(size, `gl_PointSize = size * (uDrift > 0.5 ? 1.0 : 1.0 + 2.2 * (1.0 - uDrift));`);

      shader.fragmentShader = `varying float vFade;\n${shader.fragmentShader}`;
      const out = 'outgoingLight = diffuseColor.rgb;';
      if (!shader.fragmentShader.includes(out)) throw new Error('WeatherLayer: the points fragment shader no longer has the outgoing light line this patch expects');
      shader.fragmentShader = shader.fragmentShader.replace(out, `${out}\n        diffuseColor.a *= vFade;`);
    };
    return { geometry: g, material: m };
  }, [kind, snow]);

  useEffect(
    () => () => {
      geometry?.dispose();
      material?.dispose();
    },
    [geometry, material],
  );

  /*
   * Reduced motion holds a still frame rather than removing the weather: the
   * reported fact is that it is snowing, and a viewer who has asked for less
   * movement should still be told that.
   */
  useFrame((_, delta) => {
    if (!geometry || reducedMotion) return;
    time.current.value += Math.min(0.1, delta);
    invalidate();
  });

  useEffect(() => {
    if (geometry && !reducedMotion) invalidate();
  }, [geometry, reducedMotion, invalidate]);

  useEffect(() => {
    fieldProbe.sky = sky ? { kind: sky.kind, night: sky.night, indoor: sky.indoor, drops: kind ? COUNT[kind] : 0 } : null;
    return () => {
      fieldProbe.sky = null;
    };
  }, [sky, kind]);

  if (!geometry || !material) return null;
  return <points geometry={geometry} material={material} position={[0, 0, 0]} frustumCulled={false} renderOrder={4} />;
});
