/**
 * Is scrolling smooth, and what does it cost? Run against a built server.
 *
 *   npm run build && GRIDIRON_PROVIDER=replay node dist-server/index.mjs
 *   node scripts/scroll-perf.mjs http://127.0.0.1:8787/
 *   node scripts/scroll-perf.mjs --idle http://127.0.0.1:8787/
 *   node scripts/scroll-perf.mjs A B          # two builds, interleaved
 *
 *   CPU=4      throttle the main thread, which is where problems show
 *   ROUNDS=11  more rounds; fewer than about nine cannot resolve anything
 *   SPEED=5000 a hard flick rather than a scroll
 *
 * The headline number is **pixels per redraw**: how far the page moves between
 * two frames of the field canvas. The canvas is fixed to the viewport and each
 * field is scissored to its card's rectangle, so that distance is exactly how
 * far a field can sit from the card it belongs to. Under about 25px it is not
 * visible; at 60fps and a normal scroll it lands there on its own.
 *
 * Two warnings, both learned the hard way.
 *
 * Nine rounds minimum. At five rounds this harness reported a change as 94%
 * worse and then, at eleven, as no difference at all. A live replay makes the
 * page busy in ways that vary run to run, and a single number from a short run
 * is worth nothing.
 *
 * Interleave. Two measurements of the SAME build taken one after the other can
 * differ by a third on a busy machine. Pass two URLs and it alternates them.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ARGS = process.argv.slice(2);
const IDLE = ARGS.includes('--idle');
const BASES = ARGS.filter((a) => a.startsWith('http'));
const ROUNDS = Number(process.env.ROUNDS || 9);
const CPU = Number(process.env.CPU || 4);
const SPEED = Number(process.env.SPEED || 1500);
const SECS = Number(process.env.SECS || 6);
const PORT = Number(process.env.CDP_PORT || 9521);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!BASES.length) {
  console.error('usage: node scripts/scroll-perf.mjs [--idle] <url> [url]');
  process.exit(2);
}

const profile = join('/tmp', 'gridiron-perf-' + process.pid);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio',
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

async function endpoint() {
  for (let i = 0; i < 150; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(150); }
  }
  throw new Error('Chrome did not start. Set CHROME to its path.');
}

const ws = new WebSocket(await endpoint());
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const n = ++seq;
  waiting.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params, sessionId }));
});
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function open(base) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }).then((r) => r.result);
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }).then((r) => r.result);
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');
  await S('Performance.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (CPU > 1) await S('Emulation.setCPUThrottlingRate', { rate: CPU });
  await S('Page.navigate', { url: base });
  await sleep(13000);   // the slate has to arrive and the fields have to mount
  return { S, close: () => send('Target.closeTarget', { targetId }) };
}
const metrics = (S) => S('Performance.getMetrics').then((r) =>
  Object.fromEntries(r.result.metrics.map((m) => [m.name, m.value])));

/** A scroll, and what the canvas managed while it ran. */
async function scrollRun(base) {
  const { S, close } = await open(base);
  await S('Runtime.evaluate', { expression: `window.__L=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__L.push(e.duration);}).observe({type:'longtask'});}catch(e){}
    window.__f0 = window.__gridironGraphics ? window.__gridironGraphics.info().frames : 0;` });
  const y0 = await S('Runtime.evaluate', { expression: 'Math.round(scrollY)', returnByValue: true }).then((r) => r.result.result.value);
  for (let i = 0; i < 3; i++) {
    await S('Input.synthesizeScrollGesture', { x: 720, y: 450, xDistance: 0, yDistance: -1000, speed: SPEED, gestureSourceType: 'mouse' });
    await sleep(250);
  }
  await sleep(500);
  const y1 = await S('Runtime.evaluate', { expression: 'Math.round(scrollY)', returnByValue: true }).then((r) => r.result.result.value);
  const r = await S('Runtime.evaluate', { expression: `JSON.stringify({long:window.__L.map(Math.round), frames:(window.__gridironGraphics?window.__gridironGraphics.info().frames:0)-window.__f0})`, returnByValue: true })
    .then((x) => JSON.parse(x.result.result.value));
  await close();
  const px = Math.abs(y1 - y0);
  return { perFrame: r.frames ? px / r.frames : 9999, frames: r.frames, px,
    long: r.long.length, longest: r.long.length ? Math.max(...r.long) : 0,
    blocked: r.long.reduce((a, b) => a + b, 0) };
}

/** What the page costs while nobody touches it. */
async function idleRun(base) {
  const { S, close } = await open(base);
  const a = await metrics(S);
  await sleep(SECS * 1000);
  const b = await metrics(S);
  await close();
  return { layouts: (b.LayoutCount || 0) - (a.LayoutCount || 0),
    layoutMs: ((b.LayoutDuration || 0) - (a.LayoutDuration || 0)) * 1000,
    restyles: (b.RecalcStyleCount || 0) - (a.RecalcStyleCount || 0),
    script: ((b.ScriptDuration || 0) - (a.ScriptDuration || 0)) * 1000 };
}

const run = IDLE ? idleRun : scrollRun;
const results = [];
for (const base of BASES) {
  const runs = [];
  for (let i = 0; i < ROUNDS; i++) runs.push(await run(base));
  const g = (k) => median(runs.map((x) => x[k]));
  results.push({ base, runs, ...Object.fromEntries(Object.keys(runs[0]).map((k) => [k, g(k)])) });
}

console.log(`\n  ${ROUNDS} rounds each, CPU ${CPU}x${IDLE ? `, ${SECS}s idle` : `, three gestures at ${SPEED}px/s`}\n`);
if (IDLE) {
  console.log('  layouts  layoutMs  restyles   script   target');
  for (const r of results)
    console.log(`  ${String(r.layouts).padStart(7)} ${String(Math.round(r.layoutMs) + 'ms').padStart(9)} ${String(r.restyles).padStart(9)} ${String(Math.round(r.script) + 'ms').padStart(8)}   ${r.base}`);
} else {
  console.log('  px/redraw   frames  scrolled   long  longest  blocked   target');
  for (const r of results)
    console.log(`  ${String(Math.round(r.perFrame) + 'px').padStart(9)} ${String(r.frames).padStart(8)} ${String(r.px + 'px').padStart(9)} ${String(r.long).padStart(6)} ${String(Math.round(r.longest) + 'ms').padStart(8)} ${String(Math.round(r.blocked) + 'ms').padStart(8)}   ${r.base}`);
}
if (results.length === 2) {
  const key = IDLE ? 'layouts' : 'perFrame';
  const [a, b] = results;
  const delta = a[key] ? ((b[key] - a[key]) / a[key]) * 100 : 0;
  const spread = (r) => `${Math.min(...r.runs.map((x) => Math.round(x[key])))}..${Math.max(...r.runs.map((x) => Math.round(x[key])))}`;
  console.log(`\n  ${key}: A ${Math.round(a[key])} [${spread(a)}]   B ${Math.round(b[key])} [${spread(b)}]   ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`);
  console.log('  If those ranges overlap, this says nothing. Raise ROUNDS or find a quieter machine.');
}

ws.close();
chrome.kill();
for (let i = 0; i < 20; i++) {
  try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(100); }
}
