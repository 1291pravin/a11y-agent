// Shared AQA hydration: fetch a site's latest run, collect issues, group them
// by root cause. Used by bootstrap.mjs (startup fleet load) and orchestrator.mjs
// (rescan pipeline) so both paths produce identical site/cause shapes.

import { existsSync } from 'node:fs';
import * as aqa from '../integrations/aqa.mjs';
import { filterNeedFixIssues } from './issue-filter.mjs';
import { buildIndex, mapCause } from './mapper.mjs';
import { triageCauses } from './triage.mjs';

export async function hydrateSite(cfg) {
  const suite = await aqa.suiteGet(cfg.suiteId);
  let test = null;
  let latestRun = null;

  if (cfg.testId) {
    test = await aqa.testGet(cfg.testId);
    latestRun = test.runs?.[0] || null;
    if (!cfg.suiteId && test.suite?.id) cfg.suiteId = test.suite.id;
  }

  const flows = [];
  let critical = 0;
  let total = 0;

  if (latestRun?.id) {
    const runFlows = (await aqa.runFlows(latestRun.id)).flows || [];
    const runFlowById = new Map(runFlows.map((f) => [f.id, f]));

    for (const flow of suite.flows || []) {
      const runFlow = runFlowById.get(flow.id);
      const counts = issueCounts(runFlow?.review?.issues);
      critical += counts.high;
      total += counts.total;
      flows.push({
        name: flow.name,
        type: flowTypeLabel(flow.type),
        status: flowStatus(counts),
        violations: counts.total || null,
        delta: formatDelta(runFlow?.review?.a11yScore?.delta),
      });
    }

    for (const runFlow of runFlows) {
      if (flows.some((f) => f.name === runFlow.name)) continue;
      const counts = issueCounts(runFlow.review?.issues);
      critical += counts.high;
      total += counts.total;
      flows.push({
        name: runFlow.name,
        type: 'Click-state',
        status: flowStatus(counts),
        violations: counts.total || null,
        delta: formatDelta(runFlow.review?.a11yScore?.delta),
      });
    }
  } else {
    for (const flow of suite.flows || []) {
      flows.push({
        name: flow.name,
        type: flowTypeLabel(flow.type),
        status: 'idle',
        violations: null,
        delta: '',
      });
    }
    for (const crawler of suite.crawlers || []) {
      flows.push({
        name: crawler.name,
        type: 'Crawler',
        status: 'idle',
        violations: null,
        delta: '',
      });
    }
  }

  const rawIssues = latestRun ? await collectIssues(latestRun.id, suite, test) : [];
  const issues = filterNeedFixIssues(rawIssues);
  const grouped = await triageCauses(groupIssues(issues, cfg.id), { siteUrl: cfg.url });

  // Root-cause mapper (M3): when the site has a local clone of its frontend
  // repo, index it once per hydration and map each cause to a file:line.
  // Missing/nonexistent repoPath is not an error - causes stay unmapped.
  if (cfg.repoPath && existsSync(cfg.repoPath)) {
    try {
      const index = buildIndex(cfg.repoPath);
      for (const cause of grouped) {
        if (!cause.mappedFile) cause.mappedFile = mapCause(cause, index);
      }
    } catch (err) {
      console.error(`aqa-sync: mapping failed for ${cfg.id}:`, err.message);
    }
  }

  return {
    site: {
      id: cfg.id,
      url: cfg.url || guessUrl(suite, flows),
      repo: cfg.repo,
      repoPath: cfg.repoPath || null,
      suiteId: cfg.suiteId,
      testId: cfg.testId || test?.definition?.id || null,
      status: siteStatus(critical, total, flows.length),
      critical,
      total,
      trend: [],
      lastRun: latestRun ? formatRelativeTime(latestRun.time) : (test ? 'no runs yet' : null),
      framework: cfg.framework || 'unknown',
      flows,
    },
    causes: grouped,
  };
}

async function collectIssues(runId, suite, test) {
  const issues = [];
  const runFlows = (await aqa.runFlows(runId)).flows || [];
  const flowIds = runFlows.map((f) => f.id);
  const maxFlows = 4;
  const maxSteps = 5;

  for (const flowId of flowIds.slice(0, maxFlows)) {
    const runFlow = runFlows.find((f) => f.id === flowId);
    const steps = runFlow?.numSteps || 1;
    for (let step = 0; step < Math.min(steps, maxSteps); step++) {
      try {
        // manual=false → AQA "Need fix" bucket (actionable violations).
        const res = await aqa.runFlowIssues(runId, flowId, { stepIndex: step, manual: false });
        for (const issue of res.issues || []) {
          issues.push({ ...issue, flowName: runFlow?.name || flowId, step });
        }
      } catch {
        // Some steps may have no issue payload; skip.
      }
      if (issues.length >= 80) return issues;
    }
  }

  return issues;
}

// Normalize a CSS selector for grouping: strip positional pseudo-classes
// (:nth-child(n), :nth-of-type(n)), trailing "> *" chains, and collapse
// whitespace - so the same component rendered on different pages (or at
// different list positions) groups into one root cause.
export function normalizeSelector(selector) {
  const normalized = String(selector || '')
    .replace(/:nth-(?:child|of-type)\([^)]*\)/g, '')
    .replace(/(\s*>\s*\*)+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || 'unknown';
}

// Group raw issues into root causes. `opts` exists so the evaluate/journey path
// can share this function without colliding with the suite path: journey causes
// get their own id namespace and carry the journey they came from, so a journey
// run only ever replaces its own causes and never the suite's.
export function groupIssues(issues, siteId, opts = {}) {
  const { idPrefix = `cause-${siteId}`, source = 'suite', journeyId = null } = opts;
  const groups = new Map();
  for (const issue of issues) {
    const selector = normalizeSelector(issue.selectors?.[0] || issue.solutionId || 'unknown');
    const key = `${issue.ruleId}|${selector}`;
    if (!groups.has(key)) {
      groups.set(key, {
        siteId,
        title: issue.needFixTitle || issue.ruleTitle || issue.ruleShortTitle,
        rule: issue.ruleShortTitle || issue.ruleTitle,
        ruleId: issue.ruleId || issue.solutionId,
        severity: mapSeverity(issue.properties),
        instances: 0,
        pages: new Set(),
        mappedFile: null,
        status: 'open',
        evidence: formatEvidence(issue),
      });
    }
    const g = groups.get(key);
    g.instances += 1;
    g.pages.add(issue.flowName || 'flow');
  }

  return [...groups.values()]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.instances - a.instances)
    .map((g, i) => ({
      id: `${idPrefix}-${i + 1}`,
      siteId: g.siteId,
      source,
      journeyId,
      title: g.title,
      rule: g.rule,
      ruleId: g.ruleId,
      severity: g.severity,
      instances: g.instances,
      pages: [...g.pages].slice(0, 5),
      mappedFile: g.mappedFile,
      status: g.status,
      evidence: g.evidence,
    }));
}

// ── Evaluate path adapter ───────────────────────────────────────────────────
// The stateless /a11y/tests/evaluate endpoint runs the same rule engine as a
// suite run, so per the vendored spec its issues already carry every field
// groupIssues reads: ruleId, solutionId, selectors[], ruleShortTitle,
// ruleTitle, needFixTitle, tagName, properties[]. The only thing genuinely
// absent is flow attribution, because a journey snapshot has no AQA flow: the
// snapshot label stands in for flowName, and the snapshot's position in the
// journey stands in for step.
//
// This is the single place an evaluate response is reshaped. If the live API
// names a field differently from the spec, correct it HERE rather than
// teaching groupIssues about two sources.
export function evaluateIssuesToRaw(snapshots = []) {
  const raw = [];
  snapshots.forEach((snap, index) => {
    for (const issue of snap.issues || []) {
      raw.push({ ...issue, flowName: snap.label || `snapshot-${index + 1}`, step: index });
    }
  });
  return raw;
}

// Re-hydration after a rescan: keep id/status/mappedFile of causes that match a
// previous cause (same ruleId + title) so in-flight tasks stay linked.
export function mergeCauses(prevCauses, nextCauses) {
  const prevByKey = new Map(prevCauses.map((c) => [causeKey(c), c]));
  const claimed = new Set();
  const merged = nextCauses.map((next) => {
    const prev = prevByKey.get(causeKey(next));
    if (prev && !claimed.has(prev.id)) {
      claimed.add(prev.id);
      // A mappedFile that survived a merge is never overwritten; a previously
      // unmapped cause may pick up a fresh mapping from the new hydration.
      return { ...next, id: prev.id, status: prev.status, mappedFile: prev.mappedFile ?? next.mappedFile };
    }
    return { ...next };
  });

  // Freshly generated ids can collide with a preserved id; renumber the fresh ones.
  const seen = new Set(claimed);
  for (const c of merged) {
    if (claimed.has(c.id)) continue;
    if (!seen.has(c.id)) { seen.add(c.id); continue; }
    let n = 1;
    let id;
    do { id = `${c.id}-${n++}`; } while (seen.has(id));
    c.id = id;
    seen.add(id);
  }
  return merged;
}

// Diff two cause sets (previous vs current) into { new, fixed, persisting, at }.
// "fixed" = present before, absent now; "new" = absent before, present now.
export function diffCauses(prevCauses, nextCauses) {
  const prevKeys = new Set(prevCauses.map(causeKey));
  const nextKeys = new Set(nextCauses.map(causeKey));
  const entry = (c) => ({ title: c.title, ruleId: c.ruleId, instances: c.instances });
  return {
    new: nextCauses.filter((c) => !prevKeys.has(causeKey(c))).map(entry),
    fixed: prevCauses.filter((c) => !nextKeys.has(causeKey(c))).map(entry),
    persisting: nextCauses.filter((c) => prevKeys.has(causeKey(c))).map(entry),
    at: Date.now(),
  };
}

function causeKey(c) { return `${c.ruleId}|${c.title}`; }

function issueCounts(reviewIssues) {
  if (!reviewIssues?.severity) return { high: 0, total: 0 };
  const { low, medium, high } = reviewIssues.severity;
  const highN = high?.numIssues || 0;
  const total = (low?.numIssues || 0) + (medium?.numIssues || 0) + highN;
  return { high: highN, total };
}

function flowTypeLabel(type) {
  if (type === 'keyboard') return 'Keyboard';
  if (type === 'functional') return 'URL';
  return type || 'URL';
}

function flowStatus({ high, total }) {
  if (high > 0) return 'critical';
  if (total > 0) return 'issues';
  return 'pass';
}

function siteStatus(critical, total, flowCount) {
  if (!flowCount) return 'onboarding';
  if (critical > 0) return 'critical';
  if (total > 0) return 'fixing';
  return 'healthy';
}

function mapSeverity(properties = []) {
  const p = properties.map((x) => String(x).toLowerCase());
  if (p.includes('high')) return 'critical';
  if (p.includes('medium')) return 'serious';
  return 'minor';
}

function severityRank(sev) {
  return { critical: 3, serious: 2, minor: 1 }[sev] || 0;
}

function formatEvidence(issue) {
  const sel = issue.selectors?.length ? issue.selectors.join(', ') : '';
  return `<${issue.tagName || 'element'}${sel ? ` ${sel}` : ''}> — ${issue.needFixTitle || issue.ruleTitle || ''}`;
}

function formatDelta(delta) {
  if (delta == null || delta === '') return '0';
  const n = Number(delta);
  if (Number.isNaN(n) || n === 0) return '0';
  return n > 0 ? `+${n}` : String(n);
}

function formatRelativeTime(ts) {
  if (!ts) return null;
  const ms = Date.now() - Number(ts);
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 48) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

function guessUrl(suite, flows) {
  const named = (suite.flows || []).find((f) => f.url)?.url;
  if (named) return named;
  return `https://${String(suite.name || 'site').toLowerCase().replace(/\s+/g, '-')}.example.com`;
}
