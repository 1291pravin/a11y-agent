// M2 dispatch tests: mock Cursor server + real-cursor-mode app (demo AQA seed).
// Dispatching cause-demo-1 launches an agent on the mock; the app polls the run
// to FINISHED, parks the task in "verifying", and records the PR in state.prs.
// A second dispatch (after demo reset) finishes without a PR and must not
// fabricate one. Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const PORT = 4519;
const BASE = `http://localhost:${PORT}`;
const PR_URL = 'https://github.com/acme/demo/pull/77';
const STATE_FILE = join(tmpdir(), `a11y-agent-m2-state-${process.pid}.json`);
let proc;
let mock;

// ── Mock Cursor ─────────────────────────────────────────────────────────────
// Agent 1 (first POST /agents) finishes with a PR; agent 2 finishes without.
// Each run reports RUNNING twice before FINISHED to exercise the poll loop.

let agentSeq = 0;
const runPolls = {};
let lastLaunchBody = null;

function mockHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const send = (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  let m;

  if (req.method === 'POST' && p === '/agents') {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      lastLaunchBody = JSON.parse(data);
      agentSeq += 1;
      const id = `agent-${agentSeq}`;
      const runId = `run-${agentSeq}`;
      send({
        agent: { id, latestRunId: runId, status: 'RUNNING' },
        run: { id: runId, status: 'RUNNING' },
      });
    });
    return;
  }
  if (req.method === 'GET' && (m = p.match(/^\/agents\/(agent-\d+)\/runs\/(run-(\d+))$/))) {
    const runId = m[2];
    runPolls[runId] = (runPolls[runId] || 0) + 1;
    if (runPolls[runId] <= 2) return send({ id: runId, status: 'RUNNING' });
    if (m[3] === '1') {
      return send({ id: runId, status: 'FINISHED', git: { branches: [{ prUrl: PR_URL }] } });
    }
    return send({ id: runId, status: 'FINISHED' }); // no branches -> no PR
  }
  if (req.method === 'GET' && (m = p.match(/^\/agents\/(agent-(\d+))$/))) {
    return send({ id: m[1], latestRunId: `run-${m[2]}`, status: 'RUNNING' });
  }
  send({ error: `mock has no route for ${req.method} ${p}` }, 404);
}

// ── Boot ────────────────────────────────────────────────────────────────────

before(async () => {
  mock = createServer(mockHandler);
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
      CURSOR_POLL_MS: '100',
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
});

async function getAppState() {
  return (await fetch(`${BASE}/api/state`)).json();
}

async function waitForTaskState(taskId, wanted) {
  let task;
  for (let i = 0; i < 100; i++) {
    await delay(100);
    const s = await getAppState();
    task = s.tasks.find((t) => t.id === taskId);
    if (task?.state === wanted || task?.state === 'failed') return { task, state: s };
  }
  return { task, state: await getAppState() };
}

test('dispatch launches a real cursor agent and records the PR', async () => {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(health.mode.cursor, 'real');
  assert.equal(health.mode.aqa, 'demo');

  const res = await fetch(`${BASE}/api/causes/cause-demo-1/dispatch`, { method: 'POST' });
  assert.equal(res.status, 201);
  const dispatched = await res.json();
  assert.equal(dispatched.agent, 'cursor');
  assert.equal(dispatched.state, 'queued');

  const { task, state } = await waitForTaskState(dispatched.id, 'verifying');
  assert.equal(task.state, 'verifying');
  assert.equal(task.agentId, 'agent-1');
  assert.equal(task.pr?.num, '77');
  assert.equal(task.pr?.url, PR_URL);

  // Launch payload followed the validated v1 contract.
  assert.equal(lastLaunchBody.model.id, 'composer-2.5');
  assert.equal(lastLaunchBody.repos[0].url, 'https://github.com/acme/demo');
  assert.equal(lastLaunchBody.autoCreatePR, true);
  assert.match(lastLaunchBody.prompt.text, /image-alt/);

  // PR record landed in the store with the demo-path shape.
  assert.equal(state.prs.length, 1);
  const pr = state.prs[0];
  assert.equal(pr.num, '77');
  assert.equal(pr.url, PR_URL);
  assert.equal(pr.taskId, task.id);
  assert.equal(pr.siteId, 'site-demo');
  assert.equal(pr.state, 'open');
  assert.equal(pr.title, 'fix(a11y): demo images missing alt text');
  assert.equal(pr.rule, 'WCAG 1.1.1 A');
  assert.equal(pr.instances, 3);
  assert.equal(pr.verification.expected, -3);
  assert.equal(pr.verification.actual, null);
  assert.ok(pr.verification.expected < 0, 'expected delta must be negative');

  const cause = state.causes.find((c) => c.id === 'cause-demo-1');
  assert.equal(cause.status, 'pr');
});

test('agent finishing without a PR leaves the task in verifying, no PR record', async () => {
  const reset = await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);

  const res = await fetch(`${BASE}/api/causes/cause-demo-1/dispatch`, { method: 'POST' });
  assert.equal(res.status, 201);
  const dispatched = await res.json();
  assert.equal(dispatched.agent, 'cursor');

  const { task, state } = await waitForTaskState(dispatched.id, 'verifying');
  assert.equal(task.state, 'verifying');
  assert.equal(task.agentId, 'agent-2');
  assert.equal(task.pr, null);
  assert.ok(
    task.log.some((l) => /without reporting a PR/.test(l)),
    'log should flag the missing PR for a human',
  );
  assert.equal(state.prs.length, 0, 'no PR record without a prUrl');

  const cause = state.causes.find((c) => c.id === 'cause-demo-1');
  assert.equal(cause.status, 'task', 'cause stays in task until a PR exists');
});
