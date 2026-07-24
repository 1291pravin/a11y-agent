// Journeys: the evaluate-path counterpart to an AQA suite.
//
// A suite run is remote - AQA's infrastructure fetches the page, so it cannot
// reach localhost, preview builds, or anything behind a login. A journey
// inverts that: our own browser walks the steps and only the resulting DOM
// travels, scored by the same rule engine through /a11y/tests/evaluate.
//
// This module owns storage and the run pipeline; the model itself lives in
// journey-model.mjs. It never imports Playwright: the browser lives in a
// separate runner process (see runner/) so server/ and integrations/ keep the
// zero-runtime-dependency rule from PLAN.md. Journeys SUPPLEMENT the suite path
// - a site may have a suiteId, a journey, or both, and a journey run never
// touches suite data.

import { existsSync } from 'node:fs';
import { getState, update, nextId } from './store.mjs';
import { buildIndex, mapCause } from './mapper.mjs';
import { groupIssues, mergeCauses, diffCauses, evaluateIssuesToRaw, scoreCauses, openCauses } from './aqa-sync.mjs';
import { filterNeedFixIssues } from './issue-filter.mjs';

const RUNNER_URL = (process.env.RUNNER_URL || 'http://localhost:4174').replace(/\/$/, '');
const RUNNER_TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS) || 5 * 60 * 1000;

// Journeys were added after M5, so a state blob persisted by an earlier build
// has no `journeys` key. Lazily seed it rather than migrating the store.
export function allJourneys(state = getState()) {
  if (!state.journeys) state.journeys = [];
  return state.journeys;
}

export function findJourney(id, state = getState()) {
  return allJourneys(state).find((j) => j.id === id) || null;
}

export function makeJourney(siteId, fields) {
  return {
    id: nextId('journey-'),
    siteId,
    ...fields,
    runState: null,
    lastRun: null,
    createdAt: Date.now(),
  };
}

// ── Runner client ───────────────────────────────────────────────────────────

export async function runnerHealth() {
  try {
    const res = await fetch(`${RUNNER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, url: RUNNER_URL, error: `runner returned HTTP ${res.status}` };
    return { ok: true, url: RUNNER_URL, runner: body };
  } catch (err) {
    return { ok: false, url: RUNNER_URL, error: err.message };
  }
}

// Generic runner call. Journey discovery (journey-propose.mjs) drives /inspect
// and /dryrun through the same client so there is one place that knows where the
// runner lives and how its errors surface.
export async function callRunner(path, body, timeoutMs = RUNNER_TIMEOUT_MS) {
  const res = await fetch(`${RUNNER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw new Error(parsed?.error || `runner returned HTTP ${res.status}`);
  return parsed;
}

// ── Run pipeline ────────────────────────────────────────────────────────────

// Fire-and-forget from the run endpoint, mirroring startRealScan: the caller
// gets a 202 and watches journey.runState / journey.lastRun.
export function startJourneyRun(journeyId) {
  update((s) => {
    const j = findJourney(journeyId, s);
    if (j) j.runState = 'running';
    s.activity.unshift({ ts: Date.now(), msg: `Journey run started: ${j?.name || journeyId}` });
  });

  return runJourney(journeyId).then(() => true).catch((err) => {
    update((s) => {
      const j = findJourney(journeyId, s);
      if (j) {
        j.runState = null;
        j.lastRun = { at: Date.now(), ok: false, error: err.message, snapshots: [], steps: [] };
      }
      s.activity.unshift({ ts: Date.now(), msg: `Journey run failed: ${j?.name || journeyId}: ${err.message}` });
    });
    return false;
  });
}

async function runJourney(journeyId) {
  const journey = findJourney(journeyId);
  if (!journey) throw new Error('journey not found');
  const result = await callRunner('/run', { journey });

  // A journey that aborted part way through saw only part of the site. Folding
  // that into the cause set would read as "the rest got fixed", so a failed run
  // is recorded and the previous causes are left exactly as they were.
  if (!result.ok) {
    update((s) => {
      const j = findJourney(journeyId, s);
      if (j) {
        j.runState = null;
        j.lastRun = {
          at: Date.now(),
          ok: false,
          error: result.error || 'journey run failed',
          ms: result.ms ?? null,
          steps: result.steps || [],
          snapshots: summarize(result.snapshots),
        };
      }
      s.activity.unshift({ ts: Date.now(), msg: `Journey run failed: ${journey.name}: ${result.error || 'unknown error'} (causes left unchanged)` });
    });
    return;
  }

  // Same manual/need-fix split the suite path applies (aqa-sync). A snapshot can
  // opt into manual checks, but manual findings are advisory: they are counted
  // and reported per snapshot, never turned into causes and never scored, so
  // "fix-required" means the same thing on both paths.
  const raw = filterNeedFixIssues(evaluateIssuesToRaw(result.snapshots));
  const nextCauses = groupIssues(raw, journey.siteId, {
    idPrefix: `cause-${journey.id}`,
    source: 'journey',
    journeyId: journey.id,
  });

  // Same source mapping the suite path gets (M3), so journey causes are
  // dispatchable rather than export-only.
  const site = getState().sites.find((x) => x.id === journey.siteId);
  if (site?.repoPath && existsSync(site.repoPath)) {
    try {
      const index = buildIndex(site.repoPath);
      for (const cause of nextCauses) {
        if (!cause.mappedFile) cause.mappedFile = mapCause(cause, index);
      }
    } catch (err) {
      console.error(`journeys: mapping failed for ${journey.id}:`, err.message);
    }
  }

  update((s) => {
    const j = findJourney(journeyId, s);
    if (!j) return;
    // Scoped to this journey's own causes on both sides: the site's suite
    // causes, and any other journey's, are untouched by this diff.
    const prevCauses = s.causes.filter((c) => c.journeyId === journey.id);
    const merged = mergeCauses(prevCauses, nextCauses);
    const diff = diffCauses(prevCauses, merged);
    s.causes = s.causes.filter((c) => c.journeyId !== journey.id).concat(merged);

    const snaps = summarize(result.snapshots);
    // Carried forward so the report can show a real movement rather than
    // inventing a delta.
    const prevScore = j.lastRun?.score?.score ?? null;

    j.runState = null;
    j.lastRun = {
      at: Date.now(),
      ok: true,
      ms: result.ms ?? null,
      steps: result.steps || [],
      snapshots: snaps,
      causes: merged.length,
      diff,
      score: scoreCauses(openCauses(merged), { units: Math.max(1, snaps.length) }),
      prevScore,
    };
    s.activity.unshift({
      ts: Date.now(),
      msg: `Journey run finished: ${j.name}: ${merged.length} root cause(s), ${diff.new.length} new, ${diff.fixed.length} fixed, ${diff.persisting.length} persisting`,
    });
  });
}

// Issues become causes; the run record keeps only per-snapshot counts so state
// stays small enough to ship whole on every /api/state poll.
function summarize(snapshots = []) {
  return snapshots.map((s) => {
    const all = s.issues || [];
    const fix = filterNeedFixIssues(all);
    return {
      label: s.label,
      pageUrl: s.pageUrl,
      context: s.context || null,
      status: s.status,
      error: s.error || null,
      ms: s.ms ?? null,
      bytes: s.bytes ?? null,
      // issues is the fix-required count, matching what becomes causes and what
      // the score counts. Manual findings are surfaced separately rather than
      // dropped silently, so a snapshot that asked for them still reports them.
      issues: fix.length,
      manualIssues: all.length - fix.length,
    };
  });
}
