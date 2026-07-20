// Task lifecycle: queued -> working -> verifying -> done | failed.
// Real mode: dispatch launches a Cursor Background Agent and polls it.
// Demo mode: a timer advances tasks through scripted stages so the office can
// test the full loop without credentials.

import { getState, update, nextId } from './store.mjs';
import * as cursor from '../integrations/cursor.mjs';

const DEMO_STAGE_MS = 5000;

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
  const timer = setInterval(async () => {
    const t = getState().tasks.find((x) => x.id === taskId);
    if (!t || t.state === 'done' || t.state === 'failed') return clearInterval(timer);
    if (!t.agentId || !t.runId) return;
    try {
      const run = await cursor.getRun(t.agentId, t.runId);
      const status = (run.status || '').toUpperCase();
      if (status === 'FINISHED') {
        clearInterval(timer);
        const prUrl = run.git?.branches?.find((b) => b.prUrl)?.prUrl || null;
        update((s) => {
          const task = s.tasks.find((x) => x.id === taskId);
          if (!task) return;
          task.state = 'verifying';
          task.pr = prUrl ? { url: prUrl, num: prUrl.split('/').pop() } : null;
        });
        addLog(taskId, `agent finished, PR: ${prUrl || 'none reported'}`);
        // M4: verification re-run happens on merge webhook; until then task parks
        // in "verifying" for human review.
      } else if (['ERROR', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status)) {
        clearInterval(timer);
        failTask(taskId, `cursor run reported ${status}`);
      }
    } catch (err) {
      addLog(taskId, `poll error: ${err.message}`);
    }
  }, 15000);
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
