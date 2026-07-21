// Bootstrap fleet state from AQA + FLEET_SITES env config.
// Used on first load and when resetting in real mode.
// Hydration internals live in aqa-sync.mjs, shared with the rescan pipeline.

import * as aqa from '../integrations/aqa.mjs';
import { hydrateSite } from './aqa-sync.mjs';

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
    journeys: [],
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
      repoPath: process.env.FILORGA_FR_REPO_PATH || null,
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
      repoPath: process.env.FILORGA_EU_REPO_PATH || null,
    });
  }
  return sites;
}

export function demoSeed() {
  return {
    counter: 1000,
    settings: structuredClone(DEFAULT_SETTINGS),
    journeys: [],
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
