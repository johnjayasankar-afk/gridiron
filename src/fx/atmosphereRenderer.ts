/**
 * The page atmosphere: a night stadium drawn by one small fragment shader behind
 * the interface. A perspective grid floor runs to a glowing horizon, two light
 * beams sweep slowly from the rim, and dust drifts through them. It is
 * decoration only and never shows data.
 *
 * It uses raw WebGL (no three.js) so it ships with the first paint, renders at
 * reduced resolution and about 30 frames a second, pauses while the tab is
 * hidden, and holds a still frame when motion is reduced or effects are not Full.
 * Colours come from CSS tokens (--atmo-*), so both appearances share the shader.
 */

const VERTEX = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT = `
precision mediump float;
uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uPointer;
uniform float uScroll;
uniform vec3 uBg;
uniform vec3 uGrid;
uniform vec3 uBeam;
uniform float uStrength;
uniform float uBeams;
uniform float uVignette;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float beam(vec2 p, vec2 origin, float angle, float spread) {
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 v = p - origin;
  float along = dot(v, dir);
  if (along <= 0.0) return 0.0;
  float perp = length(v - dir * along);
  float width = 0.015 + along * spread;
  return exp(-(perp * perp) / (width * width)) * exp(-along * 0.55) * smoothstep(0.0, 0.25, along);
}

void main() {
  vec2 res = uResolution;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  p += uPointer * vec2(0.03, 0.018);
  float horizon = 0.06 - uScroll * 0.1;
  vec3 col = uBg;

  float sky = clamp(1.0 - (p.y - horizon) * 1.6, 0.0, 1.0);
  col = mix(col, uGrid, 0.035 * sky * sky * uStrength);

  float band = exp(-abs(p.y - horizon) * 22.0);
  col = mix(col, uGrid, 0.22 * band * uStrength);

  float below = horizon - p.y;
  if (below > 0.002) {
    float depth = 0.32 / below;
    vec2 g = vec2(p.x * depth * 1.4, depth + uTime * 0.18);
    vec2 d = 0.5 - abs(fract(g) - 0.5);
    float px = 1.0 / res.y;
    float wx = depth * 1.4 * px * 1.3;
    float wz = (0.32 / (below * below)) * px * 1.3;
    float lx = 1.0 - smoothstep(0.0, wx + 0.002, d.x);
    float lz = 1.0 - smoothstep(0.0, wz + 0.002, d.y);
    float fade = exp(-depth * 0.09) * smoothstep(0.0, 0.05, below);
    col = mix(col, uGrid, max(lx, lz) * 0.28 * fade * uStrength);
    col = mix(col, uGrid, 0.05 * exp(-below * 6.0) * uStrength);
  }

  float t = uTime * 0.05;
  float beams = beam(p, vec2(-1.05, 0.72), -0.62 + sin(t * 1.3) * 0.08, 0.16)
    + beam(p, vec2(1.05, 0.72), 3.14159 + 0.62 + sin(t * 1.1 + 2.0) * 0.08, 0.16);
  col = mix(col, uBeam, clamp(beams * 0.16 * uBeams, 0.0, 1.0));

  vec2 q = gl_FragCoord.xy / (46.0 * res.y / 900.0);
  q.y -= uTime * 0.45;
  vec2 cell = floor(q);
  vec2 f = fract(q) - 0.5;
  float h = hash(cell);
  vec2 offset = vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5;
  float dist = length(f - offset * 0.6);
  float twinkle = 0.55 + 0.45 * sin(uTime * (0.8 + h * 2.4) + h * 40.0);
  float dust = smoothstep(0.075, 0.0, dist) * step(0.86, h) * twinkle;
  col = mix(col, uBeam, clamp(dust * (0.1 + beams * 1.4) * uStrength * uBeams, 0.0, 1.0));

  vec2 uv = gl_FragCoord.xy / res;
  float vig = smoothstep(1.3, 0.35, length((uv - vec2(0.5, 0.55)) * vec2(1.1, 1.0)));
  col *= mix(1.0 - 0.22 * uVignette, 1.0, vig);
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

type Rgb = [number, number, number];

interface Palette {
  bg: Rgb;
  grid: Rgb;
  beam: Rgb;
  strength: number;
  beams: number;
  vignette: number;
}

const UNIFORMS = ['uTime', 'uResolution', 'uPointer', 'uScroll', 'uBg', 'uGrid', 'uBeam', 'uStrength', 'uBeams', 'uVignette'] as const;
type UniformName = (typeof UNIFORMS)[number];

export function parseCssColor(value: string, fallback: Rgb): Rgb {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i.exec(v);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  return fallback;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const num = (name: string, fallback: number) => {
    const n = parseFloat(css.getPropertyValue(name));
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    bg: parseCssColor(css.getPropertyValue('--atmo-bg'), [0.016, 0.04, 0.027]),
    grid: parseCssColor(css.getPropertyValue('--atmo-grid'), [0.43, 0.9, 0.72]),
    beam: parseCssColor(css.getPropertyValue('--atmo-beam'), [0.79, 0.98, 0.9]),
    strength: num('--atmo-strength', 1),
    beams: num('--atmo-beams', 1),
    vignette: num('--atmo-vignette', 1),
  };
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create a shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Atmosphere shader failed to compile: ${log ?? 'unknown error'}`);
  }
  return shader;
}

export class Atmosphere {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly uniforms: Record<UniformName, WebGLUniformLocation | null>;
  private readonly scale: number;
  private readonly frameMs: number;
  private readonly started = performance.now();
  private readonly cleanups: Array<() => void> = [];
  private palette: Palette;
  private animate: boolean;
  private raf = 0;
  private last = 0;
  private pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  private scroll = 0;
  private disposed = false;

  /** Returns null when WebGL is unavailable; the CSS background then stands in. */
  static create(canvas: HTMLCanvasElement, animate: boolean): Atmosphere | null {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl) return null;
    try {
      return new Atmosphere(canvas, gl, animate);
    } catch (error) {
      console.warn('Gridiron: the page atmosphere is off.', error);
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, animate: boolean) {
    this.canvas = canvas;
    this.gl = gl;
    this.animate = animate;
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    if (!program || !buffer) throw new Error('Could not allocate WebGL resources');
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Atmosphere program failed to link: ${gl.getProgramInfoLog(program) ?? ''}`);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.program = program;
    this.buffer = buffer;
    this.uniforms = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<UniformName, WebGLUniformLocation | null>;

    // Software renderers (headless browsers, some virtual machines) get a smaller, slower budget.
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const software = /swiftshader|llvmpipe|software/i.test(renderer);
    this.scale = software ? 0.35 : 0.5;
    this.frameMs = software ? 66 : 33;
    this.palette = readPalette();

    this.listen(window, 'resize', () => this.resize());
    this.listen(document, 'visibilitychange', () => this.sync());
    this.listen(window, 'scroll', () => {
      this.scroll = Math.min(1, window.scrollY / Math.max(1, window.innerHeight * 2));
    });
    this.listen(window, 'pointermove', (event) => {
      const e = event as PointerEvent;
      this.pointer.tx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
      this.pointer.ty = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
    });
    this.listen(canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      this.dispose();
      canvas.style.display = 'none';
    });
    const themeObserver = new MutationObserver(() => {
      requestAnimationFrame(() => {
        if (this.disposed) return;
        this.palette = readPalette();
        if (!this.animate) this.draw(performance.now());
      });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.cleanups.push(() => themeObserver.disconnect());

    this.resize();
    this.sync();
  }

  setAnimate(animate: boolean) {
    if (this.animate === animate) return;
    this.animate = animate;
    this.sync();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanups.forEach((fn) => fn());
    const gl = this.gl;
    if (!gl.isContextLost()) {
      gl.deleteBuffer(this.buffer);
      gl.deleteProgram(this.program);
    }
  }

  private listen(target: Window | Document | HTMLElement, type: string, handler: (event: Event) => void) {
    target.addEventListener(type, handler, { passive: type !== 'webglcontextlost' });
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(window.innerWidth * dpr * this.scale));
    const height = Math.max(1, Math.round(window.innerHeight * dpr * this.scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
    }
    if (!this.animate) this.draw(performance.now());
  }

  /** Runs the loop only while animating and visible; otherwise leaves one still frame. */
  private sync() {
    if (this.disposed) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.animate && document.visibilityState === 'visible') this.raf = requestAnimationFrame(this.loop);
    else this.draw(performance.now());
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (now - this.last < this.frameMs) return;
    this.last = now;
    this.draw(now);
  };

  private draw(now: number) {
    if (this.disposed || this.gl.isContextLost()) return;
    const { gl, uniforms: u, palette: c, pointer } = this;
    pointer.x += (pointer.tx - pointer.x) * 0.06;
    pointer.y += (pointer.ty - pointer.y) * 0.06;
    gl.uniform1f(u.uTime, this.animate ? (now - this.started) / 1000 : 14);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uPointer, this.animate ? pointer.x : 0, this.animate ? -pointer.y : 0);
    gl.uniform1f(u.uScroll, this.animate ? this.scroll : 0);
    gl.uniform3f(u.uBg, c.bg[0], c.bg[1], c.bg[2]);
    gl.uniform3f(u.uGrid, c.grid[0], c.grid[1], c.grid[2]);
    gl.uniform3f(u.uBeam, c.beam[0], c.beam[1], c.beam[2]);
    gl.uniform1f(u.uStrength, c.strength);
    gl.uniform1f(u.uBeams, c.beams);
    gl.uniform1f(u.uVignette, c.vignette);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
