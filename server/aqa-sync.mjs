// Shared AQA hydration: fetch a site's latest run, collect issues, group them
// by root cause. Used by bootstrap.mjs (startup fleet load) and orchestrator.mjs
// (rescan pipeline) so both paths produce identical site/cause shapes.

import * as aqa from '../integrations/aqa.mjs';
import { filterNeedFixIssues } from './issue-filter.mjs';
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
        selector: normalizeSelector(issue.selectors?.[0] || issue.solutionId || 'unknown'),
        tagName: issue.tagName || null,
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
      selector: g.selector,
      tagName: g.tagName,
      status: g.status,
      evidence: g.evidence,
    }));
}

// Human-readable locator from AQA fields only (no repo guessing).
export function formatCauseLocator(cause) {
  const sel = cause?.selector && cause.selector !== 'unknown' ? cause.selector : '';
  const tag = cause?.tagName ? String(cause.tagName).toLowerCase() : '';
  if (tag && sel) return `${tag} · ${sel}`;
  if (sel) return sel;
  if (tag) return tag;
  return null;
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

// Re-hydration after a rescan: keep id/status of causes that match a previous
// cause (same ruleId + title) so in-flight tasks stay linked. Selector/tag come
// from the latest AQA payload.
// ── Score ───────────────────────────────────────────────────────────────────
//
// A 0-100 accessibility score. This is OUR number, not AQA's: AQA reports
// severities and instance counts, never a grade, so the formula lives here in
// the open rather than looking like a vendor figure.
//
// Weighted penalty per instance, normalized by how much surface was actually
// scored (snapshots for a journey, flows for a site) so a large site is not
// automatically worse than a small one, then decayed onto 0-100.
//
// Decay rather than subtraction on purpose: 100 - penalty bottoms out at zero
// almost immediately on a real site, which would make every failing page look
// identical. A decay curve keeps 12 open instances and 60 open instances
// distinguishable, which is what a team tracking progress needs.
// Calibrated against anchors rather than picked by feel, because a curve that
// makes every real site an F is worse than no score at all:
//   clean page                 -> 100
//   one minor instance         -> ~98
//   one critical instance      -> ~85   (noticeable, not catastrophic)
//   three critical + a serious -> ~58   (clearly failing)
//   ten critical instances     -> ~20
const SEVERITY_WEIGHT = { critical: 10, serious: 4, minor: 1 };
const SCORE_DECAY = Number(process.env.SCORE_DECAY) || 60;

export function scoreCauses(causes = [], { units = 1 } = {}) {
  const counts = { critical: 0, serious: 0, minor: 0 };
  let penalty = 0;

  for (const cause of causes) {
    const severity = SEVERITY_WEIGHT[cause.severity] ? cause.severity : 'minor';
    const instances = Number(cause.instances) || 0;
    counts[severity] += instances;
    penalty += SEVERITY_WEIGHT[severity] * instances;
  }

  const density = penalty / Math.max(1, units);
  const score = Math.round(100 * Math.exp(-density / SCORE_DECAY));
  return {
    score,
    grade: gradeFor(score),
    counts,
    instances: counts.critical + counts.serious + counts.minor,
    causes: causes.length,
    units,
  };
}

export function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// Causes already fixed and verified are history, not open problems, so they do
// not drag the score down.
export function openCauses(causes = []) {
  return causes.filter((c) => c.status !== 'fixed');
}

export function mergeCauses(prevCauses, nextCauses) {
  const prevByKey = new Map(prevCauses.map((c) => [causeKey(c), c]));
  const claimed = new Set();
  const merged = nextCauses.map((next) => {
    const prev = prevByKey.get(causeKey(next));
    if (prev && !claimed.has(prev.id)) {
      claimed.add(prev.id);
      return { ...next, id: prev.id, status: prev.status };
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
