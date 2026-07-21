// Walks a journey in a real browser and scores each snapshot through AQA's
// stateless evaluate endpoint.
//
// This file and runner/index.mjs are the ONLY place Playwright is imported.
// PLAN.md design rule 5 is that `git pull && npm start` works on any Node 20+
// machine with no install step, so the control plane must stay dependency-free
// and talks to this process over HTTP instead of importing it.

import { chromium } from '@playwright/test';
import * as aqa from '../integrations/aqa.mjs';

// Vendor-hosted by default. Overridable so tests can serve a stub and so an
// office that pins a local copy of the analyzer (the documented mitigation for
// it changing underneath us) can point at that instead.
const ANALYZER_URL = process.env.AQA_ANALYZER_URL
  || 'https://aqa.usablenet.com/aqapool/js/aqa-analyzer.js';
const DEFAULT_STEP_TIMEOUT_MS = Number(process.env.RUNNER_STEP_TIMEOUT_MS) || 15000;

export async function runJourney(journey) {
  const startedAt = Date.now();
  const steps = [];
  const snapshots = [];
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
        steps.push({ index, type: step.type, label: step.label || null, ms: Date.now() - t0, status: 'ok' });
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
    startedAt,
    finishedAt: Date.now(),
    ms: Date.now() - startedAt,
    steps,
    snapshots,
  };
}

async function executeStep(page, step, journey) {
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
      return snapshot(page, step, journey);
    default:
      throw new Error(`unknown step type "${step.type}"`);
  }
}

async function snapshot(page, step, journey) {
  const t0 = Date.now();
  const code = await capture(page);
  const pageUrl = page.url();
  const rulesetId = step.rulesetId || journey.rulesetId;

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
