// Task lifecycle: queued -> working -> verifying -> done | failed.
// Real mode: dispatch launches a Cursor Background Agent and polls it.
// Demo mode: a timer advances tasks through scripted stages so the office can
// test the full loop without credentials.

import { getState, update, nextId } from './store.mjs';
import * as cursor from '../integrations/cursor.mjs';
import * as aqa from '../integrations/aqa.mjs';
import { hydrateSite, mergeCauses, diffCauses } from './aqa-sync.mjs';

const DEMO_STAGE_MS = 5000;
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;
const CURSOR_MAX_POLL_ERRORS = 10;

export function dispatchTask(cause, site) {
  const task = {
    id: nextId('task-'),
    causeId: cause.id,
    siteId: site.id,
    title: cause.title,
    file: cause.mappedFile,
    state: 'queued',
    agent: cursor.isReal ? 'cursor' : 'demo',
    agentId: null,
    log: [line(`task created for root cause "${cause.title}" (${cause.instances} instances)`)],
    pr: null,
    createdAt: Date.now(),
  };
  update((s) => {
    s.tasks.unshift(task);
    cause.status = 'task';
    s.activity.unshift({ ts: Date.now(), msg: `Dispatched fix task ${task.id}: ${cause.title}` });
  });

  if (cursor.isReal) launchReal(task, cause, site).catch((err) => failTask(task.id, err.message));
  return task;
}

async function launchReal(task, cause, site) {
  const prompt = cursor.buildFixPrompt(cause, site);
  addLog(task.id, `launching Cursor cloud agent on ${site.repo} (${cursor.MODEL_ID})`);
  const agent = await cursor.launchAgent({ repo: site.repo, prompt });
  update((s) => {
    const t = s.tasks.find((x) => x.id === task.id);
    if (t) { t.agentId = agent.id; t.runId = agent.runId; t.state = 'working'; }
  });
  addLog(task.id, `cursor agent ${agent.id} started (run ${agent.runId})`);
  pollReal(task.id);
}

function pollReal(taskId) {
  const pollMs = Number(process.env.CURSOR_POLL_MS) || 15000;
  const deadlineMs = Number(process.env.CURSOR_POLL_DEADLINE_MS) || 30 * 60 * 1000;
  const deadline = Date.now() + deadlineMs;
  let pollErrors = 0;
  const timer = setInterval(async () => {
    const t = getState().tasks.find((x) => x.id === taskId);
    if (!t || t.state === 'done' || t.state === 'failed') return clearInterval(timer);
    if (!t.agentId || !t.runId) return;
    if (Date.now() >= deadline) {
      clearInterval(timer);
      return failTask(taskId, `cursor run not terminal after ${Math.round(deadlineMs / 60000)} min - poll deadline expired`);
    }
    try {
      const run = await cursor.getRun(t.agentId, t.runId);
      pollErrors = 0;
      const status = (run.status || '').toUpperCase();
      if (status === 'FINISHED') {
        clearInterval(timer);
        finishReal(taskId, run);
      } else if (['ERROR', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status)) {
        clearInterval(timer);
        failTask(taskId, `cursor run reported ${status}`);
      }
    } catch (err) {
      pollErrors += 1;
      addLog(taskId, `poll error (${pollErrors}/${CURSOR_MAX_POLL_ERRORS}): ${err.message}`);
      if (pollErrors >= CURSOR_MAX_POLL_ERRORS) {
        clearInterval(timer);
        failTask(taskId, `${CURSOR_MAX_POLL_ERRORS} consecutive poll errors, last: ${err.message}`);
      }
    }
  }, pollMs);
}

// Agent run reached FINISHED: park the task in "verifying" and, when a PR was
// opened, record it in state.prs (same shape as the demo path).
// M4: verification re-run happens on merge webhook; until then task parks
// in "verifying" for human review.
function finishReal(taskId, run) {
  const prUrl = run.git?.branches?.find((b) => b.prUrl)?.prUrl || null;
  update((s) => {
    const task = s.tasks.find((x) => x.id === taskId);
    if (!task) return;
    task.state = 'verifying';
    if (!prUrl) {
      task.pr = null;
      task.log.push(line('agent finished without reporting a PR - needs a human look'));
      return;
    }
    const num = prUrl.split('/').pop();
    task.pr = { url: prUrl, num };
    task.log.push(line(`agent finished, PR: ${prUrl}`));
    const cause = s.causes.find((c) => c.id === task.causeId);
    s.prs.unshift({
      num,
      url: prUrl,
      taskId: task.id,
      siteId: task.siteId,
      title: `fix(a11y): ${task.title.toLowerCase()}`,
      state: 'open',
      rule: cause?.rule,
      evidence: cause?.evidence,
      instances: cause?.instances,
      pages: cause?.pages,
      file: task.file,
      verification: { expected: -(cause?.instances || 0), actual: null },
    });
    if (cause) cause.status = 'pr';
    s.activity.unshift({ ts: Date.now(), msg: `Cursor agent opened PR #${num} for task ${task.id}` });
  });
}

// Restart recovery: poll timers live in memory, so a process restart strands
// in-flight cursor tasks. Called once from index.mjs after the server starts.
export function resumePolling() {
  for (const t of getState().tasks) {
    if (t.agent !== 'cursor' || !['queued', 'working'].includes(t.state)) continue;
    if (!t.agentId) { failTask(t.id, 'orphaned by restart - re-dispatch'); continue; }
    if (!cursor.isReal) { failTask(t.id, 'CURSOR_API_KEY missing after restart - re-dispatch'); continue; }
    addLog(t.id, `resuming poll for cursor agent ${t.agentId} after restart`);
    pollReal(t.id);
  }
}

function failTask(taskId, reason) {
  update((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (t) { t.state = 'failed'; t.log.push(line(`FAILED: ${reason}`)); }
  });
}

function addLog(taskId, msg) {
  update((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (t) t.log.push(line(msg));
  });
}

function line(msg) { return `[${new Date().toISOString().slice(11, 19)}] ${msg}`; }

// ── Demo simulation ─────────────────────────────────────────────────────────
// Advances demo tasks one stage per tick and fabricates the PR + verification.

const DEMO_SCRIPT = {
  queued: (t, s) => {
    t.state = 'working';
    const site = s.sites.find((x) => x.id === t.siteId);
    t.log.push(line(`cloned ${site?.repo} @ main, branch a11y/${t.id}`));
    t.log.push(line(`reading ${t.file || 'affected components'}`));
  },
  working: (t, s) => {
    t.state = 'verifying';
    const cause = s.causes.find((c) => c.id === t.causeId);
    t.log.push(line('patch written, unit tests pass'));
    const num = String(880 + s.prs.length + 1);
    t.pr = { num, url: `https://github.com/${s.sites.find((x) => x.id === t.siteId)?.repo}/pull/${num}` };
    t.log.push(line(`PR #${num} opened, awaiting review`));
    s.prs.unshift({
      num,
      taskId: t.id,
      siteId: t.siteId,
      title: `fix(a11y): ${t.title.toLowerCase()}`,
      state: 'open',
      rule: cause?.rule,
      evidence: cause?.evidence,
      instances: cause?.instances,
      pages: cause?.pages,
      file: t.file,
      verification: { expected: -(cause?.instances || 0), actual: null },
    });
    if (cause) cause.status = 'pr';
  },
  verifying: (t, s) => {
    t.state = 'done';
    const cause = s.causes.find((c) => c.id === t.causeId);
    const pr = s.prs.find((p) => p.taskId === t.id);
    const cleared = cause?.instances || 0;
    t.log.push(line(`merged (demo), AQA re-run complete: ${cleared} violations cleared`));
    if (pr) { pr.state = 'merged-verified'; pr.verification.actual = -cleared; }
    if (cause) cause.status = 'fixed';
    const site = s.sites.find((x) => x.id === t.siteId);
    if (site && cause) {
      site.total = Math.max(0, site.total - cleared);
      if (cause.severity === 'critical') site.critical = Math.max(0, site.critical - 1);
      if (site.critical === 0 && site.status === 'critical') site.status = site.total > 0 ? 'fixing' : 'healthy';
    }
    s.activity.unshift({ ts: Date.now(), msg: `Task ${t.id} verified: ${cleared} violations cleared` });
  },
};

setInterval(() => {
  const s = getState();
  const pending = s.tasks.filter((t) => t.agent === 'demo' && DEMO_SCRIPT[t.state]);
  if (!pending.length) return;
  update((state) => {
    for (const t of state.tasks) {
      if (t.agent === 'demo' && DEMO_SCRIPT[t.state]) DEMO_SCRIPT[t.state](t, state);
    }
  });
}, DEMO_STAGE_MS);

// ── Real AQA scan ───────────────────────────────────────────────────────────
// Trigger a run, poll until terminal, then re-hydrate the site from the fresh
// results. Cause statuses survive re-hydration (mergeCauses) so in-flight
// tasks stay linked; the run delta lands on site.lastDiff.

export function startRealScan(siteId) {
  update((s) => {
    const site = s.sites.find((x) => x.id === siteId);
    if (site) site.scanState = 'running';
    s.activity.unshift({ ts: Date.now(), msg: `AQA scan started for ${site?.url || siteId}` });
  });
  runRealScan(siteId).catch((err) => {
    update((s) => {
      const site = s.sites.find((x) => x.id === siteId);
      if (site) site.scanState = null;
      s.activity.unshift({ ts: Date.now(), msg: `AQA scan failed for ${site?.url || siteId}: ${err.message}` });
    });
  });
}

async function runRealScan(siteId) {
  const site = getState().sites.find((x) => x.id === siteId);
  if (!site) throw new Error('site not found');
  const runId = await startRun(site.testId);
  await waitForRun(runId);

  const hydrated = await hydrateSite({
    id: site.id,
    url: site.url,
    repo: site.repo,
    suiteId: site.suiteId,
    testId: site.testId,
    framework: site.framework,
  });

  update((s) => {
    const idx = s.sites.findIndex((x) => x.id === siteId);
    if (idx === -1) return;
    const prev = s.sites[idx];
    const prevCauses = s.causes.filter((c) => c.siteId === siteId);
    const causes = mergeCauses(prevCauses, hydrated.causes);
    const next = hydrated.site;
    next.trend = [...(prev.trend || []), next.total].slice(-12);
    next.scanState = null;
    next.lastDiff = diffCauses(prevCauses, causes);
    s.sites[idx] = next;
    s.causes = s.causes.filter((c) => c.siteId !== siteId).concat(causes);
    s.activity.unshift({
      ts: Date.now(),
      msg: `AQA scan finished for ${next.url}: ${next.lastDiff.new.length} new, ${next.lastDiff.fixed.length} fixed, ${next.lastDiff.persisting.length} persisting`,
    });
  });
}

async function startRun(testId) {
  const started = await aqa.testRun(testId);
  const runId = started?.id || started?.runId || started?.run?.id;
  if (runId) return runId;
  // Some deployments only ack the trigger; fall back to the newest run on the test.
  const test = await aqa.testGet(testId);
  const latest = test.runs?.[0]?.id;
  if (!latest) throw new Error('testRun returned no run id and the test lists no runs');
  return latest;
}

// runGet's exact shape is unverified (see aqa.mjs); read status defensively.
async function waitForRun(runId) {
  const pollMs = Number(process.env.AQA_POLL_MS) || 10000;
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  for (;;) {
    const run = await aqa.runGet(runId);
    const status = String(run?.status || run?.state || '').toLowerCase();
    if (['finished', 'completed', 'done', 'success', 'succeeded'].includes(status)) return run;
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(`run ${runId} ended with status "${status}"`);
    }
    if (Date.now() >= deadline) throw new Error(`run ${runId} still not terminal after ${SCAN_TIMEOUT_MS / 60000} min`);
    await sleep(pollMs);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Demo scan: fabricate a completed run for a site (used by "Run tests" button).
export function demoScan(site) {
  update((s) => {
    const target = s.sites.find((x) => x.id === site.id);
    if (!target) return;
    target.lastRun = 'just now';
    for (const f of target.flows) {
      if (f.type === 'Skipped') continue;
      f.delta = '0';
    }
    s.activity.unshift({ ts: Date.now(), msg: `Demo scan completed for ${target.url}` });
  });
}
