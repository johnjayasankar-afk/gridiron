/**
 * Cameras for field views. Each view owns its camera and sizes it from its own
 * element, so a card that resizes stays framed. Cards use an orthographic view
 * with a gentle lift on hover and a quick cut when Director mode changes games;
 * the detail field adds presets and a restrained orbit.
 */
import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { BallTrack, PointerState } from './frameBus';

function useElementSize(track: RefObject<HTMLElement | null>, onSize: (width: number, height: number) => void) {
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) onSize(r.width, r.height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [track, onSize]);
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const CARD_BASE = new THREE.Vector3(0, 110, 95);
const CARD_LIFT = new THREE.Vector3(0, 94, 110);
/** Short, wide tiles (the wall) look from lower, so the field can use their width. */
const CARD_WIDE = new THREE.Vector3(0, 64, 128);
const CARD_WIDE_LIFT = new THREE.Vector3(0, 54, 133);
const CARD_CUT_FROM = new THREE.Vector3(0, 150, 26);
const CARD_LOOK = new THREE.Vector3(0, -1, 0);

/** 0 for ordinary card proportions, rising to 1 for a slot five times wider than it is tall. */
const wideness = (aspect: number) => THREE.MathUtils.clamp((aspect - 2.6) / 2.4, 0, 1);

function restPose(aspect: number, lift: boolean): THREE.Vector3 {
  const t = wideness(aspect);
  return lift ? new THREE.Vector3().lerpVectors(CARD_LIFT, CARD_WIDE_LIFT, t) : new THREE.Vector3().lerpVectors(CARD_BASE, CARD_WIDE, t);
}

export interface CardCameraProps {
  track: RefObject<HTMLElement | null>;
  compact: boolean;
  cutToken: number;
  lift: boolean;
  reducedMotion: boolean;
  /** The pointer over the card, if any: the camera leans a few degrees toward it. */
  pointer?: PointerState;
}

const MAX_YAW = 0.1;
const MAX_PITCH = 0.08;

export function CardCamera({ track, compact, cutToken, lift, reducedMotion, pointer }: CardCameraProps) {
  const set = useThree((s) => s.set);
  const invalidate = useThree((s) => s.invalidate);
  const camera = useMemo(() => {
    const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
    // Manual: R3F and drei would otherwise reset the frustum to pixel units every frame.
    (c as THREE.OrthographicCamera & { manual?: boolean }).manual = true;
    c.position.copy(CARD_BASE);
    c.lookAt(CARD_LOOK);
    return c;
  }, []);
  const size = useRef({ width: 0, height: 0 });
  /** Where the camera rests or travels, before the pointer lean is applied. */
  const base = useRef(CARD_BASE.clone());
  const tween = useRef<{ from: THREE.Vector3; to: THREE.Vector3; start: number; duration: number } | null>(null);
  const lean = useRef({ x: 0, y: 0 });
  const lifted = useRef(lift && !reducedMotion);
  lifted.current = lift && !reducedMotion;
  const aspect = () => (size.current.width && size.current.height ? size.current.width / size.current.height : 2.2);

  useLayoutEffect(() => {
    set({ camera });
  }, [camera, set]);

  const fit = useMemo(
    () => () => {
      const { width, height } = size.current;
      if (!width || !height) return;
      const offset = camera.position.clone().sub(CARD_LOOK);
      const elevation = Math.atan2(offset.y, Math.hypot(offset.x, offset.z));
      const yaw = Math.abs(Math.atan2(offset.x, offset.z));
      const needWidth = (compact ? 124 : 130) * Math.cos(yaw) + 56 * Math.sin(yaw);
      const needHeight = (66 * Math.sin(elevation) + 3.2 * Math.cos(elevation)) * Math.cos(yaw) + 62 * Math.sin(yaw) * Math.sin(elevation) + (compact ? 2 : 5);
      const unitsPerPixel = Math.max(needWidth / width, needHeight / height);
      camera.left = (-width * unitsPerPixel) / 2;
      camera.right = (width * unitsPerPixel) / 2;
      camera.top = (height * unitsPerPixel) / 2;
      camera.bottom = (-height * unitsPerPixel) / 2;
      camera.updateProjectionMatrix();
    },
    [camera, compact],
  );

  /** Places the camera at the base pose turned by the current lean, then refits the frustum. */
  const apply = useMemo(
    () => () => {
      const offset = base.current.clone().sub(CARD_LOOK);
      const radius = offset.length();
      const elevation = THREE.MathUtils.clamp(Math.atan2(offset.y, Math.hypot(offset.x, offset.z)) - lean.current.y * MAX_PITCH, 0.3, 1.45);
      const azimuth = Math.atan2(offset.x, offset.z) + lean.current.x * MAX_YAW;
      camera.position.set(CARD_LOOK.x + radius * Math.cos(elevation) * Math.sin(azimuth), CARD_LOOK.y + radius * Math.sin(elevation), CARD_LOOK.z + radius * Math.cos(elevation) * Math.cos(azimuth));
      camera.lookAt(CARD_LOOK);
      fit();
    },
    [camera, fit],
  );

  const onSize = useMemo(
    () => (width: number, height: number) => {
      size.current = { width, height };
      // A new shape can mean a new resting angle. A running move keeps its course and ends there.
      const rest = restPose(width / height, lifted.current);
      if (tween.current) tween.current.to.copy(rest);
      else base.current.copy(rest);
      apply();
      invalidate();
    },
    [apply, invalidate],
  );
  useElementSize(track, onSize);

  const moveTo = (to: THREE.Vector3, from: THREE.Vector3, duration: number) => {
    if (reducedMotion) {
      base.current.copy(to);
      tween.current = null;
      apply();
    } else {
      base.current.copy(from);
      tween.current = { from: from.clone(), to: to.clone(), start: performance.now(), duration };
    }
    invalidate();
  };

  useEffect(() => {
    const rest = restPose(aspect(), lift && !reducedMotion);
    if (!tween.current && base.current.distanceToSquared(rest) < 1e-4) return;
    moveTo(rest, base.current.clone(), 360);
  }, [lift, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  // A Director slot mounts with a positive token; a later change also cuts.
  const lastCut = useRef(cutToken > 0 ? -1 : cutToken);
  useEffect(() => {
    if (cutToken === lastCut.current) return;
    lastCut.current = cutToken;
    if (!reducedMotion) moveTo(restPose(aspect(), lift), CARD_CUT_FROM, 560);
  }, [cutToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    let moving = false;
    const tw = tween.current;
    if (tw) {
      const t = Math.min(1, (performance.now() - tw.start) / tw.duration);
      base.current.lerpVectors(tw.from, tw.to, easeOutCubic(t));
      if (t < 1) moving = true;
      else tween.current = null;
    }
    const target = pointer?.active && !reducedMotion ? pointer : null;
    const tx = target ? THREE.MathUtils.clamp(target.x, -1, 1) : 0;
    const ty = target ? THREE.MathUtils.clamp(target.y, -1, 1) : 0;
    const k = lean.current;
    if (Math.abs(tx - k.x) > 0.002 || Math.abs(ty - k.y) > 0.002) {
      k.x += (tx - k.x) * 0.14;
      k.y += (ty - k.y) * 0.14;
      moving = true;
    } else {
      k.x = tx;
      k.y = ty;
    }
    apply();
    if (moving) invalidate();
  });
  return null;
}

export type CameraPreset = 'isometric' | 'broadcast' | 'top';

function pose(preset: CameraPreset, focusX: number, aspect: number) {
  // Narrow screens pull the camera back so the whole field stays in view.
  const k = Math.max(1, 1.9 / Math.max(0.45, aspect));
  let position: THREE.Vector3;
  let target: THREE.Vector3;
  switch (preset) {
    case 'broadcast':
      target = new THREE.Vector3(focusX * 0.8, 0, -3);
      position = new THREE.Vector3(focusX * 0.8, 44, 100);
      break;
    case 'top':
      target = new THREE.Vector3(0, 0, 0);
      position = new THREE.Vector3(0, 196, 0.01);
      break;
    default:
      target = new THREE.Vector3(focusX * 0.25, 0, 0);
      position = new THREE.Vector3(-70 + focusX * 0.25, 94, 106);
  }
  return { position: target.clone().add(position.clone().sub(target).multiplyScalar(k)), target };
}

export interface DetailCameraProps {
  track: RefObject<HTMLElement | null>;
  preset: CameraPreset;
  /** Changes when the user asks to reset the view. */
  resetToken: number;
  /** World x of the reported ball, for presets that follow play. */
  focusX: number;
  reducedMotion: boolean;
  zoomEnabled: boolean;
  zoomRequest: { token: number; factor: number };
  /** Opening the page flies the camera in from above (Full effects only). */
  flyIn?: boolean;
  /** Where the ball is, so the broadcast camera can pan with a play as it runs. */
  ball?: BallTrack | null;
}

export function DetailCamera({ track, preset, resetToken, focusX, reducedMotion, zoomEnabled, zoomRequest, flyIn = false, ball = null }: DetailCameraProps) {
  const set = useThree((s) => s.set);
  const invalidate = useThree((s) => s.invalidate);
  const camera = useMemo(() => {
    const c = new THREE.PerspectiveCamera(30, 16 / 9, 1, 2000);
    (c as THREE.PerspectiveCamera & { manual?: boolean }).manual = true;
    return c;
  }, []);
  const controls = useRef<OrbitControlsImpl | null>(null);
  const tween = useRef<{ fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number; duration: number } | null>(null);
  const userMoved = useRef(false);
  const initialised = useRef(false);

  useLayoutEffect(() => {
    set({ camera });
  }, [camera, set]);

  const onSize = useMemo(
    () => (width: number, height: number) => {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      invalidate();
    },
    [camera, invalidate],
  );
  useElementSize(track, onSize);

  const moveTo = (next: ReturnType<typeof pose>, animate: boolean, duration = 620) => {
    const c = controls.current;
    if (!c) return;
    if (!animate) {
      camera.position.copy(next.position);
      c.target.copy(next.target);
      c.update();
      invalidate();
      return;
    }
    tween.current = { fromPos: camera.position.clone(), toPos: next.position, fromTarget: c.target.clone(), toTarget: next.target, start: performance.now(), duration };
    invalidate();
  };

  // A preset or reset always applies; a new ball spot only moves the broadcast camera, and never after the user has orbited.
  useEffect(() => {
    userMoved.current = false;
    const next = pose(preset, focusX, camera.aspect);
    const c = controls.current;
    if (!initialised.current && flyIn && !reducedMotion && c) {
      camera.position.copy(next.target.clone().add(new THREE.Vector3(-60, 210, 230)));
      c.target.copy(next.target);
      c.update();
      moveTo(next, true, 1700);
    } else moveTo(next, initialised.current && !reducedMotion);
    initialised.current = true;
  }, [preset, resetToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const followKey = Math.round(focusX / 4);
  useEffect(() => {
    if (preset !== 'broadcast' || userMoved.current || !initialised.current) return;
    moveTo(pose(preset, focusX, camera.aspect), !reducedMotion);
  }, [followKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = controls.current;
    if (!c || zoomRequest.token === 0) return;
    const offset = camera.position.clone().sub(c.target);
    const distance = THREE.MathUtils.clamp(offset.length() * zoomRequest.factor, c.minDistance, c.maxDistance);
    userMoved.current = true;
    moveTo({ position: c.target.clone().add(offset.setLength(distance)), target: c.target.clone() }, !reducedMotion);
  }, [zoomRequest.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const panned = useRef(0);

  useFrame((_, delta) => {
    const tw = tween.current;
    const c = controls.current;
    /*
     * The broadcast camera pans with the ball while a play runs, instead of
     * waiting for it to stop and then cutting to where it ended. It is a pan
     * along the field and nothing else: the camera keeps its own height, angle
     * and distance, which is what a camera on a sideline actually does, and it
     * lags a little rather than tracking the ball exactly.
     *
     * It gives way to everything else. A preset, a reset or a zoom is a tween
     * and takes over, and once the viewer has turned the camera themselves it
     * never moves again on its own.
     */
    if (!tw && c && ball?.live && preset === 'broadcast' && !userMoved.current && !reducedMotion) {
      const want = ball.x * 0.8;
      const step = 1 - Math.exp(-Math.min(0.1, delta) / 0.28);
      const move = (want - c.target.x) * step;
      if (Math.abs(move) > 0.001) {
        c.target.x += move;
        camera.position.x += move;
        panned.current += move;
        c.update();
        invalidate();
      }
    }
    if (!tw || !c) return;
    const t = Math.min(1, (performance.now() - tw.start) / tw.duration);
    const e = easeInOut(t);
    camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
    c.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
    c.update();
    if (t < 1) invalidate();
    else tween.current = null;
  });

  return (
    <OrbitControls
      ref={controls}
      camera={camera}
      domElement={track.current ?? undefined}
      enablePan={false}
      enableZoom={zoomEnabled}
      enableDamping={!reducedMotion}
      dampingFactor={0.14}
      rotateSpeed={0.5}
      zoomSpeed={0.6}
      minDistance={70}
      maxDistance={340}
      minPolarAngle={0}
      maxPolarAngle={Math.PI * 0.45}
      onStart={() => {
        userMoved.current = true;
        tween.current = null;
      }}
    />
  );
}
