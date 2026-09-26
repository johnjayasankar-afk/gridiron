import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { absoluteMetaPlugin } from './scripts/html-meta.js';

const API = process.env.GRIDIRON_API ?? 'http://127.0.0.1:8787';
/*
 * Where this build will be served from, for the social metadata only. Open
 * Graph requires an absolute URL and no major unfurler resolves a relative one,
 * so a build for another host sets this rather than editing the shell. Empty
 * during development, where the shell's own relative paths are right.
 */
const ORIGIN = process.env.GRIDIRON_ORIGIN ?? (process.env.NODE_ENV === 'test' ? '' : 'https://gridiron-pink-chi.vercel.app');

export default defineConfig({
  plugins: [react(), absoluteMetaPlugin(ORIGIN)],
  server: {
    port: 5178,
    proxy: {
      '/api': { target: API, changeOrigin: false },
    },
  },
  preview: { port: 4178 },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      output: {
        // The chunk carrying three.js loads only when fields are drawn in 3D, and is named for it. Grouping it with
        // manualChunks is avoided: that also captured shared dependencies, so the entry imported the 3D chunk at startup.
        chunkFileNames: (chunk) => (chunk.moduleIds?.some((id) => /node_modules[\\/]three[\\/]build[\\/]/.test(id)) ? 'assets/three-[hash].js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
