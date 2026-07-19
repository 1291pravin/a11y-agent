// Smoke tests for the API surface. Boots the server on an ephemeral port and
// exercises the M0 endpoints. Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 4517;
const BASE = `http://localhost:${PORT}`;
let proc;

before(async () => {
  proc = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), AQA_TEAMSLUG: '', AQA_API_KEY: '', CURSOR_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${BASE}/api/health`); return; } catch { await delay(200); }
  }
  throw new Error('server did not start');
});

after(() => proc?.kill());

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
  assert.ok(s.sites.length >= 3);
  assert.ok(s.causes.length >= 5);
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

test('demo task auto-advances to done with a PR', async () => {
  // demo loop ticks every 5s; full lifecycle needs ~3 ticks
  let task;
  for (let i = 0; i < 22; i++) {
    await delay(1000);
    const state = await (await fetch(`${BASE}/api/state`)).json();
    task = state.tasks[0];
    if (task?.state === 'done') break;
  }
  assert.equal(task.state, 'done');
  assert.ok(task.pr?.num, 'completed task should reference a PR');
});

test('demo reset restores the seed', async () => {
  const res = await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });
  assert.equal(res.status, 200);
  const state = await (await fetch(`${BASE}/api/state`)).json();
  assert.equal(state.tasks.length, 0);
});
