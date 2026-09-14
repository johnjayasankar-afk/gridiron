#!/usr/bin/env node
// One command for development: the API server (restarts on change) and the Vite client, together.
// Stopping this process stops both.
import { spawn } from 'node:child_process';

const shell = process.platform === 'win32';
const children = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit', shell, env: { ...process.env, GRIDIRON_STATIC_DIR: 'none' } }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit', shell }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 800).unref();
};
for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
