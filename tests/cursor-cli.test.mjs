// Cursor CLI fallback: spawn a mock `agent` binary, poll stdout, park at verifying.
// Run: npm test -- tests/cursor-cli.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync, unlinkSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { extractPrUrl, launchAgent, getRun } from '../integrations/cursor-cli.mjs';

const PORT = 4535;
const BASE = `http://localhost:${PORT}`;
const PR_URL = 'https://github.com/acme/demo/pull/42';
const STATE_FILE = join(tmpdir(), `a11y-agent-cli-state-${process.pid}.json`);
const WORKSPACE = join(tmpdir(), `a11y-agent-cli-ws-${process.pid}`);
const CLI_DIR = join(tmpdir(), `a11y-agent-cli-runs-${process.pid}`);
const MOCK_BIN = join(tmpdir(), `a11y-agent-mock-agent-${process.pid}`);

let proc;
let mock;

before(() => {
  mkdirSync(WORKSPACE, { recursive: true });
  writeFileSync(join(WORKSPACE, 'README.md'), '# fixture\n');
  writeFileSync(MOCK_BIN, `#!/usr/bin/env node
setTimeout(() => {
  console.log('Working on a11y fix...');
  console.log('Opened PR: ${PR_URL}');
  process.exit(0);
}, 150);
`);
  chmodSync(MOCK_BIN, 0o755);
  process.env.CURSOR_CLI_BIN = MOCK_BIN;
  process.env.CURSOR_CLI_DIR = CLI_DIR;
});

before(async () => {
  // Cloud mock always 503 so auto-mode falls back to CLI after retries.
  mock = createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'cloud unavailable' }));
  });
  await new Promise((r) => mock.listen(0, r));
  const mockPort = mock.address().port;

  proc = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AQA_TEAMSLUG: '',
      AQA_API_KEY: '',
      AQA_BASE: '',
      FLEET_SITES: '',
      CURSOR_API_KEY: 'mock',
      CURSOR_BASE: `http://localhost:${mockPort}`,
      CURSOR_MODE: 'auto',
      CURSOR_LAUNCH_RETRIES: '1',
      CURSOR_LAUNCH_RETRY_MS: '20',
      CURSOR_POLL_MS: '100',
      CURSOR_CLI_BIN: MOCK_BIN,
      CURSOR_CLI_DIR: CLI_DIR,
      STATE_FILE,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/health`); return; } catch { await delay(200); }
  }
  throw new Error('server did not start');
});

after(() => {
  proc?.kill();
  mock?.close();
  try { unlinkSync(STATE_FILE); } catch {}
  try { unlinkSync(MOCK_BIN); } catch {}
  try { rmSync(WORKSPACE, { recursive: true, force: true }); } catch {}
  try { rmSync(CLI_DIR, { recursive: true, force: true }); } catch {}
});

async function waitForTaskState(taskId, wanted) {
  let task;
  for (let i = 0; i < 100; i++) {
    await delay(100);
    const s = await (await fetch(`${BASE}/api/state`)).json();
    task = s.tasks.find((t) => t.id === taskId);
    if (task?.state === wanted || task?.state === 'failed') return { task, state: s };
  }
  return { task, state: await (await fetch(`${BASE}/api/state`)).json() };
}

test('extractPrUrl finds github pull links in agent output', () => {
  assert.equal(extractPrUrl(`done\nOpened PR: ${PR_URL}\n`), PR_URL);
  assert.equal(extractPrUrl('no pr here'), null);
});

test('launchAgent spawns CLI in background and getRun captures output + PR', async () => {
  const launched = await launchAgent({
    workspace: WORKSPACE,
    prompt: 'fix the a11y issue',
    taskId: 'task-unit',
  });
  assert.match(launched.id, /^cli-/);
  assert.equal(launched.status, 'RUNNING');
  assert.ok(launched.pid);

  let run;
  for (let i = 0; i < 40; i++) {
    await delay(50);
    run = getRun(launched.runId);
    if (run.status === 'FINISHED' || run.status === 'ERROR') break;
  }
  assert.equal(run.status, 'FINISHED');
  assert.match(run.output, /Working on a11y fix/);
  assert.equal(run.git.branches[0].prUrl, PR_URL);
  assert.ok(existsSync(join(CLI_DIR, launched.id, 'stdout.log')));
  assert.match(readFileSync(join(CLI_DIR, launched.id, 'stdout.log'), 'utf8'), /Opened PR/);
});

test('health reports CLI readiness and cursorMode', async () => {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(health.mode.cursor, 'real');
  assert.equal(health.mode.cursorMode, 'auto');
  assert.equal(health.mode.cursorCli, true);
});

test('cloud launch failure falls back to Cursor CLI and records the PR', async () => {
  const patch = await fetch(`${BASE}/api/sites/site-demo`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath: WORKSPACE }),
  });
  assert.equal(patch.status, 200);
  const site = await patch.json();
  assert.equal(site.repoPath, WORKSPACE);

  const res = await fetch(`${BASE}/api/causes/cause-demo-1/dispatch`, { method: 'POST' });
  assert.equal(res.status, 201);
  const dispatched = await res.json();
  assert.equal(dispatched.agent, 'cursor'); // starts as cloud; flips to cursor-cli on fallback

  const { task, state } = await waitForTaskState(dispatched.id, 'verifying');
  assert.equal(task.state, 'verifying', `expected verifying, got ${task?.state}: ${task?.log?.slice(-3).join(' | ')}`);
  assert.equal(task.agent, 'cursor-cli');
  assert.match(task.agentId, /^cli-/);
  assert.equal(task.pr?.url, PR_URL);
  assert.equal(task.pr?.num, '42');
  assert.ok(task.log.some((l) => /falling back to Cursor CLI/.test(l)));
  assert.ok(task.log.some((l) => /launching Cursor CLI agent/.test(l)));
  assert.equal(state.prs[0]?.url, PR_URL);
});
