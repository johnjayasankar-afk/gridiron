/**
 * Canvas-drawn textures for the miniature field. Turf and markings are drawn once
 * per league and style from the rulebook values in shared/fieldMarkings.ts and
 * shared by every view. End-zone treatments are drawn per team and released when
 * no field shows them any more.
 *
 * The holographic style draws the same markings as light: dark glass turf with a
 * fine grid, lines that carry a glow baked into the texture, and neon end zones in
 * each team's colour. The classic style is painted turf.
 */
import * as THREE from 'three';
import { markingsFor, NUMBERED_LINES, type FieldMarkings } from '../../shared/fieldMarkings';
import type { LeagueId, Team } from '../../shared/model';
import { accentFor, endZoneTint, luminance, mixColor, withAlpha } from './color';
import type { FieldStyle } from './style';

/** Half extents of the turf texture in yards: the 120 by 53 1/3 yard field plus a two-yard surround. */
export const TURF_HALF = { x: 62, z: 160 / 6 + 2 } as const;
const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const listeners = new Set<() => void>();
export function onFieldTexturesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const notifyChanged = () => listeners.forEach((l) => l());

let fontsReady = typeof document === 'undefined' || !('fonts' in document);
const afterFonts: Array<() => void> = [];
if (!fontsReady) {
  Promise.all([document.fonts.load(`600 64px ${FONT}`), document.fonts.load(`700 64px ${FONT}`)])
    .catch(() => undefined)
    .finally(() => {
      fontsReady = true;
      afterFonts.splice(0).forEach((f) => f());
      notifyChanged();
    });
}

interface TurfPalette {
  background: string;
  border: string;
  endZone: string;
  stripes: [string, string];
  speckle: [string, string];
  speckles: number;
  grid: string | null;
  line: string;
  glow: string | null;
  lineBlur: number;
  goalBlur: number;
  markBlur: number;
  number: string;
  numberBlur: number;
}

const CLASSIC: TurfPalette = {
  background: '#17452d',
  border: 'rgba(244, 248, 242, 0.86)',
  endZone: '#1a5536',
  stripes: ['#1e5d3c', '#246a42'],
  speckle: ['rgba(255,255,255,0.03)', 'rgba(0,0,0,0.05)'],
  speckles: 16000,
  grid: null,
  line: 'rgba(246, 250, 244, 0.95)',
  glow: null,
  lineBlur: 0,
  goalBlur: 0,
  markBlur: 0,
  number: 'rgba(246, 250, 244, 0.95)',
  numberBlur: 0,
};

const HOLO: TurfPalette = {
  background: '#020a06',
  border: 'rgba(110, 231, 183, 0.14)',
  endZone: '#04130c',
  stripes: ['#061a11', '#082216'],
  speckle: ['rgba(167, 243, 208, 0.035)', 'rgba(0, 0, 0, 0.14)'],
  speckles: 9000,
  grid: 'rgba(110, 231, 183, 0.06)',
  line: 'rgba(210, 255, 234, 0.97)',
  glow: 'rgba(110, 231, 183, 0.95)',
  lineBlur: 12,
  goalBlur: 22,
  markBlur: 4,
  number: 'rgba(182, 246, 216, 0.94)',
  numberBlur: 10,
};

function paintField(canvas: HTMLCanvasElement, m: FieldMarkings, style: FieldStyle) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const p = style === 'holo' ? HOLO : CLASSIC;
  const sx = canvas.width / (TURF_HALF.x * 2);
  const sz = canvas.height / (TURF_HALF.z * 2);
  const X = (x: number) => (x + TURF_HALF.x) * sx;
  const Z = (z: number) => (z + TURF_HALF.z) * sz;
  const hw = m.halfWidth;
  const glow = (blur: number) => {
    ctx.shadowColor = p.glow ?? 'transparent';
    ctx.shadowBlur = p.glow ? blur : 0;
  };

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowBlur = 0;
  ctx.fillStyle = p.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // The border outside the field lines.
  ctx.fillStyle = p.border;
  const b = m.border.width;
  if (m.border.extent === 'full') ctx.fillRect(X(-60 - b), Z(-hw - b), (120 + 2 * b) * sx, (m.width + 2 * b) * sz);
  else {
    ctx.fillRect(X(-30), Z(-hw - b), 60 * sx, b * sz);
    ctx.fillRect(X(-30), Z(hw), 60 * sx, b * sz);
  }

  // Turf: end zones, then five-yard mowing stripes between the goal lines.
  ctx.fillStyle = p.endZone;
  ctx.fillRect(X(-60), Z(-hw), 10 * sx, m.width * sz);
  ctx.fillRect(X(50), Z(-hw), 10 * sx, m.width * sz);
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = p.stripes[i % 2];
    ctx.fillRect(X(-50 + i * 5), Z(-hw), 5 * sx + 1, m.width * sz);
  }
  let seed = m.league === 'nfl' ? 1979 : 1869;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < p.speckles; i++) {
    ctx.fillStyle = rand() > 0.5 ? p.speckle[0] : p.speckle[1];
    ctx.fillRect(X(-60) + rand() * 120 * sx, Z(-hw) + rand() * m.width * sz, 1.6, 1.6);
  }
  if (p.grid) {
    ctx.fillStyle = p.grid;
    for (let yard = -60; yard <= 60; yard++) ctx.fillRect(X(yard) - 0.5, Z(-hw), 1, m.width * sz);
    for (let z = -Math.floor(hw); z <= hw; z += 1) ctx.fillRect(X(-60), Z(z) - 0.5, 120 * sx, 1);
  }

  ctx.fillStyle = p.line;
  // Lines are drawn at rulebook width with a floor, so they stay legible in miniature.
  const lineX = Math.max(2.2, m.lineWidth * sx);
  const lineZ = Math.max(2.2, m.lineWidth * sz);
  glow(p.lineBlur);
  ctx.fillRect(X(-60), Z(-hw), 120 * sx, lineZ);
  ctx.fillRect(X(-60), Z(hw) - lineZ, 120 * sx, lineZ);
  ctx.fillRect(X(-60), Z(-hw), lineX, m.width * sz);
  ctx.fillRect(X(60) - lineX, Z(-hw), lineX, m.width * sz);
  glow(p.goalBlur);
  const goal = Math.max(3, m.goalLineWidth * sx * 1.2);
  ctx.fillRect(X(-50) - goal, Z(-hw), goal, m.width * sz);
  ctx.fillRect(X(50), Z(-hw), goal, m.width * sz);
  glow(p.lineBlur);
  for (let yard = 5; yard < 100; yard += 5) {
    ctx.fillRect(X(yard - 50) - lineX / 2, Z(-hw + m.sidelineMarkInset), lineX, (m.width - 2 * m.sidelineMarkInset) * sz);
  }
  glow(p.markBlur);
  for (let yard = 1; yard < 100; yard++) {
    if (yard % 5 === 0) continue;
    const x = X(yard - 50) - lineX / 2;
    for (const sign of [-1, 1] as const) {
      const hashInner = sign * m.hashInner;
      const hashOuter = sign * (m.hashInner + m.hashLength);
      ctx.fillRect(x, Z(Math.min(hashInner, hashOuter)), lineX, Math.max(2.4, m.hashLength * sz));
      const edgeNear = sign * (hw - m.sidelineMarkInset);
      const edgeFar = sign * (hw - m.sidelineMarkInset - m.sidelineMarkLength);
      ctx.fillRect(x, Z(Math.min(edgeNear, edgeFar)), lineX, Math.max(2.4, m.sidelineMarkLength * sz));
    }
  }
  if (m.tryMark) {
    for (const yard of [m.tryMark.fromGoal, 100 - m.tryMark.fromGoal]) {
      ctx.fillRect(X(yard - 50) - lineX / 2, Z(-m.tryMark.length / 2), lineX, m.tryMark.length * sz);
    }
  }
  ctx.shadowBlur = 0;

  if (!fontsReady) return;
  // Numbers read from their own sideline; arrows point toward the nearer goal line (none at the 50).
  ctx.fillStyle = p.number;
  glow(p.numberBlur);
  const fontPx = (m.numberHeight / 0.727) * sz; // Inter's cap height is about 0.727 em
  ctx.font = `600 ${fontPx}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  const digitPx = ctx.measureText('0').width;
  const scaleX = (m.numberDigitWidth * sx) / digitPx;
  const gap = (0.4 * sx) / scaleX;
  for (const { yard, label } of NUMBERED_LINES) {
    for (const sign of [1, -1] as const) {
      ctx.save();
      ctx.translate(X(yard - 50), Z(sign * (hw - m.numberNear)));
      if (sign === -1) ctx.rotate(Math.PI);
      ctx.scale(scaleX, 1);
      ctx.textAlign = 'right';
      ctx.fillText(label[0], -gap, 0);
      ctx.textAlign = 'left';
      ctx.fillText(label[1], gap, 0);
      if (yard !== 50) {
        const toward = (yard < 50 ? -1 : 1) * sign;
        const base = toward * (gap + digitPx + (0.55 * sx) / scaleX);
        const tip = base + toward * ((0.97 * sx) / scaleX);
        const y = -m.numberHeight * sz * 0.74;
        const half = 0.25 * sz;
        ctx.beginPath();
        ctx.moveTo(tip, y);
        ctx.lineTo(base, y - half);
        ctx.lineTo(base, y + half);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }
  ctx.shadowBlur = 0;
}

const fieldTextures = new Map<string, THREE.CanvasTexture>();

export function getFieldTexture(league: LeagueId, maxAnisotropy: number, style: FieldStyle = 'holo'): THREE.CanvasTexture {
  const key = `${league}|${style}`;
  let texture = fieldTextures.get(key);
  if (!texture) {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const m = markingsFor(league);
    paintField(canvas, m, style);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
    if (!fontsReady) {
      afterFonts.push(() => {
        paintField(canvas, m, style);
        t.needsUpdate = true;
      });
    }
    fieldTextures.set(key, t);
    texture = t;
  }
  return texture;
}

// ---------------------------------------------------------------- end zones

interface EndZoneEntry {
  texture: THREE.CanvasTexture;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const endZones = new Map<string, EndZoneEntry>();

export type EndZoneSide = 'left' | 'right';
export type TextureLevel = 'high' | 'low';

/** The word painted in an end zone: the team's short name when it is short and plain, otherwise its abbreviation. */
export function endZoneWordmark(team: Team): string {
  const upper = (team.shortName ?? '').trim().toUpperCase();
  return upper && upper.length <= 12 && /^[A-Z0-9 .&'-]+$/.test(upper) ? upper : team.abbreviation.toUpperCase();
}

export const endZoneKey = (team: Team, side: EndZoneSide, level: TextureLevel, style: FieldStyle = 'holo') =>
  `${team.key}|${team.color ?? ''}|${endZoneWordmark(team)}|${side}|${level}|${style}`;

function paintEndZone(canvas: HTMLCanvasElement, team: Team, side: EndZoneSide, style: FieldStyle) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const m = markingsFor(team.league);
  const w = canvas.width;
  const h = canvas.height;
  const sx = w / 10;
  const sz = h / m.width;
  const holo = style === 'holo';
  const accent = accentFor(team.color, true);
  const tint = endZoneTint(team.color);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowBlur = 0;

  if (holo) {
    // Dark glass lit from the goal line in the team's colour, with a fine neon hatch.
    const toward = ctx.createLinearGradient(side === 'left' ? 0 : w, 0, side === 'left' ? w : 0, 0);
    toward.addColorStop(0, mixColor(accent, '#020a06', 0.84));
    toward.addColorStop(1, mixColor(accent, '#020a06', 0.6));
    ctx.fillStyle = toward;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.strokeStyle = withAlpha(accent, 0.16);
    ctx.lineWidth = Math.max(1, sx * 0.12);
    const run = (h / sz) * sx;
    for (let x = -run; x < w + run; x += sx * 1.4) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + run, h);
      ctx.stroke();
    }
    ctx.restore();
  } else {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ffffff';
    for (let z = 0; z < h; z += sz * 2) ctx.fillRect(0, z, w, sz);
    ctx.restore();
  }

  ctx.fillStyle = holo ? 'rgba(214, 255, 236, 0.97)' : 'rgba(246, 250, 244, 0.95)';
  if (holo) {
    ctx.shadowColor = withAlpha(accent, 0.95);
    ctx.shadowBlur = 16;
  }
  const goal = Math.max(3, m.goalLineWidth * sx * 1.2);
  const line = Math.max(2, m.lineWidth * sx);
  const lineZ = Math.max(2, m.lineWidth * sz);
  if (side === 'left') {
    ctx.fillRect(w - goal, 0, goal, h);
    ctx.fillRect(0, 0, line, h);
  } else {
    ctx.fillRect(0, 0, goal, h);
    ctx.fillRect(w - line, 0, line, h);
  }
  ctx.fillRect(0, 0, w, lineZ);
  ctx.fillRect(0, h - lineZ, w, lineZ);
  ctx.shadowBlur = 0;

  if (!fontsReady) return;
  const text = endZoneWordmark(team);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  // Readable from midfield: letters stand up toward the end line.
  ctx.rotate(side === 'left' ? -Math.PI / 2 : Math.PI / 2);
  ctx.scale(sz / sx, 1);
  let fontPx = (4.2 * sx) / 0.727;
  ctx.font = `700 ${fontPx}px ${FONT}`;
  const widthYards = ctx.measureText(text).width / sx;
  if (widthYards > 42) {
    fontPx *= 42 / widthYards;
    ctx.font = `700 ${fontPx}px ${FONT}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (holo) {
    ctx.shadowColor = withAlpha(accent, 1);
    ctx.shadowBlur = 22;
    ctx.fillStyle = 'rgba(240, 255, 248, 0.96)';
  } else ctx.fillStyle = luminance(tint) > 0.35 ? 'rgba(15, 23, 18, 0.8)' : 'rgba(246, 250, 244, 0.92)';
  ctx.fillText(text, 0, fontPx * 0.04);
  ctx.restore();
  ctx.shadowBlur = 0;
}

export function acquireEndZone(team: Team, side: EndZoneSide, level: TextureLevel, style: FieldStyle = 'holo'): THREE.CanvasTexture {
  const key = endZoneKey(team, side, level, style);
  let entry = endZones.get(key);
  if (!entry) {
    const canvas = document.createElement('canvas');
    canvas.width = level === 'high' ? 256 : 128;
    canvas.height = level === 'high' ? 1024 : 512;
    paintEndZone(canvas, team, side, style);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    if (!fontsReady) {
      afterFonts.push(() => {
        paintEndZone(canvas, team, side, style);
        texture.needsUpdate = true;
      });
    }
    entry = { texture, refs: 0, timer: null };
    endZones.set(key, entry);
  }
  return entry.texture;
}

export function retainEndZone(key: string) {
  const entry = endZones.get(key);
  if (!entry) return;
  entry.refs++;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

export function releaseEndZone(key: string) {
  const entry = endZones.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && !entry.timer) {
    entry.timer = setTimeout(() => {
      if (entry.refs > 0) return;
      entry.texture.dispose();
      endZones.delete(key);
    }, 30_000);
  }
}

// ---------------------------------------------------------------- soft sprites and light ramps

function radialTexture(stops: Array<[number, string]>, size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let halo: THREE.CanvasTexture | null = null;
let shadow: THREE.CanvasTexture | null = null;
let spark: THREE.CanvasTexture | null = null;

export const haloTexture = () =>
  (halo ??= radialTexture([
    [0, 'rgba(190, 248, 222, 0.9)'],
    [0.28, 'rgba(110, 231, 183, 0.45)'],
    [1, 'rgba(110, 231, 183, 0)'],
  ]));

export const shadowTexture = () =>
  (shadow ??= radialTexture([
    [0, 'rgba(0, 0, 0, 0.6)'],
    [0.55, 'rgba(0, 0, 0, 0.32)'],
    [1, 'rgba(0, 0, 0, 0)'],
  ]));

/** A white point of light for sparks and seat lights; materials tint it. */
export const sparkTexture = () =>
  (spark ??= radialTexture(
    [
      [0, 'rgba(255, 255, 255, 1)'],
      [0.22, 'rgba(255, 255, 255, 0.75)'],
      [1, 'rgba(255, 255, 255, 0)'],
    ],
    64,
  ));

export type FadeKind = 'up' | 'down' | 'along';
const fades = new Map<FadeKind, THREE.CanvasTexture>();

/**
 * White light ramps that materials tint: 'up' is bright at the base (v = 0) and
 * fades upward (laser sheets, beams); 'down' is bright at the top (tower cones);
 * 'along' brightens from u = 0 to u = 1 (trails, drawn toward the ball).
 */
export function fadeTexture(kind: FadeKind): THREE.CanvasTexture {
  let texture = fades.get(kind);
  if (!texture) {
    const canvas = document.createElement('canvas');
    const along = kind === 'along';
    canvas.width = along ? 256 : 4;
    canvas.height = along ? 4 : 256;
    const ctx = canvas.getContext('2d')!;
    const g = along ? ctx.createLinearGradient(0, 0, canvas.width, 0) : ctx.createLinearGradient(0, canvas.height, 0, 0);
    if (kind === 'along') {
      g.addColorStop(0, 'rgba(255, 255, 255, 0.04)');
      g.addColorStop(0.7, 'rgba(255, 255, 255, 0.55)');
      g.addColorStop(1, 'rgba(255, 255, 255, 1)');
    } else if (kind === 'up') {
      g.addColorStop(0, 'rgba(255, 255, 255, 1)');
      g.addColorStop(0.18, 'rgba(255, 255, 255, 0.5)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    } else {
      g.addColorStop(0, 'rgba(255, 255, 255, 0)');
      g.addColorStop(0.75, 'rgba(255, 255, 255, 0.35)');
      g.addColorStop(1, 'rgba(255, 255, 255, 1)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    fades.set(kind, texture);
  }
  return texture;
}
