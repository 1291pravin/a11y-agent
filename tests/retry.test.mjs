// Launch auto-retry and manual task retry endpoint tests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { isTransientError } from '../integrations/cursor.mjs';

const PORT = 4532;
const BASE = `http://localhost:${PORT}`;
const STATE_FILE = join(tmpdir(), `a11y-agent-retry-${process.pid}.json`);
let proc;
let mock;

let agentSeq = 0;
let launchFailuresRemaining = 0;
const runPolls = {};

function mockHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const send = (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  let m;

  if (req.method === 'POST' && p === '/agents') {
    if (launchFailuresRemaining > 0) {
      launchFailuresRemaining -= 1;
      return send({ error: 'upstream unavailable' }, 503);
    }
    agentSeq += 1;
    const id = `agent-${agentSeq}`;
    const runId = `run-${agentSeq}`;
    return send({
      agent: { id, latestRunId: runId, status: 'RUNNING' },
      run: { id: runId, status: 'RUNNING' },
    });
  }
  if (req.method === 'GET' && (m = p.match(/^\/agents\/(agent-\d+)\/runs\/(run-\d+)$/))) {
    const runId = m[2];
    runPolls[runId] = (runPolls[runId] || 0) + 1;
    if (runPolls[runId] <= 1) return send({ id: runId, status: 'RUNNING' });
    return send({ id: runId, status: 'FINISHED', git: { branches: [{ prUrl: 'https://github.com/acme/demo/pull/99' }] } });
  }
  send({ error: `mock has no route for ${req.method} ${p}` }, 404);
}

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
      CURSOR_LAUNCH_RETRIES: '3',
      CURSOR_LAUNCH_RETRY_MS: '50',
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

async function waitForTaskState(taskId, wanted) {
  let task;
  for (let i = 0; i < 100; i++) {
    await delay(100);
    const s = await (await fetch(`${BASE}/api/state`)).json();
    task = s.tasks.find((t) => t.id === taskId);
    if (task?.state === wanted || task?.state === 'failed') return task;
  }
  return task;
}

test('isTransientError classifies network and retryable HTTP failures', () => {
  assert.equal(isTransientError(new Error('fetch failed')), true);
  assert.equal(isTransientError(Object.assign(new Error('Cursor POST /agents -> HTTP 503'), { status: 503 })), true);
  assert.equal(isTransientError(Object.assign(new Error('Cursor POST /agents -> HTTP 401'), { status: 401 })), false);
});

test('launch auto-retries transient Cursor failures', async () => {
  launchFailuresRemaining = 2;
  const res = await fetch(`${BASE}/api/causes/cause-demo-1/dispatch`, { method: 'POST' });
  assert.equal(res.status, 201);
  const dispatched = await res.json();

  const task = await waitForTaskState(dispatched.id, 'verifying');
  assert.equal(task.state, 'verifying');
  assert.ok(task.log.some((l) => /launch failed/.test(l)), 'should log transient launch failures');
  assert.ok(task.log.some((l) => /retry 2\/3/.test(l)), 'should log auto-retry attempts');
});

test('manual retry re-queues a failed task', async () => {
  await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });
  launchFailuresRemaining = 99;

  const res = await fetch(`${BASE}/api/causes/cause-demo-1/dispatch`, { method: 'POST' });
  const dispatched = await res.json();
  const failed = await waitForTaskState(dispatched.id, 'failed');
  assert.equal(failed.state, 'failed');

  launchFailuresRemaining = 0;
  const retry = await fetch(`${BASE}/api/tasks/${dispatched.id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 200);
  const retried = await retry.json();
  assert.equal(retried.state, 'queued');

  const working = await waitForTaskState(dispatched.id, 'verifying');
  assert.equal(working.state, 'verifying');
  assert.ok(working.log.some((l) => /retry requested/.test(l)));
});

test('retry rejects non-failed tasks', async () => {
  const state = await (await fetch(`${BASE}/api/state`)).json();
  const task = state.tasks.find((t) => t.state === 'verifying');
  assert.ok(task, 'expected a verifying task from prior test');
  const res = await fetch(`${BASE}/api/tasks/${task.id}/retry`, { method: 'POST' });
  assert.equal(res.status, 409);
});
