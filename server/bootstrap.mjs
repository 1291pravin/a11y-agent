// Bootstrap fleet state from AQA + FLEET_SITES env config.
// Used on first load and when resetting in real mode.

import * as aqa from '../integrations/aqa.mjs';

const DEFAULT_SETTINGS = {
  policies: {
    planAutoApprove: 'auto if <= 25 flows and no auth-gated routes',
    fixDispatch: 'auto for mapped root causes at severity A/AA',
    prMerge: 'always human',
    runCadence: 'weekly, staggered Mon-Thu',
  },
  notifications: { channel: '' },
};

export function hasFleetConfig() {
  return fleetFromEnv().length > 0;
}

export function fleetFromEnv() {
  if (process.env.FLEET_SITES) {
    try {
      const parsed = JSON.parse(process.env.FLEET_SITES);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (err) {
      console.error('bootstrap: invalid FLEET_SITES JSON:', err.message);
    }
  }
  return defaultFleetFromEnv();
}

export async function bootstrapFromAqa() {
  if (!aqa.isReal) throw new Error('AQA credentials required to bootstrap fleet');
  const fleet = fleetFromEnv();
  if (!fleet.length) throw new Error('FLEET_SITES is empty');

  const sites = [];
  const causes = [];
  const activity = [{ ts: Date.now(), msg: `Bootstrapped ${fleet.length} site(s) from AQA` }];

  for (const cfg of fleet) {
    const hydrated = await hydrateSite(cfg);
    sites.push(hydrated.site);
    causes.push(...hydrated.causes);
    activity.unshift({
      ts: Date.now(),
      msg: `Loaded ${hydrated.site.url} — ${hydrated.site.total} violations across ${hydrated.site.flows.length} flows`,
    });
  }

  return {
    counter: 1000,
    settings: structuredClone(DEFAULT_SETTINGS),
    sites,
    causes,
    tasks: [],
    prs: [],
    activity,
  };
}

function defaultFleetFromEnv() {
  const sites = [];
  if (process.env.FILORGA_FR_SUITE_ID || process.env.AQA_TEST_ID) {
    sites.push({
      id: 'filorga-fr',
      url: process.env.FILORGA_FR_URL || 'https://fr.filorga.com',
      repo: process.env.FILORGA_FR_REPO || 'colpal/filorga-fr',
      suiteId: process.env.FILORGA_FR_SUITE_ID || 'TS31223',
      testId: process.env.FILORGA_FR_TEST_ID || process.env.AQA_TEST_ID || null,
      framework: process.env.FILORGA_FR_FRAMEWORK || 'Shopify + Vue 3',
    });
  }
  if (process.env.FILORGA_EU_SUITE_ID) {
    sites.push({
      id: 'filorga-eu',
      url: process.env.FILORGA_EU_URL || 'https://dev.int.filorga.com',
      repo: process.env.FILORGA_EU_REPO || 'colpal/filorga-eu',
      suiteId: process.env.FILORGA_EU_SUITE_ID || 'TS24575',
      testId: process.env.FILORGA_EU_TEST_ID || 'A206322-0',
      framework: process.env.FILORGA_EU_FRAMEWORK || 'Shopify + Vue 3',
    });
  }
  return sites;
}

async function hydrateSite(cfg) {
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

export function demoSeed() {
  return {
    counter: 1000,
    settings: structuredClone(DEFAULT_SETTINGS),
    sites: [
      {
        id: 'site-demo',
        url: 'https://demo.example.com',
        repo: 'acme/demo',
        suiteId: 'TS000',
        status: 'critical',
        critical: 1,
        total: 3,
        trend: [5, 4, 3],
        lastRun: '1 h ago',
        framework: 'demo',
        flows: [
          { name: 'Home', type: 'URL', status: 'issues', violations: 3, delta: '0' },
        ],
      },
    ],
    causes: [
      {
        id: 'cause-demo-1',
        siteId: 'site-demo',
        title: 'Demo images missing alt text',
        rule: 'WCAG 1.1.1 A',
        ruleId: 'image-alt',
        severity: 'critical',
        instances: 3,
        pages: ['/'],
        mappedFile: 'src/Demo.vue:12',
        status: 'open',
        evidence: '<img class="hero" src="/hero.jpg">',
      },
      {
        id: 'cause-demo-2',
        siteId: 'site-demo',
        title: 'Demo vendor iframe missing title',
        rule: 'WCAG 2.4.1 A',
        ruleId: 'frame-title',
        severity: 'serious',
        instances: 1,
        pages: ['/'],
        mappedFile: null,
        status: 'open',
        evidence: '<iframe src="https://vendor.example/embed">',
      },
    ],
    tasks: [],
    prs: [],
    activity: [],
  };
}
