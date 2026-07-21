// Demo recording server: real AQA fleet data + fast simulated Cursor agent.
// Started by playwright.demo.config.mjs webServer hook.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.DEMO_PORT || '4519';

const child = spawn(
  process.execPath,
  ['--env-file=.env', 'server/index.mjs'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: port,
      STATE_DB: resolve(root, 'data', 'demo-record.db'),
      CURSOR_API_KEY: '',
      DEMO_STAGE_MS: '900',
      DEMO_VERIFY_MS: '500',
      DEMO_FAST_VERIFY: '1',
    },
  },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
