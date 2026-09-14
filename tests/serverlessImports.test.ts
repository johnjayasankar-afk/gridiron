/**
 * Vercel loads api/ and everything it imports as Node ES modules, one transpiled file at a time.
 * Node resolves only explicit paths, so every relative import in api/, server/ and shared/ names
 * its .js file. TypeScript, Vite, Vitest, tsx and esbuild all map that name to the .ts source.
 * scripts/check-serverless.mjs loads the function the same way to prove it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\1/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('serverless imports', () => {
  it('name the .js file they import, so plain Node can load them on Vercel', () => {
    const offenders: string[] = [];
    for (const dir of ['api', 'server', 'shared']) {
      for (const file of sources(join(ROOT, dir))) {
        for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
          if (!match[2].endsWith('.js')) offenders.push(`${relative(ROOT, file)}: ${match[2]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
