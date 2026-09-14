import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end journeys run against the production build in replay mode, so they
 * never depend on live games or on the provider being reachable. Each test
 * starts its own replay session at a chosen point with ?replay=…&at=…&paused=1.
 *
 * The full suite runs in Chrome. Journeys tagged @cross also run in Firefox and
 * WebKit (Safari's engine). By default the locally installed Chrome is used; set
 * PLAYWRIGHT_CHANNEL to another installed channel, or to "bundled" for
 * Playwright's own Chromium (as CI does).
 */
const PORT = Number(process.env.GRIDIRON_E2E_PORT ?? 8795);
const requested = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';
const channel = requested === 'bundled' ? undefined : requested;
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Journeys run without the service worker so every test sees the network as it is; one test opts back in.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], channel, viewport },
    },
    {
      name: 'firefox',
      grep: /@cross/,
      use: { ...devices['Desktop Firefox'], viewport },
    },
    {
      name: 'webkit',
      grep: /@cross/,
      use: { ...devices['Desktop Safari'], viewport },
    },
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: { GRIDIRON_E2E_PORT: String(PORT) },
  },
});
