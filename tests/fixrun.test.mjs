// Fix run tests (M9).
//
// The dispatch module is the coordinator of a batch: it picks eligible causes,
// enforces concurrency and budget caps, and drives the run to completion as
// tasks finish. These tests pin the properties that matter without booting
// the orchestrator: reject sites without a repo, skip causes that already
// have work in flight, and respect the budget.
//
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

// Fix-run pulls in orchestrator + store transitively. Point at a throwaway JSON
// file before importing so nothing touches the real state database, and force
// demo mode so dispatchTask() cannot try to reach the real Cursor API.
process.env.STORE_BACKEND = 'json';
process.env.STATE_FILE = join(tmpdir(), `a11y-agent-fixrun-${process.pid}.json`);
process.env.FIXRUN_TASK_COST_USD = '1';
process.env.FIXRUN_BUDGET_USD = '5';
process.env.FIXRUN_ADVANCE_MS = '25000'; // long enough tests never see a tick

// Ensure the state file is gone before the test suite starts - a leftover
// from a previous crashed run must not survive into a fresh test process.
after(() => {
  try { if (existsSync(process.env.STATE_FILE)) unlinkSync(process.env.STATE_FILE); } catch { /* fine */ }
});

const { startFixRun, cancelFixRun, findFixRun, allFixRuns } = await import('../server/fix-run.mjs');
const { getState, update, resetToSeed } = await import('../server/store.mjs');

// Every test starts from the same known state. resetToSeed() reloads the demo
// seed (which we then overwrite with test fixtures), so a stray task from an
// earlier test cannot poison the "no in-flight work" preconditions the batch
// planner relies on.
async function seed() {
  await resetToSeed();
  update((s) => {
    s.sites = [{
      id: 'site-t1', url: 'https://t1.example.com', repo: 'acme/t1',
      mode: 'quick', framework: 'demo', flows: [], discover: null,
      intent: '', status: 'ok', total: 0, trend: [], lastRun: null, critical: 0,
    }];
    s.causes = [
      { id: 'cause-t1-a', siteId: 'site-t1', title: 'missing alt', rule: 'WCAG 1.1.1', ruleId: 'image-alt', severity: 'critical', instances: 3, pages: ['/'], selector: 'img.hero', status: 'open' },
      { id: 'cause-t1-b', siteId: 'site-t1', title: 'iframe title', rule: 'WCAG 2.4.1', ruleId: 'frame-title', severity: 'serious', instances: 1, pages: ['/'], selector: 'iframe', status: 'open' },
      { id: 'cause-t1-c', siteId: 'site-t1', title: 'contrast', rule: 'WCAG 1.4.3', ruleId: 'color-contrast', severity: 'moderate', instances: 5, pages: ['/'], selector: 'button', status: 'open' },
    ];
    s.tasks = [];
    s.prs = [];
    s.fixRuns = [];
    s.activity = [];
  });
}

test('startFixRun rejects a site with no GitHub repo', async () => {
  await seed();
  update((s) => { s.sites[0].repo = null; });
  const result = startFixRun('site-t1', {});
  assert.match(result.error || '', /GitHub repo/);
});

test('startFixRun rejects an unknown site', async () => {
  await seed();
  const result = startFixRun('site-does-not-exist', {});
  assert.match(result.error || '', /site not found/);
});

test('startFixRun creates a run and dispatches up to concurrency tasks', async () => {
  await seed();
  const result = startFixRun('site-t1', { concurrency: 2, budgetUsd: 5 });
  assert.equal(result.error, undefined);
  const run = result.run;
  assert.equal(run.plannedCount, 3);
  assert.equal(run.remaining.length, 1, 'concurrency=2 means one cause queued');
  assert.equal(run.taskIds.length, 2);
  assert.equal(run.dispatched, 2);
  assert.equal(run.state, 'running');
  const tasks = getState().tasks.filter((t) => run.taskIds.includes(t.id));
  assert.equal(tasks.length, 2, 'two tasks materialized in state.tasks');
});

test('cancelFixRun stops further dispatch but leaves in-flight tasks alone', async () => {
  await seed();
  const { run } = startFixRun('site-t1', { concurrency: 1, budgetUsd: 5 });
  assert.equal(run.dispatched, 1);
  assert.equal(run.remaining.length, 2);
  const cancelled = cancelFixRun(run.id);
  assert.equal(cancelled.error, undefined);
  assert.equal(cancelled.run.state, 'cancelled');
  assert.equal(cancelled.run.remaining.length, 0, 'remaining causes are dropped');
  const tasks = getState().tasks.filter((t) => run.taskIds.includes(t.id));
  assert.equal(tasks.length, 1, 'the already-dispatched task stays alive');
});

test('startFixRun skips a cause that already has an in-flight task', async () => {
  await seed();
  update((s) => {
    s.tasks.push({ id: 'task-preexist', causeId: 'cause-t1-a', siteId: 'site-t1', state: 'working', title: 'existing', createdAt: Date.now() });
  });
  const { run } = startFixRun('site-t1', { concurrency: 3, budgetUsd: 5 });
  const causeIdsInBatch = run.taskIds.map((tid) => getState().tasks.find((t) => t.id === tid)?.causeId).filter(Boolean);
  assert.ok(!causeIdsInBatch.includes('cause-t1-a'), 'must not re-dispatch a cause with an in-flight task');
  assert.equal(run.plannedCount, 2, 'cause-t1-a is filtered out at planning time');
});

test('startFixRun with explicit causeIds honours the selection', async () => {
  await seed();
  const { run } = startFixRun('site-t1', { causeIds: ['cause-t1-b'], concurrency: 5, budgetUsd: 5 });
  assert.equal(run.plannedCount, 1);
  assert.equal(run.dispatched, 1);
  const dispatchedCauseId = getState().tasks.find((t) => t.id === run.taskIds[0]).causeId;
  assert.equal(dispatchedCauseId, 'cause-t1-b');
});

test('budget cap limits the initial dispatch wave', async () => {
  await seed();
  // Budget $2 at $1/task with 0.5x mid-flight coefficient = ~2 tasks at most
  // (spent so far + next task must stay under budget).
  const { run } = startFixRun('site-t1', { concurrency: 10, budgetUsd: 2 });
  assert.ok(run, 'expected a run when there are eligible causes');
  assert.ok(run.dispatched <= 3, `dispatched (${run.dispatched}) must respect the budget`);
  assert.ok(run.remaining.length + run.dispatched === run.plannedCount);
});

test('allFixRuns returns runs newest-first', async () => {
  await seed();
  const a = startFixRun('site-t1', { causeIds: ['cause-t1-a'] });
  const b = startFixRun('site-t1', { causeIds: ['cause-t1-b'] });
  const runs = allFixRuns();
  assert.equal(runs[0].id, b.run.id, 'newest run is at the front');
  assert.equal(runs[1].id, a.run.id);
});
