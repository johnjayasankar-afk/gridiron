/**
 * Geometry and materials shared by every field view. Built once; per-view
 * objects only reference them. One world unit is one yard.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { markingsFor } from '../../shared/fieldMarkings';
import type { LeagueId } from '../../shared/model';
import { shadowTexture, TURF_HALF } from './textures';

const FIELD_WIDTH = 160 / 3;

function flat(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** Goal posts for a league, merged into one draw call. Radii are thickened so the posts read at card size. */
function goalposts(league: LeagueId): THREE.BufferGeometry {
  const g = markingsFor(league).goalpost;
  const R = 0.2;
  const parts: THREE.BufferGeometry[] = [];
  const cylinder = (length: number, radius: number) => new THREE.CylinderGeometry(radius, radius, length, 12);
  for (const side of [-1, 1]) {
    const endLine = side * 60;
    const baseX = side * (60 + g.setback);
    const base = cylinder(g.crossbarHeight, R * 1.45);
    base.translate(baseX, g.crossbarHeight / 2, 0);
    const arm = cylinder(g.setback, R * 1.2);
    arm.rotateZ(Math.PI / 2);
    arm.translate((baseX + endLine) / 2, g.crossbarHeight, 0);
    const bar = cylinder(g.width, R);
    bar.rotateX(Math.PI / 2);
    bar.translate(endLine, g.crossbarHeight, 0);
    parts.push(base, arm, bar);
    const upright = g.uprightTop - g.crossbarHeight;
    for (const z of [-g.width / 2, g.width / 2]) {
      const u = cylinder(upright, R * 0.85);
      u.translate(endLine, g.crossbarHeight + upright / 2, z);
      parts.push(u);
    }
  }
  return mergeGeometries(parts) ?? parts[0];
}

/** Pylons at the league's positions, merged into one draw call and enlarged for legibility. */
function pylons(league: LeagueId): THREE.BufferGeometry {
  const parts = markingsFor(league).pylons.map(({ x, z }) => {
    const box = new THREE.BoxGeometry(0.5, 1.1, 0.5);
    box.translate(x, 0.55, z);
    return box;
  });
  return mergeGeometries(parts) ?? parts[0];
}

/*
 * The ball.
 *
 * A football is not an ellipsoid. It is a circular arc revolved about its long
 * axis, which is what gives it points at the ends and straighter sides than a
 * spheroid has, and at the size the ball is drawn the silhouette is most of
 * what there is to see. It was a scaled sphere before and read as a pill.
 *
 * Like every other mark on a schematic field it is drawn well over life size,
 * so that it is still a football on a card.
 */
const BALL_LENGTH = 1.05;
const BALL_RADIUS = 0.62;
/** Radius of the arc whose ends meet the axis exactly at the two points of the ball. */
const BALL_ARC = (BALL_LENGTH * BALL_LENGTH + BALL_RADIUS * BALL_RADIUS) / (2 * BALL_RADIUS);
const BALL_OFFSET = BALL_ARC - BALL_RADIUS;

/** How fat the ball is at a distance along its long axis. Zero at each point. */
function ballRadiusAt(along: number): number {
  return Math.max(0, Math.sqrt(Math.max(0, BALL_ARC * BALL_ARC - along * along)) - BALL_OFFSET);
}

/** A lathe of the ball's own profile over a stretch of its length. */
function ballSurface(from: number, to: number, steps: number, swell = 0): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= steps; i++) {
    const along = from + ((to - from) * i) / steps;
    profile.push(new THREE.Vector2(ballRadiusAt(along) + swell, along));
  }
  const lathe = new THREE.LatheGeometry(profile, 18);
  // A lathe turns about y; the ball lies down the field, so its long axis is x.
  lathe.rotateZ(-Math.PI / 2);
  return lathe;
}

/** The lace panel: a band along the top with its cross stitches, in one draw call. */
function lacesGeometry(): THREE.BufferGeometry {
  const y = ballRadiusAt(0) - 0.035;
  const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(0.8, 0.06, 0.11).translate(0, y, 0)];
  for (let i = 0; i < 7; i++) parts.push(new THREE.BoxGeometry(0.062, 0.062, 0.3).translate(-0.3 + i * 0.1, y + 0.012, 0));
  return mergeGeometries(parts) ?? parts[0];
}

/** The two white stripes an NCAA ball carries, sat just proud of the leather. */
function ballStripesGeometry(): THREE.BufferGeometry {
  const parts = [-0.52, 0.52].map((centre) => ballSurface(centre - 0.05, centre + 0.05, 2, 0.012));
  return mergeGeometries(parts) ?? parts[0];
}

function arrowGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(1.7, 0);
  s.lineTo(-0.9, 1.35);
  s.lineTo(-0.35, 0);
  s.lineTo(-0.9, -1.35);
  s.closePath();
  return flat(new THREE.ShapeGeometry(s));
}

function flagGeometry(): THREE.BufferGeometry {
  const cloth = new THREE.BoxGeometry(0.9, 0.18, 0.9);
  const knot = new THREE.SphereGeometry(0.28, 10, 8);
  knot.translate(0, 0.22, 0);
  return mergeGeometries([cloth.toNonIndexed(), knot.toNonIndexed()]) ?? cloth;
}

/** A neon rim along the top edge of the base slab, merged into one draw call. */
function rimGeometry(): THREE.BufferGeometry {
  const w = TURF_HALF.x * 2 + 5.4;
  const d = TURF_HALF.z * 2 + 5.4;
  const t = 0.34;
  const parts = [
    new THREE.BoxGeometry(w + t, 0.12, t).translate(0, 0.02, -d / 2),
    new THREE.BoxGeometry(w + t, 0.12, t).translate(0, 0.02, d / 2),
    new THREE.BoxGeometry(t, 0.12, d).translate(-w / 2, 0.02, 0),
    new THREE.BoxGeometry(t, 0.12, d).translate(w / 2, 0.02, 0),
  ];
  return mergeGeometries(parts) ?? parts[0];
}

/** A vertical sheet of light across the field's width, one unit tall with its base at y = 0 (scale y for height). */
function sheetGeometry(): THREE.BufferGeometry {
  const plane = new THREE.PlaneGeometry(FIELD_WIDTH, 1);
  plane.rotateY(Math.PI / 2);
  plane.translate(0, 0.5, 0);
  return plane;
}

/**
 * The gate a kick goes through, at the width of a league's uprights. An open box
 * rather than a single sheet: a sheet facing down the field is edge on from the
 * broadcast camera, which watches from the side, and all but disappeared at the
 * one moment it exists for. One unit tall with its base at y = 0, so the caller
 * sits it on the crossbar and scales it to the uprights.
 */
function uprightGate(league: LeagueId): THREE.BufferGeometry {
  const w = markingsFor(league).goalpost.width;
  const d = 1.4;
  const across = (x: number) => new THREE.PlaneGeometry(w, 1).rotateY(Math.PI / 2).translate(x, 0.5, 0);
  const along = (z: number) => new THREE.PlaneGeometry(d, 1).translate(0, 0.5, z);
  const parts = [across(-d / 2), across(d / 2), along(-w / 2), along(w / 2)];
  return mergeGeometries(parts) ?? parts[0];
}

/** An open box of light over an end zone, one unit tall with its base at y = 0. */
function columnGeometry(): THREE.BufferGeometry {
  const hw = FIELD_WIDTH / 2;
  const long = (x: number) => new THREE.PlaneGeometry(FIELD_WIDTH, 1).rotateY(Math.PI / 2).translate(x, 0.5, 0);
  const short = (z: number) => new THREE.PlaneGeometry(10, 1).translate(0, 0.5, z);
  const parts = [long(-5), long(5), short(-hw), short(hw)];
  return mergeGeometries(parts) ?? parts[0];
}

/** The grid floor under the field: drawn in the shader, faded toward the edges. */
function gridMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color('#6ee7b7') }, uOpacity: { value: 0.34 }, uCells: { value: 26 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uCells;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * vec2(uCells * 1.37, uCells);
        vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        float d = length((vUv - 0.5) * vec2(1.0, 1.2)) * 2.0;
        float fade = smoothstep(1.0, 0.18, d);
        gl_FragColor = vec4(uColor, line * uOpacity * fade);
      }
    `,
  });
}

function build() {
  const beam = new THREE.CylinderGeometry(0.16, 0.16, 1, 10, 1, true);
  beam.translate(0, 0.5, 0);
  return {
    rim: rimGeometry(),
    sheet: sheetGeometry(),
    gate: { nfl: uprightGate('nfl'), cfb: uprightGate('cfb') } as Record<LeagueId, THREE.BufferGeometry>,
    column: columnGeometry(),
    beam,
    floor: flat(new THREE.PlaneGeometry(260, 190)),
    slab: new RoundedBoxGeometry(TURF_HALF.x * 2 + 6, 3.2, TURF_HALF.z * 2 + 6, 4, 1.6),
    shadow: flat(new THREE.PlaneGeometry(TURF_HALF.x * 2 + 44, TURF_HALF.z * 2 + 40)),
    turf: flat(new THREE.PlaneGeometry(TURF_HALF.x * 2, TURF_HALF.z * 2)),
    endZone: flat(new THREE.PlaneGeometry(10, FIELD_WIDTH)),
    /** The mark at the fifty: square, and about a third of the field's width across. */
    midfield: flat(new THREE.PlaneGeometry(17, 17)),
    strip: flat(new THREE.PlaneGeometry(1, FIELD_WIDTH)),
    zone: flat(new THREE.PlaneGeometry(20, FIELD_WIDTH)),
    halo: flat(new THREE.PlaneGeometry(9, 9)),
    ring: flat(new THREE.RingGeometry(0.82, 1, 64)),
    ball: ballSurface(-BALL_LENGTH, BALL_LENGTH, 16),
    lace: lacesGeometry(),
    ballStripes: ballStripesGeometry(),
    arrow: arrowGeometry(),
    flag: flagGeometry(),
    posts: { nfl: goalposts('nfl'), cfb: goalposts('cfb') } as Record<LeagueId, THREE.BufferGeometry>,
    pylons: { nfl: pylons('nfl'), cfb: pylons('cfb') } as Record<LeagueId, THREE.BufferGeometry>,
  };
}

function materials() {
  const overlay = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 };
  return {
    slab: new THREE.MeshStandardMaterial({ color: '#10261b', roughness: 0.82, metalness: 0.04 }),
    shadow: new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }),
    posts: {
      nfl: new THREE.MeshStandardMaterial({ color: '#d8b24a', roughness: 0.42, metalness: 0.22 }),
      cfb: new THREE.MeshStandardMaterial({ color: '#eee6c6', roughness: 0.5, metalness: 0.08 }),
    } as Record<LeagueId, THREE.MeshStandardMaterial>,
    pylon: new THREE.MeshStandardMaterial({ color: '#f07a24', roughness: 0.6 }),
    los: new THREE.MeshBasicMaterial({ color: '#8abef0', opacity: 0.95, ...overlay }),
    firstDown: new THREE.MeshBasicMaterial({ color: '#f4aa5c', opacity: 0.96, ...overlay }),
    goalToGo: new THREE.MeshBasicMaterial({ color: '#f4aa5c', opacity: 0.55, ...overlay }),
    redZone: new THREE.MeshBasicMaterial({ color: '#f4aa5c', opacity: 0.13, ...overlay }),
    arrow: new THREE.MeshBasicMaterial({ color: '#a7f3d0', opacity: 0.95, ...overlay }),
    trail: new THREE.MeshBasicMaterial({ color: '#a7f3d0', opacity: 0.5, transparent: true, depthWrite: false }),
    trailLoss: new THREE.MeshBasicMaterial({ color: '#f4aa5c', opacity: 0.5, transparent: true, depthWrite: false }),
    lace: new THREE.MeshStandardMaterial({ color: '#f5f1e8', roughness: 0.6 }),
    flag: new THREE.MeshStandardMaterial({ color: '#f5d23c', roughness: 0.7 }),
    holo: {
      slab: new THREE.MeshStandardMaterial({ color: '#04110b', roughness: 0.3, metalness: 0.62 }),
      rim: new THREE.MeshBasicMaterial({ color: '#9ff7cf', toneMapped: false }),
      floor: gridMaterial(),
      posts: {
        nfl: new THREE.MeshBasicMaterial({ color: '#ffd978', toneMapped: false }),
        cfb: new THREE.MeshBasicMaterial({ color: '#eef6ff', toneMapped: false }),
      } as Record<LeagueId, THREE.MeshBasicMaterial>,
      pylon: new THREE.MeshBasicMaterial({ color: '#ff9a4a', toneMapped: false }),
      redZone: new THREE.MeshBasicMaterial({ color: '#ff9a5a', opacity: 0.17, blending: THREE.AdditiveBlending, ...overlay }),
    },
  };
}

let geometryCache: ReturnType<typeof build> | null = null;
let materialCache: ReturnType<typeof materials> | null = null;

export const fieldGeometry = () => (geometryCache ??= build());
export const fieldMaterials = () => (materialCache ??= materials());
