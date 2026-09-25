/**
 * React counts hooks. A hook written below a component's early returns is called
 * on the renders that fall through and skipped on the renders that do not, so the
 * first render to get past them calls one more than the render before it and the
 * whole view comes down with "Rendered more hooks than during the previous
 * render". It is a compile-clean, type-clean mistake that only shows up on the
 * exact load order that renders once before the data arrives.
 *
 * It has happened twice here. Once with the field's sound, and once with the
 * game as it stood at the play being looked at, which took down any game page
 * opened straight from its own address. Both were found by hand. This finds them.
 *
 * eslint-plugin-react-hooks catches this too, and this repo does not run it.
 * Until it does, the rule is held here, where it costs nothing to run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** A function declared at the left margin: a component, or a hook of this file's own. */
const FUNCTION_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\w+|const\s+\w+\s*=)/;
/** A statement at the body's own indent that leaves the function. */
const EARLY_RETURN = /^ {2}(?:if\s*\(.*\)\s*)?return[\s(;]/;
/** A hook called at the body's own indent. */
const HOOK_CALL = /^ {2}(?:(?:const|let)\s+[^=]+=\s*)?(use[A-Z]\w*)\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

describe('hook order', () => {
  it('no hook sits below a component early return, where it is called on some renders and not others', () => {
    const offenders: string[] = [];
    for (const file of sources(join(ROOT, 'src'))) {
      let returnedAt = -1;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // A new function at the left margin starts counting again.
          if (FUNCTION_START.test(line)) returnedAt = -1;
          else if (EARLY_RETURN.test(line)) returnedAt = i + 1;
          const hook = line.match(HOOK_CALL);
          if (hook && returnedAt > 0) offenders.push(`${relative(ROOT, file)}:${i + 1} ${hook[1]} is below the return on line ${returnedAt}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
