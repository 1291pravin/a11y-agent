// Task lifecycle: queued -> working -> verifying -> done | failed | reopened.
// Real mode: dispatch launches a Cursor Background Agent and polls it.
// Demo mode: a timer advances tasks through scripted stages so the office can
// test the full loop without credentials. Both modes park at "verifying" once
// a PR is open; merge intake (webhook or manual) drives verification (M4).

import { getState, update, nextId } from './store.mjs';
import * as cursor from '../integrations/cursor.mjs';
import * as aqa from '../integrations/aqa.mjs';
import { hydrateSite, mergeCauses, diffCauses } from './aqa-sync.mjs';

const DEMO_STAGE_MS = Number(process.env.DEMO_STAGE_MS) || 5000;
const DEMO_VERIFY_MS = Number(process.env.DEMO_VERIFY_MS) || 2000;
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
// Advances demo tasks one stage per tick and fabricates the PR. Tasks stop at
// "verifying" (PR open, awaiting merge) - like real mode, completion happens
// only through merge intake (POST /api/prs/:num/merged or the GitHub webhook).

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

// Fire-and-forget from the scan endpoint; verification awaits the returned
// promise, which resolves true when the rescan completed and false on error.
export function startRealScan(siteId) {
  update((s) => {
    const site = s.sites.find((x) => x.id === siteId);
    if (site) {
      site.scanState = 'running';
      // Progress facts for the UI. AQA reports no percentage, so the webapp shows
      // elapsed against this deadline plus the current stage - never a fabricated bar.
      site.scanStartedAt = Date.now();
      site.scanDeadlineAt = Date.now() + SCAN_TIMEOUT_MS;
      site.scanStage = 'starting';
      site.scanRunId = null;
      site.scanError = null;
    }
    s.activity.unshift({ ts: Date.now(), msg: `AQA scan started for ${site?.url || siteId}` });
  });
  return runRealScan(siteId).then(() => true).catch((err) => {
    update((s) => {
      const site = s.sites.find((x) => x.id === siteId);
      if (site) {
        clearScanProgress(site);
        site.scanError = err.message;
      }
      s.activity.unshift({ ts: Date.now(), msg: `AQA scan failed for ${site?.url || siteId}: ${err.message}` });
    });
    return false;
  });
}

// Scan progress bookkeeping lives in one place so every exit path clears the
// same fields; a stale scanState leaves the UI showing a spinner forever.
function setScanStage(siteId, stage, patch = {}) {
  update((s) => {
    const site = s.sites.find((x) => x.id === siteId);
    if (!site || site.scanState !== 'running') return;
    site.scanStage = stage;
    Object.assign(site, patch);
  });
}

function clearScanProgress(site) {
  site.scanState = null;
  site.scanStartedAt = null;
  site.scanDeadlineAt = null;
  site.scanStage = null;
  site.scanRunId = null;
}

async function runRealScan(siteId) {
  const site = getState().sites.find((x) => x.id === siteId);
  if (!site) throw new Error('site not found');
  const runId = await startRun(site.testId);
  setScanStage(siteId, 'polling', { scanRunId: runId });
  await waitForRun(runId);
  setScanStage(siteId, 'collecting');

  const hydrated = await hydrateSite({
    id: site.id,
    url: site.url,
    repo: site.repo,
    repoPath: site.repoPath,
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
    clearScanProgress(next);
    next.scanError = null;
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

// ── Merge verification (M4) ─────────────────────────────────────────────────
// Merge intake (GitHub webhook or POST /api/prs/:num/merged) calls verifyMerge
// with the open PR record. Real mode re-runs the site's AQA test and reads the
// cause back from the re-hydrated state; demo mode simulates the rescan. A
// cleared cause completes the task; a persisting one reopens it for re-dispatch.

export async function verifyMerge(pr) {
  const task = getState().tasks.find((t) => t.id === pr.taskId);
  const causeId = task?.causeId;
  const before = getState().causes.find((c) => c.id === causeId)?.instances ?? pr.instances ?? 0;

  update((s) => {
    const p = s.prs.find((x) => x.taskId === pr.taskId && x.num === pr.num);
    if (p) p.state = 'merged-verifying';
    const t = s.tasks.find((x) => x.id === pr.taskId);
    if (t) t.log.push(line('merge detected, starting verification re-run'));
    s.activity.unshift({ ts: Date.now(), msg: `PR #${pr.num} merged - verification re-run started` });
  });

  const site = getState().sites.find((x) => x.id === pr.siteId);
  const realScan = aqa.isReal && !!site?.testId && process.env.DEMO_FAST_VERIFY !== '1';
  if (realScan) {
    const ok = await startRealScan(site.id);
    if (!ok) {
      // Rescan never completed: not a verdict on the fix. Put the PR back to
      // "open" so the merge can be re-posted once AQA recovers.
      update((s) => {
        const p = s.prs.find((x) => x.taskId === pr.taskId && x.num === pr.num);
        if (p) p.state = 'open';
        const t = s.tasks.find((x) => x.id === pr.taskId);
        if (t) t.log.push(line('verification rescan failed - re-post the merge to retry'));
      });
      return;
    }
  } else {
    await sleep(DEMO_VERIFY_MS);
  }

  // After a real rescan a fixed cause is absent from state; a persisting one
  // kept its id (mergeCauses). Demo simulates the same outcome via the knobs.
  const cause = getState().causes.find((c) => c.id === causeId);
  const persists = realScan
    ? !!cause && cause.instances > 0
    : !!cause && (cause.ruleId?.endsWith('-persist') || process.env.DEMO_VERIFY_FAIL === '1');
  const after = persists ? cause.instances : 0;
  settleVerification(pr, causeId, before, after, realScan);
}

function settleVerification(prRef, causeId, before, after, realScan) {
  update((s) => {
    const pr = s.prs.find((x) => x.taskId === prRef.taskId && x.num === prRef.num);
    const task = s.tasks.find((t) => t.id === prRef.taskId);
    const cause = s.causes.find((c) => c.id === causeId);
    const site = s.sites.find((x) => x.id === prRef.siteId);
    if (after <= 0) {
      const cleared = before;
      if (task) {
        task.state = 'done';
        task.log.push(line(`AQA re-run complete: ${cleared} violations cleared`));
      }
      if (pr) { pr.state = 'merged-verified'; pr.verification.actual = -cleared; }
      if (cause) cause.status = 'fixed';
      // Real rescans re-hydrate site counters; the demo path adjusts them here.
      if (!realScan && site && cause) {
        site.total = Math.max(0, site.total - cleared);
        if (cause.severity === 'critical') site.critical = Math.max(0, site.critical - 1);
        if (site.critical === 0 && site.status === 'critical') site.status = site.total > 0 ? 'fixing' : 'healthy';
      }
      s.activity.unshift({ ts: Date.now(), msg: `Task ${prRef.taskId} verified: ${cleared} violations cleared` });
    } else {
      if (task) {
        task.state = 'reopened';
        task.log.push(line(`AQA re-run complete: ${after} of ${before} instances still failing`));
        if (site?.lastDiff) {
          task.log.push(line(`re-run diff: ${site.lastDiff.new.length} new, ${site.lastDiff.fixed.length} fixed, ${site.lastDiff.persisting.length} persisting`));
        }
        task.log.push(line('REOPENED: fix did not clear the cause - re-dispatch when ready'));
      }
      if (pr) { pr.state = 'merged-unverified'; pr.verification.actual = -(before - after); }
      if (cause) cause.status = 'open';
      s.activity.unshift({ ts: Date.now(), msg: `Task ${prRef.taskId} verification failed: ${after} instances persist - task reopened` });
    }
  });
}

// Demo scan: fabricate a run for a site (used by "Run tests" button).
// Staged rather than instant so demo mode exercises the same scanState/scanStage
// rendering as real mode - the same reasoning M4 applied to the verification loop.
const DEMO_SCAN_MS = Number(process.env.DEMO_SCAN_MS) || 2000;

export function demoScan(site) {
  update((s) => {
    const target = s.sites.find((x) => x.id === site.id);
    if (!target) return;
    target.scanState = 'running';
    target.scanStartedAt = Date.now();
    target.scanDeadlineAt = Date.now() + DEMO_SCAN_MS * 2;
    target.scanStage = 'starting';
    target.scanRunId = null;
    target.scanError = null;
    s.activity.unshift({ ts: Date.now(), msg: `Demo scan started for ${target.url}` });
  });

  setTimeout(() => setScanStage(site.id, 'polling', { scanRunId: 'demo-run' }), DEMO_SCAN_MS / 2);

  setTimeout(() => {
    update((s) => {
      const target = s.sites.find((x) => x.id === site.id);
      if (!target) return;
      clearScanProgress(target);
      target.scanError = null;
      target.lastRun = 'just now';
      for (const f of target.flows) {
        if (f.type === 'Skipped') continue;
        f.delta = '0';
      }
      s.activity.unshift({ ts: Date.now(), msg: `Demo scan completed for ${target.url}` });
    });
  }, DEMO_SCAN_MS).unref?.();
}
