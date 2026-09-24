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

function paintField(canvas: HTMLCanvasElement, m: FieldMarkings, style: FieldStyle, surface: FieldSurface) {
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

  /*
   * Turf: end zones, then the field between the goal lines.
   *
   * Mowing stripes are a grass field's: a mower laying the blades one way and
   * then the other is what makes them, and an artificial surface has no blades
   * to lay. The provider reports which a venue has, so a synthetic field is
   * drawn as one flat weave with a seam every five yards where its rolls meet,
   * and a grass field keeps its stripes. Where the surface is not reported the
   * field is striped, which is what every field looked like before it was.
   */
  ctx.fillStyle = p.endZone;
  ctx.fillRect(X(-60), Z(-hw), 10 * sx, m.width * sz);
  ctx.fillRect(X(50), Z(-hw), 10 * sx, m.width * sz);
  const mown = surface !== 'turf';
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = mown ? p.stripes[i % 2] : p.stripes[0];
    ctx.fillRect(X(-50 + i * 5), Z(-hw), 5 * sx + 1, m.width * sz);
  }
  let seed = m.league === 'nfl' ? 1979 : 1869;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  // A synthetic surface is more uniform than grass, and its roll seams are the one line across it.
  const speckles = mown ? p.speckles : Math.round(p.speckles * 1.5);
  for (let i = 0; i < speckles; i++) {
    ctx.fillStyle = rand() > 0.5 ? p.speckle[0] : p.speckle[1];
    ctx.fillRect(X(-60) + rand() * 120 * sx, Z(-hw) + rand() * m.width * sz, mown ? 1.6 : 1.1, mown ? 1.6 : 1.1);
  }
  if (!mown) {
    ctx.fillStyle = p.stripes[1];
    ctx.globalAlpha = 0.5;
    for (let i = 1; i < 20; i++) ctx.fillRect(X(-50 + i * 5) - 0.5, Z(-hw), 1, m.width * sz);
    ctx.globalAlpha = 1;
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

/** What a venue is played on, where the provider says; null where it does not. */
export type FieldSurface = 'grass' | 'turf' | null;

export function getFieldTexture(league: LeagueId, maxAnisotropy: number, style: FieldStyle = 'holo', surface: FieldSurface = null): THREE.CanvasTexture {
  const key = `${league}|${style}|${surface ?? 'unknown'}`;
  let texture = fieldTextures.get(key);
  if (!texture) {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const m = markingsFor(league);
    paintField(canvas, m, style, surface);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
    if (!fontsReady) {
      afterFonts.push(() => {
        paintField(canvas, m, style, surface);
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
let pool: THREE.CanvasTexture | null = null;

/**
 * The soft mark under the ball. It is white so the material can tint it, because
 * it carries the colour of whichever team the provider says has the ball; a
 * coloured ramp multiplied by a team's colour came out muddy.
 */
export const haloTexture = () =>
  (halo ??= radialTexture([
    [0, 'rgba(255, 255, 255, 0.9)'],
    [0.28, 'rgba(255, 255, 255, 0.45)'],
    [1, 'rgba(255, 255, 255, 0)'],
  ]));

export const shadowTexture = () =>
  (shadow ??= radialTexture([
    [0, 'rgba(0, 0, 0, 0.6)'],
    [0.55, 'rgba(0, 0, 0, 0.32)'],
    [1, 'rgba(0, 0, 0, 0)'],
  ]));

/**
 * The wide, soft pool a floodlight throws on the ground. Far gentler than the
 * spark: a field lit by towers is bright under them and falls away, and without
 * it a holographic field reads as lighting itself.
 */
export const poolTexture = () =>
  (pool ??= radialTexture(
    [
      [0, 'rgba(255, 255, 255, 0.9)'],
      [0.42, 'rgba(255, 255, 255, 0.42)'],
      [0.76, 'rgba(255, 255, 255, 0.13)'],
      [1, 'rgba(255, 255, 255, 0)'],
    ],
    256,
  ));

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

// ---------------------------------------------------------------- the ball's own skin

/*
 * A football wearing the mark of the team the provider says has it.
 *
 * Real footballs carry no team mark, and this one is not pretending to: the
 * field is a schematic, and a ball that says whose it is answers the question
 * every card is asked first. It is only ever built for the game page, where the
 * ball is big enough for a mark to be read; a card says the same thing with the
 * colour of the arrow and of the mark on the ground.
 *
 * The lathe the ball is built from lays its texture out with u running around
 * the ball and v along it. The laces sit at u = 0.75, so the two decals go at
 * 0.60 and 0.90: on the upper flanks either side of the laces, which is what an
 * elevated camera sees. They sit on a light disc, because a team's own logo is
 * often its own colour and would vanish on a disc of it.
 */
const LEATHER = '#7b4a2a';
const BALL_SKIN_W = 512;
const BALL_SKIN_H = 256;

const logoImages = new Map<string, HTMLImageElement | 'failed'>();

function loadLogo(url: string, onReady: () => void): HTMLImageElement | null {
  const cached = logoImages.get(url);
  if (cached) return cached === 'failed' ? null : cached;
  const image = new Image();
  // Without this the texture is tainted and the whole canvas is unusable; with
  // it a provider that does not allow it simply fails to load and the ball
  // wears the team's letters instead.
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    logoImages.set(url, image);
    onReady();
  };
  image.onerror = () => {
    logoImages.set(url, 'failed');
  };
  image.src = url;
  return null;
}

function paintBallSkin(canvas: HTMLCanvasElement, team: Team, logo: HTMLImageElement | null) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = LEATHER;
  ctx.fillRect(0, 0, w, h);

  // Pebble grain, deterministic so the same team is the same ball every time.
  let seed = 4157;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255, 238, 220, 0.05)' : 'rgba(28, 12, 4, 0.1)';
    ctx.fillRect(rand() * w, rand() * h, 2, 2);
  }

  const accent = accentFor(team.color, false);
  for (const u of [0.6, 0.9]) {
    const size = Math.min(w * 0.16, h * 0.34);
    ctx.save();
    ctx.translate(u * w, h * 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.66, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(247, 250, 246, 0.95)';
    ctx.fill();
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.strokeStyle = withAlpha(accent, 0.95);
    ctx.stroke();
    if (logo) ctx.drawImage(logo, -size * 0.45, -size * 0.45, size * 0.9, size * 0.9);
    else if (fontsReady) {
      ctx.fillStyle = accent;
      ctx.font = `700 ${Math.round(size * 0.44)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(team.abbreviation.slice(0, 3), 0, size * 0.03);
    }
    ctx.restore();
  }
}

interface SkinEntry {
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  /** The logo this ball was painted with, so a later one can replace letters. */
  logoUrl: string | null;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const ballSkins = new Map<string, SkinEntry>();

/*
 * Keyed on the team and its colour, and deliberately NOT on the logo's address.
 * The provider hands out more than one address for the same mark: a game page
 * starts with `500/ari.png` from the scoreboard and is given
 * `500/scoreboard/ari.png` once the game's own detail arrives. Keying on the
 * address meant every ball was painted twice and every logo fetched twice, for
 * two files of the same picture.
 */
export const ballSkinKey = (team: Team): string => `${team.key}|${team.color ?? ''}`;

export function acquireBallSkin(team: Team): THREE.CanvasTexture {
  const key = ballSkinKey(team);
  let entry = ballSkins.get(key);
  const paint = (into: SkinEntry) => {
    into.logoUrl = team.logo ?? null;
    paintBallSkin(into.canvas, team, team.logo ? loadLogo(team.logo, () => paint(into)) : null);
    into.texture.needsUpdate = true;
    notifyChanged();
  };
  if (!entry) {
    const canvas = document.createElement('canvas');
    canvas.width = BALL_SKIN_W;
    canvas.height = BALL_SKIN_H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    entry = { texture, canvas, logoUrl: null, refs: 0, timer: null };
    ballSkins.set(key, entry);
    paint(entry);
    if (!fontsReady) afterFonts.push(() => paint(entry!));
  } else if (!entry.logoUrl && team.logo) {
    // A mark arrived after the ball had been drawn with the team's letters.
    paint(entry);
  }
  return entry.texture;
}

export function retainBallSkin(key: string) {
  const entry = ballSkins.get(key);
  if (!entry) return;
  entry.refs++;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

export function releaseBallSkin(key: string) {
  const entry = ballSkins.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && !entry.timer) {
    entry.timer = setTimeout(() => {
      if (entry.refs > 0) return;
      entry.texture.dispose();
      ballSkins.delete(key);
    }, 30_000);
  }
}

// ---------------------------------------------------------------- the mark at midfield

/*
 * The home team's mark at the fifty.
 *
 * It is the one thing that makes a real field that team's field, and without it
 * every game in the app was played on the same field with different end zones.
 * It is the same liberty the end zones already take: the provider does not say
 * what is painted at midfield, and this is a schematic field, but a home team is
 * reported and its mark is the convention every real field follows.
 *
 * Painted into the turf rather than sat on top of it: on grass it is ink at part
 * strength, and on the holographic field the material adds it as light instead.
 * Drawn per team and per style, and reference counted like the end zones, so a
 * slate of thirteen games keeps thirteen of them and no more.
 */
/** A card draws the mark about sixty pixels across; the game page draws it large. */
const MIDFIELD_PX = { high: 512, low: 256 } as const;
const midfields = new Map<string, { texture: THREE.CanvasTexture; canvas: HTMLCanvasElement; logoUrl: string | null; refs: number; timer: ReturnType<typeof setTimeout> | null }>();

export const midfieldKey = (team: Team, style: FieldStyle, level: TextureLevel): string => `${team.key}|${team.color ?? ''}|${style}|${level}`;

function paintMidfield(canvas: HTMLCanvasElement, team: Team, style: FieldStyle, logo: HTMLImageElement | null) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const holo = style === 'holo';
  const accent = accentFor(team.color, holo);

  if (logo) {
    // A logo is drawn as it is and then knocked back, so a team's own colours
    // survive. Turf shows through it either way.
    ctx.globalAlpha = holo ? 0.72 : 0.5;
    ctx.drawImage(logo, size * 0.06, size * 0.06, size * 0.88, size * 0.88);
    ctx.globalAlpha = 1;
    return;
  }
  if (!fontsReady) return;
  // No logo: the team's letters in a ring, which is the other thing real fields
  // paint at the fifty.
  ctx.strokeStyle = withAlpha(accent, holo ? 0.75 : 0.5);
  ctx.lineWidth = size * 0.035;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = withAlpha(accent, holo ? 0.82 : 0.55);
  ctx.font = `700 ${Math.round(size * 0.3)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(team.abbreviation.slice(0, 4), size / 2, size / 2 + size * 0.02);
}

export function acquireMidfield(team: Team, style: FieldStyle, level: TextureLevel): THREE.CanvasTexture {
  const key = midfieldKey(team, style, level);
  let entry = midfields.get(key);
  // The dark variant is the one made for a dark background, which is what the
  // holographic field is.
  const url = (style === 'holo' ? (team.logoDark ?? team.logo) : team.logo) ?? null;
  const paint = (into: NonNullable<typeof entry>) => {
    into.logoUrl = url;
    paintMidfield(into.canvas, team, style, url ? loadLogo(url, () => paint(into)) : null);
    into.texture.needsUpdate = true;
    notifyChanged();
  };
  if (!entry) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = MIDFIELD_PX[level];
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    entry = { texture, canvas, logoUrl: null, refs: 0, timer: null };
    midfields.set(key, entry);
    paint(entry);
    if (!fontsReady) afterFonts.push(() => paint(entry!));
  } else if (!entry.logoUrl && url) paint(entry);
  return entry.texture;
}

export function retainMidfield(key: string) {
  const entry = midfields.get(key);
  if (!entry) return;
  entry.refs++;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

export function releaseMidfield(key: string) {
  const entry = midfields.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && !entry.timer) {
    entry.timer = setTimeout(() => {
      if (entry.refs > 0) return;
      entry.texture.dispose();
      midfields.delete(key);
    }, 30_000);
  }
}

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
