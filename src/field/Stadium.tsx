/**
 * The game page's arena around the field: tiered stands lined with seat lights
 * and four light towers with soft beams. Everything is static, so the view still
 * renders only on demand. It is decoration: it says nothing about the real venue,
 * its size or its crowd.
 */
import { memo, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fadeTexture, sparkTexture } from './textures';

const HALF_WIDTH = 160 / 6;

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

function place(geometry: THREE.BufferGeometry, tier: Tier): THREE.BufferGeometry {
  geometry.rotateY(tier.rotation);
  geometry.translate(tier.x, 0, tier.z);
  return geometry;
}

function build() {
  const steps: THREE.BufferGeometry[] = [];
  const lights: number[] = [];
  const colors: number[] = [];
  let seed = 20260914;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

  for (const tier of TIERS) {
    const rowDepth = tier.depth / tier.rows;
    for (let row = 0; row < tier.rows; row++) {
      const height = (row + 1) * tier.rise;
      // Local frame: the stand runs along x and climbs away from the field toward -z.
      const step = new THREE.BoxGeometry(tier.length, height, rowDepth);
      step.translate(0, height / 2 - 3.2, -(row + 0.5) * rowDepth);
      steps.push(place(step, tier));
      const count = Math.floor(tier.length / 1.1);
      for (let i = 0; i < count; i++) {
        // Sparse and irregular, like scattered phone and seat lights, not a printed grid.
        if (rand() < 0.62) continue;
        const local = new THREE.Vector3(-tier.length / 2 + rand() * tier.length, height - 3.0 + (rand() - 0.5) * 0.35, -row * rowDepth - 0.2 - rand() * rowDepth * 0.6);
        local.applyAxisAngle(new THREE.Vector3(0, 1, 0), tier.rotation);
        lights.push(local.x + tier.x, local.y, local.z + tier.z);
        const warm = rand() < 0.14;
        const level = 0.2 + rand() ** 2 * 0.8;
        colors.push((warm ? 1 : 0.62) * level, (warm ? 0.82 : 1) * level, (warm ? 0.55 : 0.84) * level);
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

  const lightGeometry = new THREE.BufferGeometry();
  lightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
  lightGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const lampGeometry = new THREE.BufferGeometry();
  lampGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3));

  return {
    stands: mergeGeometries(steps) ?? steps[0],
    lights: lightGeometry,
    poles: mergeGeometries(poles) ?? poles[0],
    panels: mergeGeometries(panels) ?? panels[0],
    lamps: lampGeometry,
    cones: mergeGeometries(cones) ?? cones[0],
  };
}

let cache: ReturnType<typeof build> | null = null;

export const Stadium = memo(function Stadium() {
  const geometry = (cache ??= build());
  const materials = useMemo(
    () => ({
      stands: new THREE.MeshStandardMaterial({ color: '#07130d', roughness: 0.85, metalness: 0.1 }),
      lights: new THREE.PointsMaterial({ map: sparkTexture(), size: 0.75, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      poles: new THREE.MeshStandardMaterial({ color: '#0c1c14', roughness: 0.6, metalness: 0.5 }),
      // Lamp heads glow instead of showing solid white faces, which from a phone's wider view read as a stray card beside the field.
      panels: new THREE.MeshBasicMaterial({ color: '#a8f0d0', transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      lamps: new THREE.PointsMaterial({ map: sparkTexture(), color: '#dffff2', size: 10, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      cones: new THREE.MeshBasicMaterial({ map: fadeTexture('down'), color: '#c9fbe6', transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
    }),
    [],
  );
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);

  return (
    <group>
      <mesh geometry={geometry.stands} material={materials.stands} />
      <points geometry={geometry.lights} material={materials.lights} />
      <mesh geometry={geometry.poles} material={materials.poles} />
      <mesh geometry={geometry.panels} material={materials.panels} renderOrder={2} />
      <mesh geometry={geometry.cones} material={materials.cones} renderOrder={2} />
      <points geometry={geometry.lamps} material={materials.lamps} renderOrder={3} />
    </group>
  );
});
