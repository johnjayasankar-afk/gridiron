/**
 * The drive on the field.
 *
 * Every other view answers "where is the ball". A drive is the thing the ball is
 * in the middle of, and until now it lived only in a chart beside the field: how
 * far this team has come, and how they came. The field is the one place that
 * question is spatial, so it is answered there.
 *
 * Three readings, all from shared/driveTrack, which is where the arithmetic
 * already lives and is already tested:
 *
 *   the band   the ground between where the drive began and where the ball is,
 *              in the offense's colour. Its length IS the drive.
 *   the post   where the drive began, so the band has a start you can point at.
 *   the ticks  one mark per play that had a reported end spot, along the near
 *              sideline. Their spacing is the rhythm of the drive: eight close
 *              together is a grind, one far from the rest is the play that broke
 *              it open.
 *
 * Only reported spots are drawn. A play the provider gave no spot for has no
 * tick, and the panel beside the field says how many those were; nothing here
 * guesses a position to fill the gap.
 *
 * It is static. It is rebuilt when the drive changes and never touches a frame
 * otherwise, and it is only ever built for the game page.
 */
import { memo, useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DrivePlayTone, DriveTrack } from '../../shared/driveTrack';
import { worldX } from '../../shared/field';
import { teamFor } from '../../shared/format';
import type { GameSummary } from '../../shared/model';
import { accentFor } from './color';
import { fieldGeometry } from './geometry';
import { fieldProbe } from './probe';
import { fadeTexture } from './textures';

/** Between the near numbers and the sideline, where nothing else is drawn. */
const TICK_Z = 19;
const TICK_LONG = 1;
const TICK_WIDE = 4;
/** The field's own width, for the dashed marker that runs across it. */
const FIELD_WIDTH = 160 / 3;

const LOSS = new THREE.Color('#f4aa5c');
const SCORE = new THREE.Color('#a7f3d0');

/** A play that went backwards or handed the ball over reads in the warning colour, not the team's. */
function toneColor(tone: DrivePlayTone, team: THREE.Color): THREE.Color {
  if (tone === 'loss' || tone === 'conceded' || tone === 'turnover' || tone === 'penalty') return LOSS;
  if (tone === 'score') return SCORE;
  return team;
}

export interface DriveLayerProps {
  track: DriveTrack | null;
  game: GameSummary;
}

export const DriveLayer = memo(function DriveLayer({ track, game }: DriveLayerProps) {
  const invalidate = useThree((s) => s.invalidate);
  const G = fieldGeometry();

  const team = teamFor(game, track?.offense ?? null);
  const accent = accentFor(team?.color ?? null, true);

  const materials = useMemo(
    () => ({
      /*
       * The band is a ramp, not a slab: faint where the drive began and
       * strongest at the ball, so it reads as ground taken rather than a wash
       * of team colour over half the field, which is what a flat fill of it
       * looked like. The texture is cloned because the ramp is turned around
       * when a drive runs the other way.
       */
      band: new THREE.MeshBasicMaterial({ map: fadeTexture('along').clone(), color: accent, transparent: true, opacity: 0.17, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 }),
      post: new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
      ticks: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
    }),
    [accent],
  );
  useEffect(
    () => () => {
      materials.band.map?.dispose();
      Object.values(materials).forEach((m) => m.dispose());
    },
    [materials],
  );

  /** One mark per play the provider gave an end spot for, oldest dimmest. */
  const ticks = useMemo(() => {
    const plays = track?.plays.filter((p) => p.to !== null) ?? [];
    if (!plays.length) return null;
    const teamColor = new THREE.Color(accent);
    const parts = plays.map((play, i) => {
      const bar = new THREE.PlaneGeometry(TICK_LONG, TICK_WIDE).rotateX(-Math.PI / 2).translate(worldX(play.to!), 0, TICK_Z);
      // The latest play is the one being watched, so it is the brightest; the
      // rest fade back in the order they happened.
      const age = plays.length === 1 ? 1 : i / (plays.length - 1);
      const shade = toneColor(play.tone, teamColor).clone().multiplyScalar(0.42 + 0.58 * age);
      const colors = new Float32Array(bar.attributes.position.count * 3);
      for (let v = 0; v < bar.attributes.position.count; v++) {
        colors[v * 3] = shade.r;
        colors[v * 3 + 1] = shade.g;
        colors[v * 3 + 2] = shade.b;
      }
      bar.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      return bar;
    });
    return mergeGeometries(parts) ?? parts[0];
  }, [track, accent]);
  useEffect(() => () => ticks?.dispose(), [ticks]);

  /*
   * The drive's start, as a dashed line rather than a solid one. Blue already
   * means the line of scrimmage and amber the line to gain; a third solid line
   * in a team's colour reads as a fourth rule nobody can name. A dash is a
   * different kind of mark, so it cannot be mistaken for either.
   */
  const startMark = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const dash = 2.4;
    const gap = 1.7;
    const step = dash + gap;
    const count = Math.floor(FIELD_WIDTH / step);
    const first = -((count - 1) * step) / 2;
    for (let i = 0; i < count; i++) parts.push(new THREE.PlaneGeometry(0.5, dash).rotateX(-Math.PI / 2).translate(0, 0, first + i * step));
    return mergeGeometries(parts) ?? parts[0];
  }, []);
  useEffect(() => () => startMark.dispose(), [startMark]);

  const band = useMemo(() => {
    if (!track || track.start === null || track.ball === null) return null;
    const from = worldX(track.start);
    const to = worldX(track.ball);
    const length = Math.abs(to - from);
    if (length < 0.8) return null;
    // Which way the ramp runs: a negative scale turns the geometry round with it.
    return { at: (from + to) / 2, length, post: from, facing: to >= from ? 1 : -1 };
  }, [track]);

  useEffect(() => {
    // What the field understands the drive to be, so a test can hold it against
    // what the panel beside the field says about the same one.
    fieldProbe.drive = track ? { start: track.start, ball: track.ball, ticks: track.plays.filter((p) => p.to !== null).length, rows: track.plays.length, playCount: track.playCount, unspotted: track.unspotted } : null;
    invalidate();
  }, [track, band, ticks, accent, startMark, invalidate]);

  if (!track) return null;
  return (
    <group>
      {band && <mesh geometry={G.strip} material={materials.band} position={[band.at, 0.028, 0]} scale={[band.length * band.facing, 1, 1]} />}
      {band && <mesh geometry={startMark} material={materials.post} position={[band.post, 0.03, 0]} />}
      {ticks && <mesh geometry={ticks} material={materials.ticks} position={[0, 0.032, 0]} />}
    </group>
  );
});
