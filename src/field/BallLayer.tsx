/**
 * The live layer on the field: reported ball spot with its halo, line of
 * scrimmage, first-down or goal-to-go marker, attack direction, red-zone tint,
 * the latest play's movement, and the brief emphasis for scores, turnovers,
 * penalties and reviews. The ball sits on the centre axis unless the data
 * carries a lateral position (see shared/field.ts); no live provider reports one.
 *
 * The holographic style adds light that follows the same reported events: sheets
 * rising from the line of scrimmage and the line to gain, a tracking beam over
 * the ball, glowing trails, and for a touchdown a column of light and sparks in
 * the scoring team's colour.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { attackDirection, firstDownTarget, lateralZ, RED_ZONE_START, schematicYardFromProgress, worldX } from '../../shared/field';
import { markingsFor } from '../../shared/fieldMarkings';
import type { LeagueId, Situation } from '../../shared/model';
import type { PlayAnimation } from '../../shared/playAnimation';
import { accentFor } from './color';
import { fieldGeometry, fieldMaterials } from './geometry';
import type { FieldStyle } from './style';
import { fadeTexture, haloTexture, sparkTexture } from './textures';

const BALL_Y = 1.1;
const BALL = new THREE.Color('#7b4a2a');
const AMBER = new THREE.Color('#f4aa5c');
const MINT = new THREE.Color('#a7f3d0');
const SKY = new THREE.Color('#8abef0');
const SPARKS = 96;
const SPARK_MS = 1500;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

const isFieldGoal = (p: PlayAnimation) => p.kind === 'field_goal_good' || p.kind === 'field_goal_missed';
const arcHeight = (distance: number, kick: boolean) => (kick ? Math.min(18, 6 + distance * 0.2) : Math.min(9, 2 + distance * 0.12));

export interface BallLayerProps {
  league: LeagueId;
  situation: Situation | null;
  animation: PlayAnimation | null;
  reducedMotion: boolean;
  compact: boolean;
  /** No ball is drawn (scheduled, final, or a paused state without a spot). */
  hidden: boolean;
  /** Team colours, for the end zone that lights up on a touchdown. */
  homeColor: string | null;
  awayColor: string | null;
  /** Holographic light effects, or the plain classic markers. */
  style: FieldStyle;
  /** The game page's perspective camera: spark sizes are in world units there, and in pixels on cards. */
  perspective: boolean;
}

interface Burst {
  start: number;
  zone: 1 | -1;
  color: THREE.Color;
  seeded: boolean;
  last: number;
}

export const BallLayer = memo(function BallLayer({ league, situation, animation, reducedMotion, compact, hidden, homeColor, awayColor, style, perspective }: BallLayerProps) {
  const invalidate = useThree((s) => s.invalidate);
  const G = fieldGeometry();
  const M = fieldMaterials();
  const holo = style === 'holo';

  const spot = hidden ? null : (situation?.spot ?? null);
  const schematic = spot?.schematicYard ?? null;
  const offense = situation?.possession ?? spot?.offense ?? null;
  const dir = offense ? attackDirection(offense) : null;
  const ballX = schematic === null ? null : worldX(schematic);
  const restZ = lateralZ(spot?.lateral);
  const target = ballX !== null && offense && spot?.progress != null ? firstDownTarget(spot.progress, situation?.distance ?? null, situation?.goalToGo === true) : null;
  const firstX = target?.kind === 'line' && offense ? worldX(schematicYardFromProgress(target.progress, offense)) : null;
  const goalX = target?.kind === 'goal' && dir !== null ? dir * 50 : null;
  const redZone = ballX !== null && dir !== null && spot?.progress != null && spot.progress >= RED_ZONE_START;
  const crossbar = markingsFor(league).goalpost.crossbarHeight;
  const sheetHeight = perspective ? 4.4 : compact ? 2 : 3;

  const mats = useMemo(() => {
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false } as const;
    const trail = (color: THREE.Color) => new THREE.MeshBasicMaterial({ map: fadeTexture('along').clone(), color, opacity: 0.95, ...additive });
    return {
      ball: new THREE.MeshStandardMaterial({ color: BALL.clone(), roughness: 0.5, metalness: 0.05, transparent: true }),
      halo: new THREE.MeshBasicMaterial({ map: haloTexture(), transparent: true, depthWrite: false, opacity: 0.85, toneMapped: false }),
      ring: new THREE.MeshBasicMaterial({ color: MINT.clone(), transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide, toneMapped: false }),
      glow: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, opacity: 0, toneMapped: false }),
      chain: new THREE.MeshBasicMaterial({ color: AMBER.clone(), transparent: true, depthWrite: false, opacity: 0, toneMapped: false }),
      sheetLos: new THREE.MeshBasicMaterial({ map: fadeTexture('up'), color: SKY.clone(), opacity: 0.42, side: THREE.DoubleSide, ...additive }),
      sheetFirst: new THREE.MeshBasicMaterial({ map: fadeTexture('up'), color: AMBER.clone(), opacity: 0.36, side: THREE.DoubleSide, ...additive }),
      beam: new THREE.MeshBasicMaterial({ map: fadeTexture('up'), color: MINT.clone(), opacity: 0.65, ...additive }),
      column: new THREE.MeshBasicMaterial({ map: fadeTexture('up'), color: MINT.clone(), opacity: 0, side: THREE.DoubleSide, ...additive }),
      spark: new THREE.PointsMaterial({ map: sparkTexture(), color: MINT.clone(), size: 1, sizeAttenuation: true, opacity: 0, ...additive }),
      trailGain: trail(MINT.clone()),
      trailLoss: trail(AMBER.clone()),
    };
  }, []);
  useEffect(
    () => () => {
      mats.trailGain.map?.dispose();
      mats.trailLoss.map?.dispose();
      Object.values(mats).forEach((m) => m.dispose());
    },
    [mats],
  );
  useEffect(() => {
    mats.spark.size = perspective ? 1.3 : compact ? 5 : 7;
    mats.spark.sizeAttenuation = perspective;
    mats.spark.needsUpdate = true;
  }, [mats, perspective, compact]);
  const teamGlow = useMemo(() => ({ home: new THREE.Color(accentFor(homeColor, true)), away: new THREE.Color(accentFor(awayColor, true)) }), [homeColor, awayColor]);

  const sparks = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(SPARKS * 3);
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    return { geometry, positions, velocities: new Float32Array(SPARKS * 3), attribute };
  }, []);
  useEffect(() => () => sparks.geometry.dispose(), [sparks]);

  const ballRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const losRef = useRef<THREE.Mesh>(null);
  const firstRef = useRef<THREE.Mesh>(null);
  const arrowRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const flagRef = useRef<THREE.Mesh>(null);
  const trailRef = useRef<THREE.Mesh>(null);
  const chainRef = useRef<THREE.Mesh>(null);
  const sheetLosRef = useRef<THREE.Mesh>(null);
  const sheetFirstRef = useRef<THREE.Mesh>(null);
  const beamRef = useRef<THREE.Mesh>(null);
  const columnRef = useRef<THREE.Mesh>(null);
  const pointsRef = useRef<THREE.Points>(null);

  const run = useRef<{ plan: PlayAnimation; start: number } | null>(null);
  const burst = useRef<Burst | null>(null);
  const shown = useRef({ los: ballX, first: firstX, heading: dir === -1 ? Math.PI : 0, z: restZ, at: 0 });

  useEffect(() => {
    if (!animation || run.current?.plan.key === animation.key) return;
    const start = performance.now();
    run.current = { plan: animation, start };
    if (holo && animation.effect === 'touchdown') {
      const to = animation.toYard !== null ? worldX(animation.toYard) : null;
      const moveDir = animation.offenseBefore ? attackDirection(animation.offenseBefore) : 1;
      const zone = (to !== null && Math.abs(to) >= 40 ? Math.sign(to) : moveDir) as 1 | -1;
      burst.current = { start: start + animation.durationMs, zone, color: zone === 1 ? teamGlow.away : teamGlow.home, seeded: false, last: 0 };
    }
    invalidate();
  }, [animation, invalidate, holo, teamGlow]);

  useEffect(() => {
    invalidate();
  }, [ballX, restZ, firstX, goalX, dir, redZone, hidden, holo, invalidate]);

  // The latest play's movement stays drawn after it settles, until the next play. It follows the lateral positions when known.
  const trail = useMemo(() => {
    if (!animation || animation.corrected || animation.fromYard === null || animation.toYard === null) return null;
    const moveDir = animation.offenseBefore ? attackDirection(animation.offenseBefore) : 1;
    const from = worldX(animation.fromYard);
    const to = isFieldGoal(animation) ? moveDir * 60 : worldX(animation.toYard);
    const fromZ = lateralZ(animation.fromLateral);
    const toZ = isFieldGoal(animation) ? 0 : animation.toLateral != null ? lateralZ(animation.toLateral) : fromZ;
    const distance = Math.hypot(to - from, toZ - fromZ);
    if (distance < 0.75 || animation.path === 'incomplete') return null;
    if (animation.path === 'arc' || animation.path === 'kick') {
      const h = arcHeight(Math.abs(to - from), animation.path === 'kick');
      const end = isFieldGoal(animation) ? crossbar + 2 : 0.35;
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(from, 0.35, fromZ), new THREE.Vector3((from + to) / 2, h * 2, (fromZ + toZ) / 2), new THREE.Vector3(to, end, toZ));
      return { geometry: new THREE.TubeGeometry(curve, 40, compact ? 0.24 : 0.16, 6, false) as THREE.BufferGeometry, loss: false };
    }
    // A flat ribbon from the start to the end of the play; its texture brightens toward the ball whichever way it ran.
    const geometry = new THREE.PlaneGeometry(distance, compact ? 1 : 0.7);
    geometry.rotateX(-Math.PI / 2);
    geometry.rotateY(Math.atan2(-(toZ - fromZ), to - from));
    geometry.translate((from + to) / 2, 0.07, (fromZ + toZ) / 2);
    return { geometry: geometry as THREE.BufferGeometry, loss: (to - from) * moveDir < 0 };
  }, [animation, compact, crossbar]);
  useEffect(() => () => trail?.geometry.dispose(), [trail]);

  useFrame(() => {
    const ball = ballRef.current;
    const halo = haloRef.current;
    const los = losRef.current;
    const first = firstRef.current;
    const arrow = arrowRef.current;
    const ring = ringRef.current;
    const glow = glowRef.current;
    const flag = flagRef.current;
    const chain = chainRef.current;
    const sheetLos = sheetLosRef.current;
    const sheetFirst = sheetFirstRef.current;
    const beam = beamRef.current;
    const column = columnRef.current;
    const points = pointsRef.current;
    if (!ball || !los || !first || !arrow || !ring || !glow || !flag) return;
    const now = performance.now();
    const dt = shown.current.at ? Math.min(100, now - shown.current.at) : 16;
    shown.current.at = now;
    let active = false;

    ring.visible = false;
    glow.visible = false;
    flag.visible = false;
    if (chain) chain.visible = false;
    if (column) column.visible = false;
    mats.ball.color.copy(BALL);
    mats.sheetFirst.opacity = 0.36;

    // Sparks run on their own clock so they finish even if the ball is hidden.
    const b = burst.current;
    if (b && points) {
      const age = now - b.start;
      if (age < 0) active = true;
      else if (age < SPARK_MS) {
        const { positions: pos, velocities: vel } = sparks;
        if (!b.seeded) {
          let seed = Math.round(b.start) % 9973;
          const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
          for (let i = 0; i < SPARKS; i++) {
            pos[i * 3] = b.zone * (50 + rand() * 10);
            pos[i * 3 + 1] = 0.4;
            pos[i * 3 + 2] = (rand() - 0.5) * 50;
            vel[i * 3] = (rand() - 0.5) * 10 - b.zone * rand() * 6;
            vel[i * 3 + 1] = 10 + rand() * 18;
            vel[i * 3 + 2] = (rand() - 0.5) * 12;
          }
          b.seeded = true;
          b.last = now;
          mats.spark.color.copy(b.color);
        }
        const step = Math.min(0.05, (now - b.last) / 1000);
        b.last = now;
        for (let i = 0; i < SPARKS; i++) {
          vel[i * 3 + 1] -= 24 * step;
          pos[i * 3] += vel[i * 3] * step;
          pos[i * 3 + 1] = Math.max(0.2, pos[i * 3 + 1] + vel[i * 3 + 1] * step);
          pos[i * 3 + 2] += vel[i * 3 + 2] * step;
        }
        sparks.attribute.needsUpdate = true;
        points.visible = true;
        mats.spark.opacity = 0.95 * (1 - age / SPARK_MS) ** 1.4;
        active = true;
      } else {
        burst.current = null;
        points.visible = false;
      }
    }

    if (ballX === null) {
      ball.visible = los.visible = first.visible = arrow.visible = false;
      if (halo) halo.visible = false;
      if (trailRef.current) trailRef.current.visible = false;
      if (sheetLos) sheetLos.visible = false;
      if (sheetFirst) sheetFirst.visible = false;
      if (beam) beam.visible = false;
      run.current = null;
      shown.current.los = null;
      shown.current.first = null;
      if (active) invalidate();
      return;
    }

    const s = shown.current;
    const ease = reducedMotion ? 1 : 1 - Math.exp(-dt / 65);
    // A ball that has just appeared starts at its lateral position; afterwards it glides across.
    if (s.los === null) s.z = restZ;
    s.z = s.z + (restZ - s.z) * ease;
    if (Math.abs(restZ - s.z) > 0.02) active = true;
    else s.z = restZ;

    let bx = ballX;
    let by = BALL_Y;
    let bz = s.z;
    let opacity = 1;
    let losTarget = ballX;
    let heading = dir === -1 ? Math.PI : 0;
    let trailVisible = true;

    const r = run.current;
    if (r) {
      const p = r.plan;
      const elapsed = now - r.start;
      const t = clamp01(elapsed / p.durationMs);
      const moveDir = p.offenseBefore ? attackDirection(p.offenseBefore) : (dir ?? 1);
      const from = p.fromYard !== null ? worldX(p.fromYard) : ballX;
      const to = p.toYard !== null ? worldX(p.toYard) : ballX;
      const fromZ = p.fromLateral != null ? lateralZ(p.fromLateral) : s.z;
      const toZ = p.toLateral != null ? lateralZ(p.toLateral) : restZ;
      const hold = p.effect === 'touchdown' || p.effect === 'safety' ? p.effectMs : 0;
      if (elapsed < p.durationMs) {
        losTarget = from;
        heading = moveDir === -1 ? Math.PI : 0;
        trailVisible = false;
        switch (p.path) {
          case 'sweep':
            bx = lerp(from, to, easeInOut(t));
            bz = lerp(fromZ, toZ, easeInOut(t));
            break;
          case 'arc':
            bx = lerp(from, to, easeSine(t));
            bz = lerp(fromZ, toZ, easeSine(t));
            by = BALL_Y + arcHeight(Math.abs(to - from), false) * Math.sin(Math.PI * t);
            break;
          case 'kick': {
            const dest = isFieldGoal(p) ? moveDir * 61 : to;
            const end = isFieldGoal(p) ? crossbar + 2 : BALL_Y;
            bx = lerp(from, dest, t);
            bz = lerp(fromZ, isFieldGoal(p) ? 0 : toZ, t);
            by = lerp(BALL_Y, end, t) + arcHeight(Math.abs(dest - from), true) * Math.sin(Math.PI * t);
            break;
          }
          case 'incomplete': {
            const out = from + moveDir * 10;
            if (t < 0.65) {
              const u = t / 0.65;
              bx = lerp(from, out, easeOut(u));
              bz = fromZ;
              by = BALL_Y + 3 * Math.sin(Math.PI * u);
              opacity = 1 - u * 0.7;
            } else {
              bx = to;
              bz = toZ;
              opacity = (t - 0.65) / 0.35;
            }
            break;
          }
          case 'sack':
            bx = lerp(from, to, easeOut(t));
            by = BALL_Y - 0.35 * Math.sin(Math.PI * t);
            bz = lerp(fromZ, toZ, easeOut(t)) + Math.sin(t * Math.PI * 6) * 0.35 * (1 - t);
            break;
          default:
            opacity = t;
        }
      } else if (elapsed < p.durationMs + hold) {
        bx = to;
        bz = toZ;
        losTarget = from;
        heading = moveDir === -1 ? Math.PI : 0;
      } else if (elapsed < p.durationMs + hold + 220 && (Math.abs(to - ballX) > 0.5 || Math.abs(toZ - s.z) > 0.5 || isFieldGoal(p))) {
        const u = clamp01((elapsed - p.durationMs - hold) / 220);
        if (isFieldGoal(p)) opacity = u;
        else {
          bx = lerp(to, ballX, easeOut(u));
          bz = lerp(toZ, s.z, easeOut(u));
        }
      }

      const te = p.effectMs > 0 ? (elapsed - p.durationMs) / p.effectMs : -1;
      if (te >= 0 && te <= 1) {
        if (p.effect === 'touchdown' || p.effect === 'safety' || p.effect === 'field_goal') {
          ring.visible = !compact || p.effect === 'touchdown';
          const at = p.effect === 'field_goal' ? moveDir * 57 : to;
          ring.position.set(at, 0.12, p.effect === 'field_goal' ? 0 : toZ);
          ring.scale.setScalar(1 + te * (p.effect === 'touchdown' ? 15 : 9));
          mats.ring.color.copy(p.effect === 'safety' ? AMBER : MINT);
          mats.ring.opacity = 0.9 * (1 - te);
        }
        if (p.effect === 'touchdown') {
          // The end zone the ball reached, lit in the colour of the team attacking it (away attacks the right).
          const zone = Math.abs(to) >= 40 ? (Math.sign(to) as 1 | -1) : moveDir;
          const color = zone === 1 ? teamGlow.away : teamGlow.home;
          glow.visible = true;
          glow.position.set(zone * 55, 0.06, 0);
          mats.glow.color.copy(color);
          mats.glow.opacity = 0.42 * Math.sin(Math.PI * te);
          if (holo && column) {
            column.visible = true;
            column.position.set(zone * 55, 0.05, 0);
            column.scale.set(1, (perspective ? 6 : 3) + (perspective ? 18 : 9) * easeOut(te), 1);
            mats.column.color.copy(color);
            mats.column.opacity = 0.6 * Math.sin(Math.PI * te);
          }
        }
        if (p.effect === 'turnover') mats.ball.color.copy(BALL).lerp(AMBER, Math.sin(Math.PI * te));
        if (p.effect === 'review') {
          const pulse = (te * 2) % 1;
          ring.visible = true;
          ring.position.set(bx, 0.12, bz);
          ring.scale.setScalar(2 + pulse * 5);
          mats.ring.color.copy(SKY);
          mats.ring.opacity = 0.75 * (1 - pulse);
        }
        if (p.effect === 'first_down' && firstX !== null) {
          // A new set of downs: the line to gain sweeps out once from its new spot.
          if (chain) {
            chain.visible = true;
            chain.position.set(firstX, 0.055, 0);
            chain.scale.set((compact ? 0.7 : 0.45) + easeOut(te) * (compact ? 4 : 3), 1, 1);
            mats.chain.opacity = 0.8 * (1 - te) * (1 - te);
          }
          mats.sheetFirst.opacity = 0.36 + 0.6 * (1 - te);
        }
      }
      if (p.effect === 'penalty' && elapsed < p.durationMs + p.effectMs + 900) {
        flag.visible = true;
        const drop = clamp01(elapsed / 280);
        flag.position.set(from + moveDir * 2, lerp(7, 0.3, easeOut(drop)), fromZ + 5);
      }
      if (elapsed < p.durationMs + Math.max(p.effectMs, hold) + 260 || (p.effect === 'penalty' && elapsed < p.durationMs + p.effectMs + 900)) active = true;
      else run.current = null;
    }

    ball.visible = true;
    ball.position.set(bx, by, bz);
    mats.ball.opacity = opacity;
    if (halo) {
      halo.visible = opacity > 0.05;
      halo.position.set(bx, 0.08, bz);
      halo.scale.setScalar(Math.max(0.55, 1 - (by - BALL_Y) * 0.05));
    }
    if (beam) {
      beam.visible = holo && opacity > 0.3;
      beam.position.set(bx, 0.1, bz);
      beam.scale.set(1, perspective ? 11 : 6, 1);
    }

    s.los = s.los === null ? losTarget : s.los + (losTarget - s.los) * ease;
    if (Math.abs(losTarget - s.los) > 0.02) active = true;
    else s.los = losTarget;
    los.visible = true;
    los.position.set(s.los, 0.05, 0);
    if (sheetLos) {
      sheetLos.visible = holo;
      sheetLos.position.set(s.los, 0, 0);
      sheetLos.scale.set(1, sheetHeight, 1);
    }

    if (firstX === null) {
      first.visible = false;
      if (sheetFirst) sheetFirst.visible = false;
      s.first = null;
    } else {
      s.first = s.first === null ? firstX : s.first + (firstX - s.first) * ease;
      if (Math.abs(firstX - s.first) > 0.02) active = true;
      else s.first = firstX;
      first.visible = !r || now - r.start > r.plan.durationMs;
      first.position.set(s.first, 0.05, 0);
      if (sheetFirst) {
        sheetFirst.visible = holo && first.visible;
        sheetFirst.position.set(s.first, 0, 0);
        sheetFirst.scale.set(1, sheetHeight * 0.9, 1);
      }
    }

    if (dir === null) arrow.visible = false;
    else {
      s.heading = s.heading + (heading - s.heading) * (reducedMotion ? 1 : 1 - Math.exp(-dt / 90));
      if (Math.abs(heading - s.heading) > 0.01) active = true;
      else s.heading = heading;
      arrow.visible = opacity > 0.3;
      arrow.rotation.y = s.heading;
      arrow.position.set(bx + Math.cos(s.heading) * 4.4, 0.09, bz);
    }

    if (trailRef.current) trailRef.current.visible = trailVisible;
    if (active) invalidate();
  });

  const trailMaterial = trail ? (holo ? (trail.loss ? mats.trailLoss : mats.trailGain) : trail.loss ? M.trailLoss : M.trail) : null;

  return (
    <group>
      {redZone && dir !== null && <mesh geometry={G.zone} material={holo ? M.holo.redZone : M.redZone} position={[dir * 40, 0.035, 0]} />}
      {goalX !== null && <mesh geometry={G.strip} material={M.goalToGo} position={[goalX, 0.045, 0]} scale={[0.9, 1, 1]} />}
      <mesh ref={losRef} geometry={G.strip} material={M.los} scale={[compact ? 0.7 : 0.45, 1, 1]} visible={false} />
      <mesh ref={firstRef} geometry={G.strip} material={M.firstDown} scale={[compact ? 0.7 : 0.45, 1, 1]} visible={false} />
      <mesh ref={chainRef} geometry={G.strip} material={mats.chain} visible={false} />
      {holo && <mesh ref={sheetLosRef} geometry={G.sheet} material={mats.sheetLos} visible={false} renderOrder={3} />}
      {holo && <mesh ref={sheetFirstRef} geometry={G.sheet} material={mats.sheetFirst} visible={false} renderOrder={3} />}
      {trail && trailMaterial && <mesh ref={trailRef} geometry={trail.geometry} material={trailMaterial} renderOrder={2} />}
      {!compact && <mesh ref={haloRef} geometry={G.halo} material={mats.halo} visible={false} />}
      <group ref={arrowRef} visible={false}>
        <mesh geometry={G.arrow} material={M.arrow} scale={compact ? 1.5 : 1} />
      </group>
      <group ref={ballRef} visible={false} scale={compact ? 1.6 : 1.15}>
        <mesh geometry={G.ball} material={mats.ball} />
        {!compact && <mesh geometry={G.lace} material={M.lace} position={[0, 0.6, 0]} />}
      </group>
      {holo && !compact && <mesh ref={beamRef} geometry={G.beam} material={mats.beam} visible={false} renderOrder={3} />}
      <mesh ref={ringRef} geometry={G.ring} material={mats.ring} visible={false} />
      <mesh ref={glowRef} geometry={G.endZone} material={mats.glow} visible={false} />
      {holo && <mesh ref={columnRef} geometry={G.column} material={mats.column} visible={false} renderOrder={4} />}
      {holo && <points ref={pointsRef} geometry={sparks.geometry} material={mats.spark} visible={false} frustumCulled={false} renderOrder={5} />}
      <mesh ref={flagRef} geometry={G.flag} material={M.flag} visible={false} />
    </group>
  );
});
