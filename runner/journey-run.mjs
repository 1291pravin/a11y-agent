// Walks a journey in a real browser and scores each snapshot through AQA's
// stateless evaluate endpoint.
//
// This file and runner/index.mjs are the ONLY place Playwright is imported.
// PLAN.md design rule 5 is that `git pull && npm start` works on any Node 20+
// machine with no install step, so the control plane must stay dependency-free
// and talks to this process over HTTP instead of importing it.

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as aqa from '../integrations/aqa.mjs';

// Vendor-hosted by default. Overridable so tests can serve a stub and so an
// office that pins a local copy of the analyzer (the documented mitigation for
// it changing underneath us) can point at that instead.
const ANALYZER_URL = process.env.AQA_ANALYZER_URL
  || 'https://aqa.usablenet.com/aqapool/js/aqa-analyzer.js';
const DEFAULT_STEP_TIMEOUT_MS = Number(process.env.RUNNER_STEP_TIMEOUT_MS) || 15000;

export async function runJourney(journey, opts = {}) {
  const startedAt = Date.now();
  const steps = [];
  const snapshots = [];
  const shotDir = prepareShotDir(opts.screenshotDir, opts.screenshotTag);
  let failure = null;

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: journey.viewport || { width: 1440, height: 900 } });
    const page = await context.newPage();

    for (const [index, step] of (journey.steps || []).entries()) {
      const t0 = Date.now();
      try {
        const snap = await executeStep(page, step, journey);
        if (snap) snapshots.push(snap);
        const shot = await captureShot(page, shotDir, index, step);
        steps.push({ index, type: step.type, label: step.label || null, ms: Date.now() - t0, status: 'ok', screenshot: shot });
      } catch (err) {
        const status = step.optional ? 'skipped' : 'error';
        steps.push({ index, type: step.type, label: step.label || null, ms: Date.now() - t0, status, error: err.message });
        // An optional step is one whose target may legitimately not be there
        // (cookie banners above all). A miss is data, not a failure.
        if (!step.optional) {
          failure = `step ${index + 1} (${step.type}) failed: ${err.message}`;
          break;
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return {
    ok: !failure,
    error: failure,
    journeyId: journey.id || null,
    // Whether the snapshots carry AQA scores. In demo mode the journey still
    // walks and captures its snapshot points, but nothing is scored, so the
    // control plane records an unscored run rather than a fake clean one.
    scored: aqa.isReal,
    startedAt,
    finishedAt: Date.now(),
    ms: Date.now() - startedAt,
    steps,
    snapshots,
  };
}

// Walk the steps without scoring anything. Used to validate a proposed journey
// before it is saved: a selector the discovery agent invented but that does not
// exist on the page should be caught here, not on the first real run. Needs no
// AQA credentials, so discovery works in demo mode.
//
// M7: when screenshotDir is set, captures a PNG after every successful step
// so the proposal review UI can show a visual timeline of the journey
// alongside the selector table. Falls back gracefully if the screenshot
// write fails - a proposal is still valid without its thumbnails.
export async function dryRunJourney(journey, opts = {}) {
  const startedAt = Date.now();
  const steps = [];
  const shotDir = prepareShotDir(opts.screenshotDir, opts.screenshotTag);
  let failure = null;

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: journey.viewport || { width: 1440, height: 900 } });
    const page = await context.newPage();

    for (const [index, step] of (journey.steps || []).entries()) {
      const t0 = Date.now();
      try {
        await executeStep(page, step, journey, true);
        const shot = await captureShot(page, shotDir, index, step);
        steps.push({ index, type: step.type, ms: Date.now() - t0, status: 'ok', screenshot: shot });
      } catch (err) {
        const status = step.optional ? 'skipped' : 'error';
        steps.push({ index, type: step.type, ms: Date.now() - t0, status, error: err.message });
        if (!step.optional) {
          failure = `step ${index + 1} (${step.type}) failed: ${err.message}`;
          break;
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { ok: !failure, error: failure, ms: Date.now() - startedAt, steps };
}

// Screenshots land under a per-invocation subdirectory so a re-discovery
// wipe (see startDiscovery) can prune an old batch without touching
// screenshots the current run still refers to. Tag is a short identifier
// the control plane supplies (proposal index, journey id, ...) so filenames
// stay meaningful when they show up in the UI.
function prepareShotDir(root, tag) {
  if (!root) return null;
  try {
    const dir = tag ? resolve(root, String(tag)) : resolve(root);
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    console.error('screenshot dir setup failed:', err.message);
    return null;
  }
}

async function captureShot(page, dir, index, step) {
  if (!dir) return null;
  const kind = step.type === 'snapshot' ? 'snap' : step.type;
  const filename = `step-${String(index).padStart(2, '0')}-${kind}.png`;
  const path = join(dir, filename);
  try {
    // Viewport-sized (not full-page) keeps thumbnails snappy in the review
    // grid; a proposal can have a dozen of these and full-page shots would
    // balloon the payload without adding review value.
    await page.screenshot({ path, fullPage: false, animations: 'disabled', timeout: 5000 });
    return filename;
  } catch (err) {
    // A page that never renders (about:blank on a broken step) can throw
    // here. Screenshots are advisory, so drop them rather than fail the run.
    return null;
  }
}

// A bounded structural summary of what a user can interact with on a page.
// Feeds journey discovery: small enough to hand to a model, concrete enough to
// build real selectors from. Deliberately not the whole DOM.
export async function inspectPage({ url, viewport }) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { timeout: DEFAULT_STEP_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    const summary = await page.evaluate(collectStructure);
    return { ok: true, url: page.url(), ...summary };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Runs inside the page. Prefers stable hooks (id, data-testid) over brittle
// nth-of-type paths so the selectors handed to discovery survive a redeploy.
function collectStructure() {
  const sel = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testid = el.getAttribute('data-testid');
    if (testid) return `[data-testid="${testid}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    if (cls) return `${el.tagName.toLowerCase()}.${CSS.escape(cls)}`;
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const sibs = [...parent.children].filter((c) => c.tagName === el.tagName);
    const i = sibs.indexOf(el) + 1;
    return `${el.tagName.toLowerCase()}:nth-of-type(${i})`;
  };
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const take = (nodes, n, map) => [...nodes].slice(0, n).map(map);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  return {
    title: document.title || '',
    nav: take([...document.querySelectorAll('nav, [role="navigation"]')].filter(visible), 8,
      (el) => ({ selector: sel(el), text: txt(el).slice(0, 120) })),
    buttons: take([...document.querySelectorAll('button, [role="button"]')].filter(visible), 25,
      (el) => ({ selector: sel(el), text: txt(el) })),
    links: take([...document.querySelectorAll('a[href]')].filter((el) => visible(el) && txt(el)), 40,
      (el) => ({ selector: sel(el), text: txt(el), href: el.getAttribute('href') })),
    inputs: take([...document.querySelectorAll('input, textarea, select')].filter(visible), 20,
      (el) => ({
        selector: sel(el), type: el.getAttribute('type') || el.tagName.toLowerCase(),
        name: el.getAttribute('name') || null, placeholder: el.getAttribute('placeholder') || null,
      })),
    landmarks: take([...document.querySelectorAll('main, header, footer, [role="main"], [role="search"]')].filter(visible), 10,
      (el) => ({ selector: sel(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null })),
  };
}

async function executeStep(page, step, journey, dry = false) {
  const timeout = step.timeoutMs || DEFAULT_STEP_TIMEOUT_MS;
  switch (step.type) {
    case 'goto':
      // domcontentloaded, not load: a third-party asset that never settles
      // should not decide whether the journey runs.
      await page.goto(step.url, { timeout, waitUntil: 'domcontentloaded' });
      return null;
    case 'click':
      await page.click(step.selector, { timeout });
      return null;
    case 'fill':
      await page.fill(step.selector, step.value, { timeout });
      return null;
    case 'hover':
      await page.hover(step.selector, { timeout });
      return null;
    case 'waitFor':
      if (step.selector) await page.waitForSelector(step.selector, { timeout });
      else if (step.networkIdle) await page.waitForLoadState('networkidle', { timeout });
      else await page.waitForTimeout(step.ms);
      return null;
    case 'snapshot':
      // A dry run proves the snapshot point is reachable without spending an
      // AQA evaluation on it.
      if (dry) {
        if (step.context) await page.waitForSelector(step.context, { timeout });
        return null;
      }
      return snapshot(page, step, journey);
    default:
      throw new Error(`unknown step type "${step.type}"`);
  }
}

async function snapshot(page, step, journey) {
  const t0 = Date.now();
  const rulesetId = step.rulesetId || journey.rulesetId;

  // Demo mode: record that the snapshot point was reached, but do not inject the
  // vendor analyzer or call evaluate. This keeps a demo run entirely
  // self-contained (no AQA account, no vendor script) so the Playwright walk can
  // be verified on any site without credentials.
  if (!aqa.isReal) {
    return {
      label: step.label, pageUrl: page.url(), rulesetId, context: step.context || null,
      ms: Date.now() - t0, bytes: null, status: 'unscored', error: null, issues: [], scored: false,
    };
  }

  const code = await capture(page);
  const pageUrl = page.url();

  const res = await aqa.evaluate({
    rulesetId,
    pageUrl,
    code,
    context: step.context,
    manual: step.manual,
  });

  // A transport-level failure throws out of aqa.evaluate and fails the run: a
  // bad key must not read as a clean page. An evaluation AQA itself reports as
  // failed is per-snapshot data, so it is recorded and the journey continues.
  return {
    label: step.label,
    pageUrl,
    rulesetId,
    context: step.context || null,
    ms: Date.now() - t0,
    bytes: code.length,
    status: res?.status === 'error' ? 'error' : 'ok',
    error: res?.error || null,
    issues: res?.issues || [],
  };
}

// Vendor-documented capture: the analyzer rewrites the live DOM into the form
// the rule engine expects. Navigation drops injected scripts, so re-check
// rather than injecting once per run.
async function capture(page) {
  const present = await page.evaluate(() => typeof window._aqaProcessDOM === 'function');
  if (!present) await page.addScriptTag({ url: ANALYZER_URL });
  const code = await page.evaluate(() => window._aqaProcessDOM());
  if (!code) throw new Error('_aqaProcessDOM() returned an empty snapshot');
  return String(code);
}
