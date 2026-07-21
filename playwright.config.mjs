// Playwright E2E config for the M0 webapp verification checklist.
// Starts the zero-dep server on an ephemeral port in demo mode.

import { defineConfig } from '@playwright/test';

const PORT = 4518;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  // demo-video.spec.mjs is the recorder script, not a check: it drives the
  // fleet data served by scripts/demo-server.mjs (playwright.demo.config.mjs)
  // and cannot pass against the demo seed this config boots.
  testIgnore: 'demo-video.spec.mjs',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node server/index.mjs',
    url: BASE + '/api/health',
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      PORT: String(PORT),
      AQA_TEAMSLUG: '',
      AQA_API_KEY: '',
      CURSOR_API_KEY: '',
    },
  },
});
