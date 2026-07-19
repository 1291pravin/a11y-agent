// JSON file state store. Loads data/state.json if present, otherwise seeds demo data.
// Persistence is write-behind: mutate state via update(), which schedules a save.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, '..', 'data', 'state.json');

let state = load();
let saveTimer = null;

export function getState() { return state; }

export function update(fn) {
  fn(state);
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        mkdirSync(dirname(STATE_PATH), { recursive: true });
        writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      } catch (err) {
        console.error('store: save failed:', err.message);
      }
    }, 200);
  }
}

export function resetToSeed() {
  state = seed();
  update(() => {});
  return state;
}

export function nextId(prefix) {
  state.counter = (state.counter || 1000) + 1;
  return `${prefix}${state.counter}`;
}

function load() {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
    catch (err) { console.error('store: corrupt state.json, reseeding:', err.message); }
  }
  return seed();
}

function seed() {
  return {
    counter: 1000,
    settings: {
      policies: {
        planAutoApprove: 'auto if <= 25 flows and no auth-gated routes',
        fixDispatch: 'auto for mapped root causes at severity A/AA',
        prMerge: 'always human',
        runCadence: 'weekly, staggered Mon-Thu',
      },
      notifications: { channel: '' },
    },
    sites: [
      {
        id: 'site-filorga', url: 'https://fr.filorga.com', repo: 'acme/filorga-frontend',
        suiteId: 'TS35353', status: 'critical', critical: 5, total: 48,
        trend: [61, 66, 58, 55, 52, 54, 50, 48], lastRun: '2 h ago',
        framework: 'Shopify + Vue 3',
        flows: [
          { name: 'Home', type: 'URL', status: 'issues', violations: 12, delta: '+3 new' },
          { name: 'Product detail', type: 'URL', status: 'issues', violations: 9, delta: '-4 fixed' },
          { name: 'Mega menu open', type: 'Click-state', status: 'critical', violations: 17, delta: '+2 new' },
          { name: 'Mini-cart', type: 'Click-state', status: 'issues', violations: 10, delta: '0' },
          { name: '/account/*', type: 'Skipped', status: 'skipped', violations: null, delta: 'no test creds' },
        ],
      },
      {
        id: 'site-brandx', url: 'https://global.brandx.com', repo: 'acme/brandx-web',
        suiteId: 'TS35401', status: 'fixing', critical: 2, total: 31,
        trend: [44, 40, 41, 38, 36, 35, 33, 31], lastRun: '4 h ago',
        framework: 'Next.js',
        flows: [
          { name: 'Home', type: 'URL', status: 'issues', violations: 8, delta: '0' },
          { name: 'Search results', type: 'URL', status: 'issues', violations: 11, delta: '-2 fixed' },
          { name: 'Modal checkout', type: 'Click-state', status: 'issues', violations: 12, delta: '0' },
        ],
      },
      {
        id: 'site-contoso', url: 'https://us.contoso.com', repo: 'acme/contoso-site',
        suiteId: 'TS35422', status: 'healthy', critical: 0, total: 6,
        trend: [18, 16, 14, 12, 10, 8, 7, 6], lastRun: '6 h ago',
        framework: 'Nuxt 3',
        flows: [
          { name: 'Home', type: 'URL', status: 'issues', violations: 4, delta: '0' },
          { name: 'Contact', type: 'URL', status: 'issues', violations: 2, delta: '-1 fixed' },
        ],
      },
    ],
    causes: [
      {
        id: 'cause-1', siteId: 'site-filorga', title: 'Nav links missing accessible name',
        rule: 'WCAG 4.1.2 A', ruleId: 'link-name', severity: 'critical',
        instances: 17, pages: ['/', '/soins', '/products/*', '+3 more'],
        mappedFile: 'src/components/MegaMenu.vue:84', status: 'open',
        evidence: '<a class="nav__item"><span class="icon-chevron"></span></a>',
      },
      {
        id: 'cause-2', siteId: 'site-filorga', title: 'Product images empty alt',
        rule: 'WCAG 1.1.1 A', ruleId: 'image-alt', severity: 'critical',
        instances: 11, pages: ['/', '/soins', '/products/ncef-revitalize', '+1 more'],
        mappedFile: 'src/components/ProductCard.vue:31', status: 'open',
        evidence: '<img class="product-card__img" src="...">',
      },
      {
        id: 'cause-3', siteId: 'site-filorga', title: 'Insufficient contrast on promo banner',
        rule: 'WCAG 1.4.3 AA', ruleId: 'color-contrast', severity: 'serious',
        instances: 8, pages: ['all pages'],
        mappedFile: 'src/styles/tokens.scss:112', status: 'open',
        evidence: 'color #9aa on #fff, ratio 2.6:1 (needs 4.5:1)',
      },
      {
        id: 'cause-4', siteId: 'site-filorga', title: 'Newsletter iframe missing title (3rd-party)',
        rule: 'WCAG 2.4.1 A', ruleId: 'frame-title', severity: 'serious',
        instances: 6, pages: ['all pages'],
        mappedFile: null, status: 'open',
        evidence: '<iframe src="https://newsletter.vendor.com/embed">',
      },
      {
        id: 'cause-5', siteId: 'site-brandx', title: 'Focus trap missing in checkout modal',
        rule: 'WCAG 2.1.2 A', ruleId: 'focus-trap', severity: 'critical',
        instances: 3, pages: ['/checkout'],
        mappedFile: 'components/Modal.tsx:47', status: 'open',
        evidence: 'Tab escapes dialog while open',
      },
    ],
    tasks: [],
    prs: [],
    activity: [],
  };
}
