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
import { attackDirection, firstDownTarget, lateralZ, RED_ZONE_START, schematicYardFromProgress, scoringZone, worldX } from '../../shared/field';
import { markingsFor } from '../../shared/fieldMarkings';
import type { LeagueId, Situation, Team } from '../../shared/model';
import { PLACE_KICKS, type PlayAnimation } from '../../shared/playAnimation';
import { accentFor } from './color';
import { fieldGeometry, fieldMaterials } from './geometry';
import type { FieldStyle } from './style';
import type { BallTrack } from './frameBus';
import { fieldProbe, installFieldProbe } from './probe';
import { acquireBallSkin, ballSkinKey, fadeTexture, haloTexture, releaseBallSkin, retainBallSkin, shadowTexture, sparkTexture } from './textures';
import { towerStrength, type Sky } from '../../shared/sky';

const BALL_Y = 1.1;
const BALL = new THREE.Color('#7b4a2a');
const AMBER = new THREE.Color('#f4aa5c');
const MINT = new THREE.Color('#a7f3d0');
const WHITE = new THREE.Color('#ffffff');
const SKY = new THREE.Color('#8abef0');
const SPARKS = 96;
const SPARK_MS = 1500;
/**
 * How fast a thrown or kicked ball turns about its long axis, in radians per
 * second. A real spiral is nearer sixty, which at sixty frames a second is a
 * whole turn per frame: it would strobe, and read as a ball standing still or
 * turning backwards. This is the speed that reads AS a spiral at the size the
 * ball is drawn, which is the honest thing for a schematic to do.
 */
const SPIN_RATE = 11;
/** End over end, for a ball struck off the ground. Faster than a spiral reads, because it is a slower turn to watch. */
const TUMBLE_RATE = 16;
/** How long the mark at the spot a play ended lasts. Kept inside the window the run is held open for. */
const SPOT_MS = 260;
const TAU = Math.PI * 2;
/** Steepest the nose is allowed to point, so a short pass never launches vertically. */
const MAX_PITCH = 1;
/**
 * How far past the ball's furthest point an interception is drawn as changing
 * hands. The catch was beyond both the throw and the end of the return, because
 * the ball was thrown forward and then carried back; exactly how far beyond is
 * not reported, so the turn is put just past the further of the two. A fixed
 * distance downfield could land short of where the return ended and draw both
 * legs running the same way.
 */
const PICK_OUT = 5;

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
  /** Both teams: their colours light the end zone that scores, and the one with the ball marks the ball itself. */
  home: Team;
  away: Team;
  /** Holographic light effects, or the plain classic markers. */
  style: FieldStyle;
  /** The game page's perspective camera: spark sizes are in world units there, and in pixels on cards. */
  perspective: boolean;
  /** Written with where the ball is, for the camera that pans with it. */
  ballTrack?: BallTrack | null;
  /** The sky at this venue, because a ball under floodlights is lit differently from one at one in the afternoon. */
  sky?: Sky | null;
}

interface Burst {
  start: number;
  zone: 1 | -1;
  color: THREE.Color;
  seeded: boolean;
  last: number;
}

export const BallLayer = memo(function BallLayer({ league, situation, animation, reducedMotion, compact, hidden, home, away, style, perspective, ballTrack = null, sky = null }: BallLayerProps) {
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera);
  const G = fieldGeometry();
  /*
   * How hard the venue's own lights are working, which is what the ball is lit
   * by. A ball under floodlights after dark picks up a harder edge than one at
   * one in the afternoon, and the same table the towers and the bowl read from
   * says which this is. Exactly 1 where nothing was reported, so a ball on a
   * field with no sky is lit as it always was.
   */
  const lit = towerStrength(sky);
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
      // Painted turf is lit by a sun and a ball over it casts a shadow. The
      // holographic field has no sun, and there the mark is light instead.
      groundShadow: new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.6 }),
      spot: new THREE.MeshBasicMaterial({ color: MINT.clone(), transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide, toneMapped: false }),
      /*
       * The gate between the uprights, lit only when the provider says the kick
       * was good. It is the one moment the goal posts are the subject, and the
       * difference between a kick that counted and one that did not was a ring
       * on the grass that looked the same either way.
       */
      gate: new THREE.MeshBasicMaterial({ map: fadeTexture('up'), color: MINT.clone(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }),
      /*
       * A rim of light around the ball's silhouette: the same shape a touch
       * larger with only its back faces drawn, so it shows where it reaches past
       * the ball and is hidden behind it everywhere else. Leather is the darkest
       * thing on a dark field and the ball is the subject of every play; this is
       * what separates the two without lighting the turf.
       */
      ballRim: new THREE.MeshBasicMaterial({ color: MINT.clone(), transparent: true, opacity: 0.34, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      // The arrow is the shared one no longer: it carries a team's colour, and a
      // shared material would paint every field on the slate the same team.
      arrow: new THREE.MeshBasicMaterial({ color: MINT.clone(), opacity: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8, toneMapped: false }),
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
  const teamGlow = useMemo(() => ({ home: new THREE.Color(accentFor(home.color, true)), away: new THREE.Color(accentFor(away.color, true)) }), [home.color, away.color]);

  /*
   * The ball wears the mark of the team the provider says has it, on the game
   * page where it is big enough to be read. When possession is not reported the
   * ball is plain leather, because the field never guesses who has it.
   *
   * The skin is reference counted exactly as the end zones are: one texture per
   * team, kept for half a minute after nothing is showing it, so a turnover
   * back and forth does not redraw either one.
   */
  const offenseTeam = offense === 'home' ? home : offense === 'away' ? away : null;
  const skinKey = perspective && offenseTeam ? ballSkinKey(offenseTeam) : null;
  const skin = useMemo(() => (skinKey && offenseTeam ? acquireBallSkin(offenseTeam) : null), [skinKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!skinKey) return;
    retainBallSkin(skinKey);
    return () => releaseBallSkin(skinKey);
  }, [skinKey]);

  /** The colour every mark on the field takes while this team has the ball. */
  const held = offense === 'home' ? teamGlow.home : offense === 'away' ? teamGlow.away : MINT;

  useEffect(() => {
    mats.ball.map = skin;
    mats.ball.color.copy(skin ? WHITE : BALL);
    mats.ball.needsUpdate = true;
    invalidate();
  }, [mats, skin, invalidate]);

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
  const spotRef = useRef<THREE.Mesh>(null);
  const gateRef = useRef<THREE.Mesh>(null);

  const run = useRef<{ plan: PlayAnimation; start: number } | null>(null);
  const probeAt = useMemo(() => new THREE.Vector3(), []);
  const burst = useRef<Burst | null>(null);
  const shown = useRef({ los: ballX, first: firstX, heading: dir === -1 ? Math.PI : 0, z: restZ, at: 0, bx: null as number | null, by: 0, spin: 0, pitch: 0 });

  useEffect(() => {
    if (!animation || run.current?.plan.key === animation.key) return;
    const start = performance.now();
    run.current = { plan: animation, start };
    if (holo && animation.effect === 'touchdown') {
      const zone = scoringZone(animation.toYard, animation.offenseBefore);
      burst.current = { start: start + animation.durationMs, zone, color: zone === 1 ? teamGlow.away : teamGlow.home, seeded: false, last: 0 };
    }
    invalidate();
  }, [animation, invalidate, holo, teamGlow]);

  useEffect(() => {
    invalidate();
  }, [ballX, restZ, firstX, goalX, dir, redZone, hidden, holo, invalidate]);

  /*
   * The latest play's movement, drawn as the ball runs it and left in place
   * afterwards until the next play.
   *
   * It used to appear only once the ball had landed, which meant the most
   * interesting second of a play had no path in it at all. Now the path draws
   * itself under the ball: the arc reveals segment by segment through the
   * geometry's own draw range, and the ground ribbon is built from the origin
   * along its own axis so it can simply be scaled out from where the play
   * started. Neither rebuilds anything per frame.
   */
  const trail = useMemo(() => {
    if (!animation || animation.corrected || animation.fromYard === null || animation.toYard === null) return null;
    const moveDir = animation.offenseBefore ? attackDirection(animation.offenseBefore) : 1;
    const from = worldX(animation.fromYard);
    const to = isFieldGoal(animation) ? moveDir * 60 : worldX(animation.toYard);
    const fromZ = lateralZ(animation.fromLateral);
    const toZ = isFieldGoal(animation) ? 0 : animation.toLateral != null ? lateralZ(animation.toLateral) : fromZ;
    const distance = Math.hypot(to - from, toZ - fromZ);
    if (distance < 0.75 || animation.path === 'incomplete' || animation.path === 'pick') return null;
    if (animation.path === 'arc' || animation.path === 'kick') {
      const h = arcHeight(Math.abs(to - from), animation.path === 'kick');
      const end = isFieldGoal(animation) ? crossbar + 2 : 0.35;
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(from, 0.35, fromZ), new THREE.Vector3((from + to) / 2, h * 2, (fromZ + toZ) / 2), new THREE.Vector3(to, end, toZ));
      // Thick enough to read. At 0.16 of a yard the arc was under a pixel wide on
      // the game page and about half of one on a card, so the path a pass took
      // was being drawn and never seen.
      const geometry = new THREE.TubeGeometry(curve, 40, compact ? 0.5 : perspective ? 0.42 : 0.34, 6, false);
      // A tube is indexed along its length, so a prefix of the index buffer is
      // the first stretch of the arc. Six indices is one ring of it, and the
      // range is kept to whole rings so no half quad is ever drawn.
      return { geometry: geometry as THREE.BufferGeometry, loss: false, rings: (geometry.index?.count ?? 0) / 6, from, fromZ, angle: 0, distance };
    }
    // A flat ribbon along its own axis from the origin, so the mesh can be put
    // where the play began and scaled out along it. Its texture brightens
    // toward the ball whichever way it ran.
    const geometry = new THREE.PlaneGeometry(1, compact ? 1 : 0.7);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0.5, 0, 0);
    return { geometry: geometry as THREE.BufferGeometry, loss: (to - from) * moveDir < 0, rings: 0, from, fromZ, angle: Math.atan2(-(toZ - fromZ), to - from), distance };
  }, [animation, compact, crossbar, perspective]);
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
    if (spotRef.current) spotRef.current.visible = false;
    if (gateRef.current) gateRef.current.visible = false;
    if (chain) chain.visible = false;
    if (column) column.visible = false;
    const leather = skin ? WHITE : BALL;
    mats.ball.color.copy(leather);
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
      if (ballTrack) ballTrack.live = false;
      shown.current.los = null;
      shown.current.first = null;
      shown.current.bx = null;
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
    // How much of the play's path has been run: it draws itself under the ball
    // and stays whole once the play has landed.
    let trailAt = 1;
    // Which way the ball is travelling, and whether it is in the air rather than
    // in somebody's hands. Both are read from the reported play below.
    let travelDir = dir ?? 1;
    let inFlight = false;
    let tumbling = false;

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
      travelDir = moveDir;
      if (elapsed < p.durationMs) {
        losTarget = from;
        heading = moveDir === -1 ? Math.PI : 0;
        trailAt = t;
        // A pass, a kick, an incompletion and a blocked kick are all a ball in
        // the air. A sweep is a ball being carried and a sack is a ball being
        // held, and neither of those turns. An interception is both in turn,
        // and says so from inside its own case below.
        inFlight = p.path === 'arc' || p.path === 'kick' || p.path === 'incomplete' || p.path === 'blocked' || p.path === 'pick';
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
          case 'blocked': {
            // Up off the foot and knocked straight back down: it never gets
            // away, so it is short, low and over quickly.
            const u = easeOut(t);
            bx = lerp(from, to, u);
            bz = lerp(fromZ, toZ, u);
            const climb = t < 0.28 ? easeOut(t / 0.28) : (1 - (t - 0.28) / 0.72) ** 2;
            by = BALL_Y + 3.2 * climb;
            break;
          }
          case 'pick': {
            // Thrown one way and taken back the other: in the air for the throw
            // and carried for the return, which is why it spirals out and stops
            // spiralling once it has changed hands.
            const turn = 0.45;
            const beyond = moveDir > 0 ? Math.max(from, to) : Math.min(from, to);
            const out = beyond + moveDir * PICK_OUT;
            if (t < turn) {
              const u = t / turn;
              bx = lerp(from, out, easeSine(u));
              bz = fromZ;
              by = BALL_Y + arcHeight(Math.abs(out - from), false) * Math.sin(Math.PI * u);
            } else {
              const u = (t - turn) / (1 - turn);
              inFlight = false;
              bx = lerp(out, to, easeInOut(u));
              bz = lerp(fromZ, toZ, easeInOut(u));
              heading = out > to ? Math.PI : 0;
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
        // Read after the shape has run, because an interception is only in the
        // air for the first half of itself.
        tumbling = inFlight && PLACE_KICKS.has(p.kind);
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
          const zone = scoringZone(p.toYard, p.offenseBefore);
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
        if (p.effect === 'field_goal' && gateRef.current) {
          // A kick the provider called good, lighting the gate it went through.
          const post = markingsFor(league).goalpost;
          const gate = gateRef.current;
          gate.visible = true;
          gate.position.set(moveDir * 60, post.crossbarHeight, 0);
          gate.scale.set(1, (post.uprightTop - post.crossbarHeight) * (0.35 + 0.65 * easeOut(te)), 1);
          mats.gate.color.copy(MINT);
          mats.gate.opacity = 0.8 * Math.sin(Math.PI * te);
        }
        if (p.effect === 'turnover') mats.ball.color.copy(leather).lerp(AMBER, Math.sin(Math.PI * te));
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
      /*
       * The moment the ball arrives, one quick ring at the spot it stopped,
       * widened by the ground the play covered so a long gain lands harder than
       * a two yard run. A play that scores has its own, larger mark and does not
       * get this one as well, and a settle is a play that was never drawn
       * moving, so it has nothing to land from.
       */
      const settled = elapsed - p.durationMs;
      const spot = spotRef.current;
      if (spot && !compact && p.path !== 'settle' && (p.effect === null || p.effect === 'first_down') && settled >= 0 && settled < SPOT_MS) {
        const u = settled / SPOT_MS;
        const yards = p.fromYard !== null && p.toYard !== null ? Math.abs(p.toYard - p.fromYard) : 0;
        spot.visible = true;
        spot.position.set(to, 0.1, toZ);
        spot.scale.setScalar(1 + easeOut(u) * (2.2 + Math.min(3.4, yards * 0.08)));
        mats.spot.opacity = 0.55 * (1 - u) ** 1.5;
        active = true;
      }
      if (p.effect === 'penalty' && elapsed < p.durationMs + p.effectMs + 900) {
        flag.visible = true;
        const drop = clamp01(elapsed / 280);
        flag.position.set(from + moveDir * 2, lerp(7, 0.3, easeOut(drop)), fromZ + 5);
      }
      if (elapsed < p.durationMs + Math.max(p.effectMs, hold) + 260 || (p.effect === 'penalty' && elapsed < p.durationMs + p.effectMs + 900)) active = true;
      else run.current = null;
    }

    /*
     * The marks on the field take the colour of whoever the provider says has
     * the ball, and ease between them, so a turnover reads as the field
     * changing hands rather than only as a line of text. With no possession
     * reported they go back to the field's own colour, and claim nothing.
     */
    const tint = reducedMotion ? 1 : 1 - Math.exp(-dt / 190);
    for (const m of [mats.arrow, mats.halo, mats.ballRim]) {
      const gap = Math.abs(m.color.r - held.r) + Math.abs(m.color.g - held.g) + Math.abs(m.color.b - held.b);
      if (gap < 0.006) m.color.copy(held);
      else {
        m.color.lerp(held, tint);
        active = true;
      }
    }

    // Which way the ball faces, smoothed once and shared by the ball and the
    // arrow, so the two can never point different ways for a frame.
    s.heading = s.heading + (heading - s.heading) * (reducedMotion ? 1 : 1 - Math.exp(-dt / 90));
    if (Math.abs(heading - s.heading) > 0.01) active = true;
    else s.heading = heading;

    ball.visible = true;
    ball.position.set(bx, by, bz);
    mats.ball.opacity = opacity;

    /*
     * How a football carries itself.
     *
     * A thrown or kicked ball spirals about its long axis, and its nose follows
     * the arc it is on: up off the hand, level at the top, down into the catch.
     * A ball being carried is tucked under an arm and does not spin at all.
     * Which of those it is comes from the reported play, so the ball itself
     * tells a pass from a run before the description is read.
     *
     * The pitch is measured from the ball's own last two positions rather than
     * from the path it is on, so it is right for every path without any of them
     * having to describe it. At the moment of release a pass has climb and no
     * reach yet, which would stand the ball on its end, so the reach it is
     * measured against has a floor.
     */
    const dy = s.bx === null ? 0 : by - s.by;
    const along = s.bx === null ? 0 : (bx - s.bx) * travelDir;
    s.bx = bx;
    s.by = by;
    if (inFlight && tumbling) {
      // A ball struck off the ground goes over the top, and the nose going over
      // IS the flight: it does not also follow the arc, and it does not spiral.
      s.pitch += TUMBLE_RATE * (dt / 1000);
      s.spin += (Math.round(s.spin / TAU) * TAU - s.spin) * ease;
      active = true;
    } else if (inFlight) {
      s.spin += SPIN_RATE * (dt / 1000);
      const pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.atan2(dy, Math.max(0.35, Math.abs(along)))));
      s.pitch += (pitch - s.pitch) * (reducedMotion ? 1 : 0.35);
      active = true;
    } else {
      // Settling: both turns unwind to the nearest whole one, so a ball at rest
      // is level with its laces up rather than stopped wherever the play left
      // it, and a tumble that made four turns does not rewind all four.
      const restSpin = Math.round(s.spin / TAU) * TAU;
      const restPitch = Math.round(s.pitch / TAU) * TAU;
      s.spin += (restSpin - s.spin) * ease;
      s.pitch += (restPitch - s.pitch) * ease;
      if (Math.abs(restSpin - s.spin) > 0.01 || Math.abs(restPitch - s.pitch) > 0.01) active = true;
      else {
        s.spin = 0;
        s.pitch = 0;
      }
    }
    // YZX: yaw turns the ball down the field, then pitch tilts its nose, then
    // the spin runs about the long axis the first two just aimed.
    ball.rotation.set(s.spin, s.heading, s.pitch, 'YZX');
    // The rim carries a little more while the ball is in the air, which is the
    // moment it has to be followed across a lit field.
    mats.ballRim.opacity += ((inFlight ? 0.62 : 0.34) * lit - mats.ballRim.opacity) * (reducedMotion ? 1 : 0.18);
    if (halo) {
      /*
       * The mark on the ground under the ball, which is what says the ball is
       * over the field rather than on it. It spreads and softens as the ball
       * climbs, the way a shadow does. It used to tighten instead, which read as
       * a ball sinking into the turf on a deep pass.
       *
       * On painted turf it is a shadow and falls away from the light. On the
       * holographic field there is no sun and it stays under the ball, where it
       * is also the only thing marking the ball over a dark surface.
       */
      const lift = Math.max(0, by - BALL_Y);
      halo.visible = opacity > 0.05;
      halo.scale.setScalar(1 + Math.min(1.5, lift * 0.07));
      const drift = holo ? 0 : Math.min(2.6, lift * 0.2);
      halo.position.set(bx + drift, 0.08, bz - drift * 2);
      const ground = holo ? mats.halo : mats.groundShadow;
      ground.opacity = (holo ? 0.85 : 0.62) * (1 - Math.min(0.62, lift / 18));
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
      arrow.visible = opacity > 0.3;
      arrow.rotation.y = s.heading;
      arrow.position.set(bx + Math.cos(s.heading) * 4.4, 0.09, bz);
    }

    if (ballTrack) {
      ballTrack.x = bx;
      // Only while the ball is actually running a play. A ball sitting at a spot
      // is the other camera behaviour's business, and panning to it here would
      // fight the tween that moves there.
      ballTrack.live = !!r && now - r.start < r.plan.durationMs;
    }

    const q = fieldProbe;
    q.x = bx;
    q.y = by;
    q.spin = s.spin;
    q.pitch = s.pitch;
    q.yaw = s.heading;
    q.inFlight = inFlight;
    q.tumbling = tumbling;
    q.path = run.current?.plan.path ?? null;
    q.kind = run.current?.plan.kind ?? null;
    q.trail = trailAt;
    q.spotVisible = spotRef.current?.visible ?? false;
    q.gateVisible = gateRef.current?.visible ?? false;
    q.possession = offense;
    q.mark = `#${mats.arrow.color.getHexString()}`;
    q.skin = skinKey;
    if (perspective) {
      probeAt.set(bx, by, bz).project(camera);
      q.ndcX = probeAt.x;
      q.ndcY = probeAt.y;
      q.camX = camera.position.x;
    }

    const tr = trailRef.current;
    if (tr && trail) {
      tr.visible = trailAt > 0.02;
      const map = (tr.material as THREE.MeshBasicMaterial).map;
      if (trail.rings > 0) {
        // An arc is built where it happens, so the mesh itself sits at the
        // origin. The previous play may have been a ribbon, which does not.
        tr.position.set(0, 0, 0);
        tr.rotation.y = 0;
        tr.scale.set(1, 1, 1);
        trail.geometry.setDrawRange(0, Math.max(1, Math.ceil(trail.rings * trailAt)) * 6);
        // The ramp is almost clear where the play started and bright where it
        // ends, so it has to be squeezed into the part that has been drawn.
        // Left alone, a growing arc shows only the clear end of its own fade
        // and looks like nothing is there at all.
        if (map) map.repeat.x = 1 / Math.max(0.05, trailAt);
      } else {
        tr.position.set(trail.from, 0.07, trail.fromZ);
        tr.rotation.y = trail.angle;
        tr.scale.set(trail.distance * trailAt, 1, 1);
        // A ribbon is scaled rather than clipped, so its own uv already spans
        // what is drawn.
        if (map) map.repeat.x = 1;
      }
    } else if (tr) tr.visible = false;
    if (active) invalidate();
  });

  useEffect(() => (perspective ? installFieldProbe() : undefined), [perspective]);

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
      {!compact && <mesh ref={haloRef} geometry={G.halo} material={holo ? mats.halo : mats.groundShadow} visible={false} />}
      <mesh ref={spotRef} geometry={G.ring} material={mats.spot} visible={false} />
      <mesh ref={gateRef} geometry={G.gate[league]} material={mats.gate} visible={false} renderOrder={4} />
      <group ref={arrowRef} visible={false}>
        <mesh geometry={G.arrow} material={mats.arrow} scale={compact ? 1.5 : 1} />
      </group>
      <group ref={ballRef} visible={false} scale={compact ? 1.6 : 1.15}>
        <mesh geometry={G.ball} material={mats.ball} />
        {holo && perspective && <mesh geometry={G.ball} material={mats.ballRim} scale={1.07} renderOrder={1} />}
        {!compact && <mesh geometry={G.lace} material={M.lace} />}
        {!compact && markingsFor(league).ball.stripes && <mesh geometry={G.ballStripes} material={M.lace} />}
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
