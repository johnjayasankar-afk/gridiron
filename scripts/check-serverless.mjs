#!/usr/bin/env node
/**
 * Checks the Vercel function the way Vercel runs it. Every TypeScript file under api/, server/
 * and shared/ is transpiled on its own, with no bundling, and plain Node loads the function as
 * an ES module. An import that Node cannot resolve, such as an extensionless relative path or a
 * JSON import, fails here instead of after a deploy.
 *
 *   node scripts/check-serverless.mjs          loads the function and checks its offline routes
 *   node scripts/check-serverless.mjs --live   also reads today's slate from ESPN and Kalshi
 */
import { transform } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.cache', 'serverless-check');
const live = process.argv.includes('--live');
const { compilerOptions } = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'));

rmSync(OUT, { recursive: true, force: true });
let files = 0;
async function transpile(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      await transpile(path);
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
    const { code } = await transform(readFileSync(path, 'utf8'), { loader: 'ts', format: 'esm', target: 'node20', sourcefile: path, tsconfigRaw: { compilerOptions } });
    const target = join(OUT, relative(ROOT, path)).replace(/\.ts$/, '.js');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);
    files++;
  }
}
for (const dir of ['api', 'server', 'shared']) await transpile(join(ROOT, dir));
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'module' }));

const failures = [];
const ok = (line) => console.log(`ok    ${line}`);

let handler;
try {
  ({ default: handler } = await import(pathToFileURL(join(OUT, 'api', '[...path].js')).href));
} catch (error) {
  console.error(`FAIL  the function did not load as an ES module: ${error.message}`);
  process.exit(1);
}
if (typeof handler !== 'function') {
  console.error('FAIL  api/[...path].ts has no default export function');
  process.exit(1);
}
ok(`${files} files transpiled one at a time and loaded by plain Node`);

const server = createServer((req, res) => {
  handler(req, res).catch((error) => {
    failures.push(`${req.url} threw: ${error.message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (path) => {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const health = await get('/api/health');
if (health.status === 200 && health.body?.transport === 'poll') ok(`health: version ${health.body.version}, transport poll, markets ${health.body.markets?.available ? 'on' : 'off'}`);
else failures.push(`/api/health answered ${health.status}: ${JSON.stringify(health.body)?.slice(0, 200)}`);

const stream = await get('/api/stream');
if (stream.status === 404) ok('stream: not offered, as a polled deployment should say');
else failures.push(`/api/stream answered ${stream.status}, expected 404`);

const party = await fetch(`${base}/api/party`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
if (party.status === 503) ok('watch parties: unavailable, with the reason');
else failures.push(`POST /api/party answered ${party.status}, expected 503`);

if (live) {
  const slate = await get('/api/slate');
  const games = Array.isArray(slate.body?.games) ? slate.body.games : [];
  if (slate.status === 200) ok(`slate: ${games.length} games on ${slate.body?.date}, ${games.filter((g) => g.market).length} with Kalshi prices`);
  else failures.push(`/api/slate answered ${slate.status}`);
  const priced = games.find((g) => g.market) ?? games[0];
  if (priced) {
    const game = await get(`/api/game/${encodeURIComponent(priced.id)}`);
    const points = game.body?.detail?.marketHistory?.points?.length ?? 0;
    if (game.status === 200) ok(`game ${priced.shortName ?? priced.id}: detail version ${game.body?.version}, ${points ? `${points} Kalshi prices in its history` : 'no Kalshi price history'}`);
    else failures.push(`/api/game/${priced.id} answered ${game.status}`);
  }
}

server.close();
for (const failure of failures) console.error(`FAIL  ${failure}`);
console.log(failures.length ? `\n${failures.length} check${failures.length === 1 ? '' : 's'} failed.` : '\nThe serverless function loads and answers as it will on Vercel.');
process.exit(failures.length ? 1 : 0);
