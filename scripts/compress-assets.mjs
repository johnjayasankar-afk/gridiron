/**
 * Writes Brotli and gzip copies of the built text assets, so the Node server
 * can send compressed files without compressing on every request. Vercel
 * compresses responses itself, so the step is skipped there.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const TYPES = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt']);
const MIN_BYTES = 1024;

if (process.env.VERCEL) {
  console.log('compress-assets: skipped (Vercel compresses responses itself)');
  process.exit(0);
}

let files = 0;
let original = 0;
let brotli = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!TYPES.has(extname(path)) || stat.size < MIN_BYTES) continue;
    const input = readFileSync(path);
    const br = brotliCompressSync(input, {
      params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: input.length },
    });
    const gz = gzipSync(input, { level: 9 });
    // A copy that saves almost nothing is not worth a second file.
    if (br.length < input.length * 0.9) writeFileSync(`${path}.br`, br);
    if (gz.length < input.length * 0.9) writeFileSync(`${path}.gz`, gz);
    files++;
    original += input.length;
    brotli += Math.min(br.length, input.length);
  }
}

walk(DIST);
const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`compress-assets: ${files} files, ${kb(original)} to ${kb(brotli)} with Brotli`);
