// M5 fleet-hardening tests: admin token auth, CSV batch onboarding, AQA rate
// budget, scheduler slots, and the SQLite persistence backend. The auth/CSV
// app boots as a child process (demo mode + ADMIN_TOKEN + isolated
// STATE_FILE); the limiter and slotFor are unit-tested in-process via dynamic
// imports (side-effect free). The SQLite test only runs where node:sqlite
// imports, and skips gracefully elsewhere (Node < 22.5). Run: npm test

process.env.AQA_MAX_RPM = '2';
process.env.AQA_RATE_WINDOW_MS = '1000';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const TOKEN = 'sekret';
const AUTH_PORT = 4530;
const SQLITE_PORT = 4531;
const AUTH_BASE = `http://localhost:${AUTH_PORT}`;
const SQLITE_BASE = `http://localhost:${SQLITE_PORT}`;
const AUTH_STATE = join(tmpdir(), `a11y-agent-m5-auth-${process.pid}.json`);
const SQLITE_DB = join(tmpdir(), `a11y-agent-m5-${process.pid}.db`);

let hasSqlite = true;
try { await import('node:sqlite'); } catch { hasSqlite = false; }

const DEMO_ENV = {
  AQA_TEAMSLUG: '', AQA_API_KEY: '', AQA_BASE: '', FLEET_SITES: '',
  CURSOR_API_KEY: '', GITHUB_WEBHOOK_SECRET: '', ADMIN_TOKEN: '',
  STATE_FILE: '', STATE_DB: '', SCHEDULE_ENABLED: '',
};

function boot(env) {
  return spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, ...DEMO_ENV, ...env },
    stdio: 'ignore',
  });
}

async function waitUp(base) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/health`); return; } catch { await delay(200); }
  }
  throw new Error(`server at ${base} did not start`);
}

let authProc;

before(async () => {
  authProc = boot({ PORT: String(AUTH_PORT), ADMIN_TOKEN: TOKEN, STATE_FILE: AUTH_STATE });
  await waitUp(AUTH_BASE);
});

after(() => {
  authProc?.kill();
  try { unlinkSync(AUTH_STATE); } catch {}
});

const bearer = { authorization: `Bearer ${TOKEN}` };

// ── Auth ────────────────────────────────────────────────────────────────────

test('non-GET routes require the admin token when ADMIN_TOKEN is set', async () => {
  const noAuth = await fetch(`${AUTH_BASE}/api/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://auth.example.com', repo: 'acme/auth', suiteId: 'TS900' }),
  });
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json()).error, 'auth required');

  const badToken = await fetch(`${AUTH_BASE}/api/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
    body: JSON.stringify({ url: 'https://auth.example.com', repo: 'acme/auth', suiteId: 'TS900' }),
  });
  assert.equal(badToken.status, 401);

  const withAuth = await fetch(`${AUTH_BASE}/api/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer },
    body: JSON.stringify({ url: 'https://auth.example.com', repo: 'acme/auth', suiteId: 'TS900' }),
  });
  assert.equal(withAuth.status, 201);
  assert.ok((await withAuth.json()).id.startsWith('site-'));
});

test('GET routes stay open and report auth in mode flags', async () => {
  const state = await fetch(`${AUTH_BASE}/api/state`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).mode.auth, true);

  const health = await fetch(`${AUTH_BASE}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode.auth, true);
});

test('github webhook keeps its own auth path (no bearer required)', async () => {
  const res = await fetch(`${AUTH_BASE}/api/webhooks/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'opened', pull_request: { number: 1, merged: false } }),
  });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).ignored, true);
});

// ── CSV batch onboarding ────────────────────────────────────────────────────

test('CSV batch creates, dedupes, and collects row errors without aborting', async () => {
  // Line 2 duplicates the seeded demo site url -> skipped; line 3 is valid;
  // line 4 is missing repo -> row error with its line number.
  const csv = [
    'url,repo,suiteId,framework',
    'https://demo.example.com,acme/demo,TS000,demo',
    'https://fresh.example.com,acme/fresh,TS555,vue',
    'https://bad.example.com,,TS556,react',
  ].join('\n');

  const noAuth = await fetch(`${AUTH_BASE}/api/sites/batch`, { method: 'POST', body: csv });
  assert.equal(noAuth.status, 401, 'batch endpoint is auth-protected');

  const res = await fetch(`${AUTH_BASE}/api/sites/batch`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv', ...bearer },
    body: csv,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 1);
  assert.equal(body.skipped, 1);
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].line, 4);
  assert.match(body.errors[0].error, /repo/);

  const s = await (await fetch(`${AUTH_BASE}/api/state`)).json();
  const fresh = s.sites.find((x) => x.url === 'https://fresh.example.com');
  assert.ok(fresh, 'valid row should be onboarded');
  assert.equal(fresh.suiteId, 'TS555');
  assert.equal(fresh.framework, 'vue');
  assert.ok(!s.sites.some((x) => x.url === 'https://bad.example.com'));
});

test('CSV batch rejects a header row missing required columns', async () => {
  const res = await fetch(`${AUTH_BASE}/api/sites/batch`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv', ...bearer },
    body: 'url,framework\nhttps://x.example.com,vue',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /repo/);
});

// ── AQA rate budget (unit; env pinned at the top of this file) ──────────────

test('rate limiter delays the request that exceeds the window budget', async () => {
  const aqa = await import('../integrations/aqa.mjs');
  const t0 = Date.now();
  await aqa.acquireRateSlot();
  await aqa.acquireRateSlot();
  const afterTwo = Date.now() - t0;
  assert.ok(afterTwo < 500, `first two slots should be immediate (took ${afterTwo}ms)`);
  await aqa.acquireRateSlot();
  const afterThree = Date.now() - t0;
  assert.ok(afterThree >= 800, `third slot should wait for the window (took ${afterThree}ms)`);
});

// ── Scheduler slots (unit) ──────────────────────────────────────────────────

test('slotFor is stable and lands in Mon-Thu, 01:00-05:00 UTC', async () => {
  const { slotFor } = await import('../server/scheduler.mjs');
  const ids = ['site-demo', 'site-1001', 'filorga-fr', 'filorga-eu', 'a', 'zz-9', 'site-1042'];
  for (const id of ids) {
    const slot = slotFor(id);
    assert.deepEqual(slotFor(id), slot, `slot for ${id} must be stable across calls`);
    assert.ok(['Mon', 'Tue', 'Wed', 'Thu'].includes(slot.day), `${id} day ${slot.day}`);
    assert.ok(slot.hour >= 1 && slot.hour <= 5, `${id} hour ${slot.hour}`);
  }
  // Different ids should not all collapse onto one slot.
  const distinct = new Set(ids.map((id) => JSON.stringify(slotFor(id))));
  assert.ok(distinct.size > 1, 'hash should spread sites across slots');
});

test('sites in /api/state carry their schedule slot', async () => {
  const { slotFor } = await import('../server/scheduler.mjs');
  const s = await (await fetch(`${AUTH_BASE}/api/state`)).json();
  assert.ok(s.sites.length >= 1);
  for (const site of s.sites) {
    assert.deepEqual(site.schedule, slotFor(site.id));
  }
  assert.equal(s.mode.schedule, false, 'scheduler is inert without SCHEDULE_ENABLED');
});

// ── SQLite backend (skips where node:sqlite is unavailable) ─────────────────

test('sqlite backend persists state across a restart', async (t) => {
  if (!hasSqlite) return t.skip('node:sqlite not available on this Node version');

  const env = { PORT: String(SQLITE_PORT), STATE_DB: SQLITE_DB };
  let proc = boot(env);
  try {
    await waitUp(SQLITE_BASE);
    const created = await fetch(`${SQLITE_BASE}/api/sites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://sqlite.example.com', repo: 'acme/sqlite', suiteId: 'TS777' }),
    });
    assert.equal(created.status, 201);
    const site = await created.json();

    await delay(600); // debounced save is 200ms; let it flush to the DB
    proc.kill();
    await new Promise((r) => proc.once('exit', r));

    proc = boot(env);
    await waitUp(SQLITE_BASE);
    const s = await (await fetch(`${SQLITE_BASE}/api/state`)).json();
    const survived = s.sites.find((x) => x.id === site.id);
    assert.ok(survived, 'site created before the restart should survive');
    assert.equal(survived.url, 'https://sqlite.example.com');
    assert.ok(s.sites.some((x) => x.id === 'site-demo'), 'demo seed persisted alongside');
  } finally {
    proc.kill();
    await new Promise((r) => proc.once('exit', r));
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { unlinkSync(`${SQLITE_DB}${suffix}`); } catch {}
    }
  }
});
