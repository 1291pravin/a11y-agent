// Batch fix dispatch (M9). Wraps orchestrator.dispatchTask so an operator
// can approve a report and let the Fix All button hand a whole batch of
// causes to Cursor at once - bounded by a concurrency cap and a USD budget
// so a runaway batch cannot blow through the day's spending.
//
// A fixRun is:
//   id, siteId, plannedIds:[causeId], remaining:[causeId], taskIds:[taskId],
//   dispatched, concurrency, budgetUsd, spentUsd,
//   state: 'queued' | 'running' | 'complete' | 'cancelled' | 'failed',
//   startedAt, finishedAt?, error?
//
// The store keeps only IDs; the tasks themselves live in state.tasks. This
// means restarting the server picks the run up wherever it was (see
// resumeFixRuns() below) rather than having to serialize agent state twice.

import { getState, update, nextId } from './store.mjs';
import { dispatchTask } from './orchestrator.mjs';

const DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.FIXRUN_CONCURRENCY) || 3);
const DEFAULT_BUDGET_USD = Number(process.env.FIXRUN_BUDGET_USD) || 25;
// Rough cost heuristic per finished fix task. Real cost is not returned by
// Cursor; this lets the UI show a plausible budget bar and the run stop
// itself before blowing through the cap. Override per-org if needed.
const COST_PER_TASK_USD = Number(process.env.FIXRUN_TASK_COST_USD) || 0.75;
const ADVANCE_INTERVAL_MS = Number(process.env.FIXRUN_ADVANCE_MS) || 3000;

export function allFixRuns(state = getState()) {
  if (!state.fixRuns) state.fixRuns = [];
  return state.fixRuns;
}

export function findFixRun(id, state = getState()) {
  return allFixRuns(state).find((r) => r.id === id) || null;
}

// Public state includes fixRuns so the UI's 3s poll drives the command
// centre without a second endpoint. Task IDs pair with state.tasks the same
// way cause.taskId does.
export function publicFixRun(run) {
  return { ...run };
}

// Create a fixRun and dispatch the first wave.
// causeIds: explicit selection; if empty, every dispatchable cause on the
// site (no open task, no open PR, status:'open') is included.
export function startFixRun(siteId, {
  causeIds,
  concurrency = DEFAULT_CONCURRENCY,
  budgetUsd = DEFAULT_BUDGET_USD,
  autoMerge = false,
} = {}) {
  const s = getState();
  const site = s.sites.find((x) => x.id === siteId);
  if (!site) return { error: 'site not found' };
  if (!site.repo) return { error: 'site has no GitHub repo; add one to enable auto-fix' };

  // Pin ordering: fixed set of causes captured at dispatch time. New causes
  // that show up mid-run are not adopted - they belong to the next batch.
  let planned = Array.isArray(causeIds) && causeIds.length
    ? s.causes.filter((c) => causeIds.includes(c.id) && c.siteId === siteId)
    : s.causes.filter((c) => c.siteId === siteId && c.status === 'open');
  planned = planned.filter((c) => c.status === 'open'
    && !s.tasks.some((t) => t.causeId === c.id && (t.state === 'queued' || t.state === 'working' || t.state === 'verifying' || t.state === 'awaiting_merge'))
    && !s.prs.some((p) => p.causeId === c.id && p.state === 'open'));
  if (!planned.length) return { error: 'no eligible causes to dispatch' };

  const run = {
    id: nextId('fixrun-'),
    siteId,
    plannedIds: planned.map((c) => c.id),
    remaining: planned.map((c) => c.id),
    taskIds: [],
    dispatched: 0,
    concurrency: Math.max(1, Math.min(10, Number(concurrency) || DEFAULT_CONCURRENCY)),
    budgetUsd: Math.max(0.5, Number(budgetUsd) || DEFAULT_BUDGET_USD),
    spentUsd: 0,
    autoMerge: Boolean(autoMerge),
    state: 'queued',
    startedAt: Date.now(),
    finishedAt: null,
    plannedCount: planned.length,
    error: null,
  };

  update((s2) => {
    allFixRuns(s2).unshift(run);
    s2.activity.unshift({ ts: Date.now(), msg: `Fix run ${run.id} started for ${site.url}: ${run.plannedCount} cause(s), concurrency ${run.concurrency}, budget $${run.budgetUsd.toFixed(2)}` });
  });

  // First wave. Advance() itself handles the concurrency window; subsequent
  // waves are triggered by the interval below.
  advance(run.id);
  ensureTicking();
  return { run };
}

export function cancelFixRun(runId) {
  const run = findFixRun(runId);
  if (!run) return { error: 'fix run not found' };
  if (run.state === 'complete' || run.state === 'cancelled') return { run };
  update((s) => {
    const r = findFixRun(runId, s);
    if (!r) return;
    r.state = 'cancelled';
    r.finishedAt = Date.now();
    r.remaining = [];
    s.activity.unshift({ ts: Date.now(), msg: `Fix run ${runId} cancelled by operator (${r.dispatched}/${r.plannedCount} dispatched)` });
  });
  return { run: findFixRun(runId) };
}

// Move a run one tick: dispatch until in-flight count reaches concurrency
// or the budget is exhausted, then update state accordingly.
function advance(runId) {
  const s = getState();
  const run = findFixRun(runId, s);
  if (!run) return;
  if (run.state === 'complete' || run.state === 'cancelled' || run.state === 'failed') return;

  const inFlight = () => run.taskIds
    .map((tid) => s.tasks.find((t) => t.id === tid))
    .filter((t) => t && (t.state === 'queued' || t.state === 'working' || t.state === 'verifying' || t.state === 'awaiting_merge'))
    .length;

  // Recompute spent USD from the number of tasks past the launch gate.
  const finishedTasks = () => run.taskIds
    .map((tid) => s.tasks.find((t) => t.id === tid))
    .filter((t) => t && (t.state === 'done' || t.state === 'verified' || t.state === 'merged' || t.state === 'failed'))
    .length;

  const budgetSpent = () => (finishedTasks() * COST_PER_TASK_USD) + (inFlight() * COST_PER_TASK_USD * 0.5);

  const dispatched = [];
  while (run.remaining.length && inFlight() < run.concurrency && budgetSpent() + COST_PER_TASK_USD <= run.budgetUsd) {
    const causeId = run.remaining[0];
    const cause = s.causes.find((c) => c.id === causeId);
    const site = s.sites.find((x) => x.id === run.siteId);
    if (!cause || cause.status !== 'open' || !site) {
      // Cause disappeared (site deleted) or was already fixed - drop it
      // from remaining and move on.
      run.remaining.shift();
      continue;
    }
    // Skip a cause that got picked up by another dispatch since we planned
    // this batch: two operators, or a manual dispatch racing the batch.
    if (s.tasks.some((t) => t.causeId === causeId && t.state !== 'failed')) {
      run.remaining.shift();
      continue;
    }
    let task;
    try {
      task = dispatchTask(cause, site);
    } catch (err) {
      // dispatchTask throws for missing repo etc.; log and skip.
      run.remaining.shift();
      run.error = err.message;
      continue;
    }
    run.remaining.shift();
    run.taskIds.push(task.id);
    run.dispatched += 1;
    dispatched.push(task.id);
  }

  const done = finishedTasks();
  const inflightAfter = inFlight();
  const totalAccounted = done + inflightAfter;
  const nextState = run.remaining.length === 0 && inflightAfter === 0
    ? 'complete'
    : run.dispatched > 0 ? 'running' : 'queued';

  // Only write if anything actually changed - keeps the debounced state
  // writer quiet when the run is idle waiting for tasks to finish.
  const changed = dispatched.length || run.state !== nextState
    || Math.abs(run.spentUsd - budgetSpent()) > 0.001;

  if (changed) {
    update((s2) => {
      const r = findFixRun(runId, s2);
      if (!r) return;
      r.remaining = [...run.remaining];
      r.taskIds = [...run.taskIds];
      r.dispatched = run.dispatched;
      r.spentUsd = Number(budgetSpent().toFixed(2));
      r.error = run.error;
      const prev = r.state;
      r.state = nextState;
      if (r.state === 'complete' && !r.finishedAt) r.finishedAt = Date.now();
      if (prev !== r.state && r.state === 'complete') {
        s2.activity.unshift({ ts: Date.now(), msg: `Fix run ${runId} complete: ${done}/${r.plannedCount} tasks resolved` });
      }
    });
  }
}

// A single interval covers every active run rather than per-run timers, so
// process shutdown clears one handle. Started on demand from startFixRun and
// stopped once the run set is idle.
let ticker = null;
function ensureTicking() {
  if (ticker) return;
  ticker = setInterval(() => {
    const active = allFixRuns().filter((r) => r.state === 'queued' || r.state === 'running');
    if (!active.length) {
      clearInterval(ticker);
      ticker = null;
      return;
    }
    for (const r of active) advance(r.id);
  }, ADVANCE_INTERVAL_MS);
  // Do not keep the process alive just for the fix-run ticker: production
  // shutdown or a demo `kill -TERM` should not have to wait for the loop.
  ticker.unref?.();
}

// Called on server start so a run that was still in-flight when the last
// process died keeps its wheels turning.
export function resumeFixRuns() {
  const active = allFixRuns().filter((r) => r.state === 'queued' || r.state === 'running');
  if (active.length) ensureTicking();
  return active.length;
}
