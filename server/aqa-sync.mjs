// Shared AQA hydration: fetch a site's latest run, collect issues, group them
// by root cause. Used by bootstrap.mjs (startup fleet load) and orchestrator.mjs
// (rescan pipeline) so both paths produce identical site/cause shapes.

import * as aqa from '../integrations/aqa.mjs';

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

  const issues = latestRun ? await collectIssues(latestRun.id, suite, test) : [];
  const grouped = groupIssues(issues, cfg.id);

  return {
    site: {
      id: cfg.id,
      url: cfg.url || guessUrl(suite, flows),
      repo: cfg.repo,
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
        const res = await aqa.runFlowIssues(runId, flowId, { stepIndex: step });
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

function groupIssues(issues, siteId) {
  const groups = new Map();
  for (const issue of issues) {
    const selector = issue.selectors?.[0] || issue.solutionId || 'unknown';
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
    .slice(0, 25)
    .map((g, i) => ({
      id: `cause-${siteId}-${i + 1}`,
      siteId: g.siteId,
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

// Re-hydration after a rescan: keep id/status/mappedFile of causes that match a
// previous cause (same ruleId + title) so in-flight tasks stay linked.
export function mergeCauses(prevCauses, nextCauses) {
  const prevByKey = new Map(prevCauses.map((c) => [causeKey(c), c]));
  const claimed = new Set();
  const merged = nextCauses.map((next) => {
    const prev = prevByKey.get(causeKey(next));
    if (prev && !claimed.has(prev.id)) {
      claimed.add(prev.id);
      return { ...next, id: prev.id, status: prev.status, mappedFile: prev.mappedFile };
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
