// M4 verification-loop tests: demo tasks park at "verifying" until merge
// intake (manual endpoint or GitHub webhook) triggers the re-run. Three app
// instances: A = pass path + webhook, B = DEMO_VERIFY_FAIL fail path + reopen,
// C = webhook signature enforcement (GITHUB_WEBHOOK_SECRET). Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const SECRET = 'm4-webhook-secret';
const APPS = {
  pass: { port: 4520, env: {} },
  fail: { port: 4521, env: { DEMO_VERIFY_FAIL: '1' } },
  signed: { port: 4522, env: { GITHUB_WEBHOOK_SECRET: SECRET } },
};
const procs = [];

function boot({ port, env }) {
  const stateFile = join(tmpdir(), `a11y-agent-m4-state-${port}-${process.pid}.json`);
  const proc = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      PORT: String(port),
      AQA_TEAMSLUG: '',
      AQA_API_KEY: '',
      AQA_BASE: '',
      FLEET_SITES: '',
      CURSOR_API_KEY: '',
      GITHUB_WEBHOOK_SECRET: '',
      DEMO_VERIFY_FAIL: '',
      DEMO_STAGE_MS: '200',
      DEMO_VERIFY_MS: '200',
      STATE_FILE: stateFile,
      ...env,
    },
    stdio: 'ignore',
  });
  procs.push({ proc, stateFile });
  return proc;
}

before(async () => {
  for (const app of Object.values(APPS)) boot(app);
  for (const app of Object.values(APPS)) {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { await fetch(`http://localhost:${app.port}/api/health`); up = true; }
      catch { await delay(200); }
    }
    if (!up) throw new Error(`server on :${app.port} did not start`);
  }
});

after(() => {
  for (const { proc, stateFile } of procs) {
    proc?.kill();
    try { unlinkSync(stateFile); } catch {}
  }
});

const base = (name) => `http://localhost:${APPS[name].port}`;

async function getAppState(name) {
  return (await fetch(`${base(name)}/api/state`)).json();
}

// Dispatch cause-demo-1 and wait for the task to park at "verifying" with a PR.
async function dispatchToVerifying(name) {
  const res = await fetch(`${base(name)}/api/causes/cause-demo-1/dispatch`, { method: 'POST' });
  assert.equal(res.status, 201);
  const dispatched = await res.json();
  let task;
  for (let i = 0; i < 100; i++) {
    await delay(100);
    const s = await getAppState(name);
    task = s.tasks.find((t) => t.id === dispatched.id);
    if (task?.state === 'verifying' && task.pr?.num) return task;
  }
  throw new Error(`task never reached verifying (last state: ${task?.state})`);
}

async function waitForTaskState(name, taskId, wanted) {
  let task;
  for (let i = 0; i < 100; i++) {
    await delay(100);
    const s = await getAppState(name);
    task = s.tasks.find((t) => t.id === taskId);
    if (task?.state === wanted || task?.state === 'failed') return { task, state: s };
  }
  return { task, state: await getAppState(name) };
}

function mergedPayload(num, repo = 'acme/demo') {
  return {
    action: 'closed',
    pull_request: { number: Number(num), merged: true },
    repository: { full_name: repo },
  };
}

async function postWebhook(name, payload, headers = {}) {
  return fetch(`${base(name)}/api/webhooks/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

// ── Instance A: pass path (manual endpoint, then webhook) ───────────────────

test('demo task parks at verifying; manual merge verifies and completes it', async () => {
  const task = await dispatchToVerifying('pass');

  // Parked: no auto-done anymore. A few extra demo ticks must not move it.
  await delay(600);
  let s = await getAppState('pass');
  assert.equal(s.tasks.find((t) => t.id === task.id).state, 'verifying');
  const pr = s.prs.find((p) => p.taskId === task.id);
  assert.equal(pr.state, 'open');
  assert.equal(pr.verification.actual, null);

  const res = await fetch(`${base('pass')}/api/prs/${pr.num}/merged`, { method: 'POST' });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).verifying, true);

  // While verification is in flight the merge cannot be re-posted.
  const dup = await fetch(`${base('pass')}/api/prs/${pr.num}/merged`, { method: 'POST' });
  assert.equal(dup.status, 409);

  const { task: done, state } = await waitForTaskState('pass', task.id, 'done');
  assert.equal(done.state, 'done');
  assert.ok(done.log.some((l) => /merge detected/.test(l)));
  assert.ok(done.log.some((l) => /3 violations cleared/.test(l)));

  const settled = state.prs.find((p) => p.taskId === task.id);
  assert.equal(settled.state, 'merged-verified');
  assert.equal(settled.verification.actual, -3);

  const cause = state.causes.find((c) => c.id === 'cause-demo-1');
  assert.equal(cause.status, 'fixed');
  const site = state.sites.find((x) => x.id === 'site-demo');
  assert.equal(site.total, 0);
  assert.equal(site.critical, 0);
});

test('manual merge of an unknown PR returns 404', async () => {
  const res = await fetch(`${base('pass')}/api/prs/99999/merged`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('webhook merge drives the same verification; non-merges are ignored', async () => {
  const reset = await fetch(`${base('pass')}/api/demo/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  const task = await dispatchToVerifying('pass');
  const num = task.pr.num;

  // Closed-without-merge, wrong repo, and unknown PR number are all ignored.
  const closed = await postWebhook('pass', { action: 'closed', pull_request: { number: Number(num), merged: false }, repository: { full_name: 'acme/demo' } });
  assert.equal(closed.status, 202);
  assert.equal((await closed.json()).ignored, true);
  const wrongRepo = await postWebhook('pass', mergedPayload(num, 'acme/other'));
  assert.equal((await wrongRepo.json()).ignored, true);
  const unknown = await postWebhook('pass', mergedPayload(99999));
  assert.equal((await unknown.json()).ignored, true);
  let s = await getAppState('pass');
  assert.equal(s.tasks.find((t) => t.id === task.id).state, 'verifying');

  const res = await postWebhook('pass', mergedPayload(num));
  assert.equal(res.status, 202);
  assert.equal((await res.json()).verifying, true);

  const { task: done, state } = await waitForTaskState('pass', task.id, 'done');
  assert.equal(done.state, 'done');
  const pr = state.prs.find((p) => p.taskId === task.id);
  assert.equal(pr.state, 'merged-verified');
  assert.equal(pr.verification.actual, -3);
  assert.equal(state.causes.find((c) => c.id === 'cause-demo-1').status, 'fixed');
});

// ── Instance B: fail path -> reopen ─────────────────────────────────────────

test('failed verification reopens the task and frees the cause for re-dispatch', async () => {
  const task = await dispatchToVerifying('fail');
  const num = task.pr.num;

  const res = await fetch(`${base('fail')}/api/prs/${num}/merged`, { method: 'POST' });
  assert.equal(res.status, 202);

  const { task: reopened, state } = await waitForTaskState('fail', task.id, 'reopened');
  assert.equal(reopened.state, 'reopened');
  assert.ok(reopened.log.some((l) => /3 of 3 instances still failing/.test(l)));
  assert.ok(reopened.log.some((l) => /REOPENED/.test(l)));

  const pr = state.prs.find((p) => p.taskId === task.id);
  assert.equal(pr.state, 'merged-unverified');
  assert.equal(pr.verification.actual, 0);

  const cause = state.causes.find((c) => c.id === 'cause-demo-1');
  assert.equal(cause.status, 'open', 'cause returns to open for re-dispatch');

  // Re-dispatch creates a fresh task on the same cause.
  const again = await fetch(`${base('fail')}/api/causes/cause-demo-1/dispatch`, { method: 'POST' });
  assert.equal(again.status, 201);
  const second = await again.json();
  assert.notEqual(second.id, task.id);
  assert.equal(second.state, 'queued');
});

// ── Instance C: webhook signature enforcement ───────────────────────────────

test('webhook requires a valid signature when GITHUB_WEBHOOK_SECRET is set', async () => {
  const task = await dispatchToVerifying('signed');
  const payload = mergedPayload(task.pr.num);
  const raw = JSON.stringify(payload);

  const missing = await postWebhook('signed', payload);
  assert.equal(missing.status, 401);
  const bad = await postWebhook('signed', payload, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) });
  assert.equal(bad.status, 401);
  let s = await getAppState('signed');
  assert.equal(s.tasks.find((t) => t.id === task.id).state, 'verifying');

  const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
  const ok = await postWebhook('signed', payload, { 'x-hub-signature-256': sig });
  assert.equal(ok.status, 202);
  assert.equal((await ok.json()).verifying, true);

  const { task: done, state } = await waitForTaskState('signed', task.id, 'done');
  assert.equal(done.state, 'done');
  assert.equal(state.prs.find((p) => p.taskId === task.id).state, 'merged-verified');
});
