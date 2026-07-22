// Playwright config for the product demo video recorder.
// Run via: npm run record:demo

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.DEMO_PORT) || 4519;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'demo-video.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE,
    viewport: { width: 1440, height: 900 },
    video: { mode: 'on', size: { width: 1440, height: 900 } },
    launchOptions: { slowMo: 25 },
    trace: 'off',
  },
  webServer: {
    command: 'node scripts/demo-server.mjs',
    url: BASE + '/api/health',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
