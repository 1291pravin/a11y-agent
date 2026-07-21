// Smoke tests for the API surface. Boots the server on an ephemeral port and
// exercises the M0 endpoints. Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const PORT = 4517;
const BASE = `http://localhost:${PORT}`;
const STATE_FILE = join(tmpdir(), `a11y-agent-api-${process.pid}.json`);
let proc;

const DEMO_ENV = {
  PORT: String(PORT),
  AQA_TEAMSLUG: '',
  AQA_API_KEY: '',
  AQA_BASE: '',
  FLEET_SITES: '',
  CURSOR_API_KEY: '',
  ADMIN_TOKEN: '',
  GITHUB_WEBHOOK_SECRET: '',
  STATE_FILE,
  STATE_DB: '',
  SCHEDULE_ENABLED: '',
};

before(async () => {
  proc = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, ...DEMO_ENV },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${BASE}/api/health`); return; } catch { await delay(200); }
  }
  throw new Error('server did not start');
});

after(() => {
  proc?.kill();
  try { unlinkSync(STATE_FILE); } catch {}
});

test('health reports demo mode without credentials', async () => {
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode.aqa, 'demo');
  assert.equal(body.mode.cursor, 'demo');
});

test('state returns seeded sites and causes', async () => {
  const res = await fetch(`${BASE}/api/state`);
  const s = await res.json();
  assert.ok(s.sites.length >= 1);
  assert.ok(s.causes.length >= 1);
  assert.ok(Array.isArray(s.tasks));
});

test('onboard validates required fields', async () => {
  const res = await fetch(`${BASE}/api/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://x.example.com' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /repo/);
});

test('onboard creates a site', async () => {
  const res = await fetch(`${BASE}/api/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://new.example.com', repo: 'acme/new', suiteId: 'TS999' }),
  });
  assert.equal(res.status, 201);
  const site = await res.json();
  assert.ok(site.id.startsWith('site-'));
});

test('dispatch creates a task and marks the cause', async () => {
  const state = await (await fetch(`${BASE}/api/state`)).json();
  const cause = state.causes.find((c) => c.status === 'open' && c.mappedFile);
  assert.ok(cause, 'seed should contain an open mapped cause');
  const res = await fetch(`${BASE}/api/causes/${cause.id}/dispatch`, { method: 'POST' });
  assert.equal(res.status, 201);
  const task = await res.json();
  assert.equal(task.state, 'queued');
  assert.equal(task.agent, 'demo');
});

test('dispatch refuses unmapped causes', async () => {
  const state = await (await fetch(`${BASE}/api/state`)).json();
  const cause = state.causes.find((c) => !c.mappedFile);
  assert.ok(cause, 'seed should contain an unmapped cause');
  const res = await fetch(`${BASE}/api/causes/${cause.id}/dispatch`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('demo task auto-advances to verifying with a PR, then merge drives it to done', async () => {
  // demo loop ticks every 5s; reaching "verifying" needs ~2 ticks. Tasks park
  // there (M4): completion happens only through merge intake.
  let task;
  for (let i = 0; i < 22; i++) {
    await delay(1000);
    const state = await (await fetch(`${BASE}/api/state`)).json();
    task = state.tasks[0];
    if (task?.state === 'verifying') break;
  }
  assert.equal(task.state, 'verifying');
  assert.ok(task.pr?.num, 'task in verifying should reference a PR');

  const merged = await fetch(`${BASE}/api/prs/${task.pr.num}/merged`, { method: 'POST' });
  assert.equal(merged.status, 202);

  // demo verification simulates the rescan in ~2s
  for (let i = 0; i < 15; i++) {
    await delay(1000);
    const state = await (await fetch(`${BASE}/api/state`)).json();
    task = state.tasks.find((t) => t.id === task.id);
    if (task?.state === 'done') break;
  }
  assert.equal(task.state, 'done');
});

test('demo reset restores the seed', async () => {
  const res = await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });
  assert.equal(res.status, 200);
  const state = await (await fetch(`${BASE}/api/state`)).json();
  assert.equal(state.tasks.length, 0);
});
