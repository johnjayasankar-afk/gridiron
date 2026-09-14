/**
 * Starts the production build in replay mode for the end-to-end suite.
 * Builds first unless GRIDIRON_E2E_SKIP_BUILD=1 and a build already exists.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const port = process.env.GRIDIRON_E2E_PORT ?? '8795';
const built = existsSync('dist/index.html') && existsSync('dist-server/index.mjs');

if (!(built && process.env.GRIDIRON_E2E_SKIP_BUILD === '1')) {
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const server = spawn(process.execPath, ['dist-server/index.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: port,
    HOST: '127.0.0.1',
    GRIDIRON_PROVIDER: 'replay',
    GRIDIRON_CACHE_DIR: 'off',
    GRIDIRON_MAX_REPLAY_SESSIONS: '200',
  },
});

const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
