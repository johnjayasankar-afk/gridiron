#!/usr/bin/env node
// Bundles the Node server into dist-server/index.mjs. The server uses only Node built-ins,
// so the bundle has no runtime dependencies; fixtures/ ships beside it for the replay lab.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
