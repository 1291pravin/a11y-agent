// Journey / evaluate-path tests.
//
// Pure tests cover the model and the evaluate -> cause adapter. The pipeline
// tests drive the whole path for real: a Chromium runner process walks a
// fixture page served locally, injects a stub analyzer, and POSTs each snapshot
// to a mock evaluate endpoint written from the vendored OpenAPI spec. The mock
// rejects anything but the camelCase parameter spelling, so a regression there
// fails loudly here.
//
// The pipeline tests skip when Chromium is not installed (npm install +
// npx playwright install chromium); the pure tests always run.
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateJourney, STEP_TYPES } from '../server/journey-model.mjs';
import { evaluateIssuesToRaw, groupIssues } from '../server/aqa-sync.mjs';
import { filterNeedFixIssues } from '../server/issue-filter.mjs';

const PORT = 4540;
const RUNNER_PORT = 4541;
const BASE = `http://localhost:${PORT}`;
const STATE_FILE = join(tmpdir(), `a11y-agent-journey-state-${process.pid}.json`);

// ── Model (pure) ────────────────────────────────────────────────────────────

const MINIMAL = {
  name: 'checkout',
  rulesetId: 'wcag-2.1-aa',
  startUrl: 'https://shop.example.com/',
  steps: [{ type: 'snapshot', label: 'home' }],
};

test('validateJourney accepts a minimal journey and prepends the implicit goto', () => {
  const { journey, errors } = validateJourney(MINIMAL);
  assert.equal(errors, undefined);
  assert.equal(journey.steps.length, 2);
  assert.deepEqual(journey.steps[0], { type: 'goto', url: 'https://shop.example.com/' });
  assert.equal(journey.steps[1].type, 'snapshot');
  assert.deepEqual(journey.viewport, { width: 1440, height: 900 });
});

test('validateJourney keeps an explicit leading goto as-is', () => {
  const { journey } = validateJourney({
    ...MINIMAL,
    steps: [{ type: 'goto', url: 'https://shop.example.com/login' }, ...MINIMAL.steps],
  });
  assert.equal(journey.steps.length, 2);
  assert.equal(journey.steps[0].url, 'https://shop.example.com/login');
});

test('validateJourney requires name, rulesetId, startUrl and steps', () => {
  const { errors } = validateJourney({});
  assert.ok(errors.some((e) => e.includes('name')));
  assert.ok(errors.some((e) => e.includes('rulesetId')));
  assert.ok(errors.some((e) => e.includes('startUrl')));
  assert.ok(errors.some((e) => e.includes('steps')));
});

test('validateJourney rejects a journey with no snapshot step', () => {
  const { errors } = validateJourney({ ...MINIMAL, steps: [{ type: 'click', selector: '.x' }] });
  assert.ok(errors.some((e) => e.includes('snapshot')));
});

test('validateJourney covers the whole step vocabulary', () => {
  const { journey, errors } = validateJourney({
    ...MINIMAL,
    steps: [
      { type: 'goto', url: 'https://shop.example.com/' },
      { type: 'click', selector: 'button.accept', optional: true },
      { type: 'fill', selector: 'input[name=q]', value: 'shoes' },
      { type: 'hover', selector: 'nav .menu' },
      { type: 'waitFor', networkIdle: true },
      { type: 'waitFor', selector: '.panel', timeoutMs: 3000 },
      { type: 'waitFor', ms: 250 },
      { type: 'snapshot', label: 'panel', context: '#main', rulesetId: 'wcag-2.2-aa', manual: true },
    ],
  });
  assert.equal(errors, undefined);
  assert.deepEqual(journey.steps.map((s) => s.type), [
    'goto', 'click', 'fill', 'hover', 'waitFor', 'waitFor', 'waitFor', 'snapshot',
  ]);
  assert.equal(journey.steps[1].optional, true);
  assert.equal(journey.steps[5].timeoutMs, 3000);
  assert.equal(journey.steps[6].ms, 250);
  assert.equal(journey.steps[7].context, '#main');
  assert.equal(journey.steps[7].rulesetId, 'wcag-2.2-aa');
  assert.equal(journey.steps[7].manual, true);
  assert.equal(STEP_TYPES.length, 6);
});

test('validateJourney reports per-step errors with the step number', () => {
  const { errors } = validateJourney({
    ...MINIMAL,
    steps: [
      { type: 'teleport', selector: '.x' },
      { type: 'click' },
      { type: 'waitFor', selector: '.a', ms: 100 },
      { type: 'snapshot' },
    ],
  });
  assert.ok(errors.some((e) => e.startsWith('step 1:') && e.includes('teleport')));
  assert.ok(errors.some((e) => e.startsWith('step 2:') && e.includes('selector')));
  assert.ok(errors.some((e) => e.startsWith('step 3:') && e.includes('exactly one')));
  assert.ok(errors.some((e) => e.startsWith('step 4:') && e.includes('label')));
});

// ── Adapter (pure) ──────────────────────────────────────────────────────────

function evIssue(ruleId, solutionId, selector, tagName, properties) {
  return {
    auto: true,
    id: `AI-${ruleId}`,
    ruleId,
    ruleTitle: `${ruleId}: rule`,
    ruleShortTitle: ruleId,
    needFixTitle: `Fix ${ruleId}`,
    solutionId,
    selectors: [selector],
    tagName,
    properties,
    responsibility: 'Development',
    technology: 'HTML',
  };
}

test('evaluateIssuesToRaw attaches the snapshot label as flowName and its index as step', () => {
  const raw = evaluateIssuesToRaw([
    { label: 'home', issues: [evIssue('r1', 's1', 'img.hero', 'img', ['needs fix', 'high'])] },
    { label: 'menu-open', issues: [evIssue('r2', 's2', 'a.cart', 'a', ['needs fix', 'medium'])] },
    { label: 'empty', issues: [] },
  ]);
  assert.equal(raw.length, 2);
  assert.equal(raw[0].flowName, 'home');
  assert.equal(raw[0].step, 0);
  assert.equal(raw[1].flowName, 'menu-open');
  assert.equal(raw[1].step, 1);
  // Everything else is carried through untouched: same rule engine, same fields.
  assert.equal(raw[0].ruleId, 'r1');
  assert.equal(raw[0].solutionId, 's1');
  assert.deepEqual(raw[0].selectors, ['img.hero']);
});

test('groupIssues folds evaluate issues into causes the existing grouping shape', () => {
  const raw = evaluateIssuesToRaw([
    { label: 'home', issues: [evIssue('r1', 's1', 'ul > li:nth-child(2) > a', 'a', ['needs fix', 'high'])] },
    { label: 'menu-open', issues: [
      evIssue('r1', 's1', 'ul > li:nth-child(9) > a', 'a', ['needs fix', 'high']),
      evIssue('r2', 's2', 'iframe.chat', 'iframe', ['needs fix', 'medium']),
    ] },
  ]);
  const causes = groupIssues(raw, 'site-x', { idPrefix: 'cause-journey-7', source: 'journey', journeyId: 'journey-7' });
  assert.equal(causes.length, 2);
  const first = causes[0];
  // Positional pseudo-classes normalize away, so one component groups once
  // across snapshots and carries both snapshot labels as pages.
  assert.equal(first.ruleId, 'r1');
  assert.equal(first.instances, 2);
  assert.deepEqual(first.pages, ['home', 'menu-open']);
  assert.equal(first.severity, 'critical');
  assert.equal(first.id, 'cause-journey-7-1');
  assert.equal(first.source, 'journey');
  assert.equal(first.journeyId, 'journey-7');
  assert.equal(first.siteId, 'site-x');
  assert.equal(causes[1].severity, 'serious');
});

// The journey path applies the same manual/need-fix split as the suite path, so
// "fix-required" means the same thing on both and the score never counts a
// finding that needs a human judgement call rather than a code change. This
// composes the exact chain runJourney uses.
test('manual-review findings never become journey causes', () => {
  const raw = evaluateIssuesToRaw([
    { label: 'home', issues: [
      evIssue('r1', 's1', 'img.hero', 'img', ['needs fix', 'high']),
      evIssue('r-manual', 's9', 'div.banner', 'div', ['check manually', 'medium']),
    ] },
  ]);
  assert.equal(raw.length, 2);

  const filtered = filterNeedFixIssues(raw);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].ruleId, 'r1');

  const causes = groupIssues(filtered, 'site-x', {
    idPrefix: 'cause-journey-1', source: 'journey', journeyId: 'journey-1',
  });
  assert.equal(causes.length, 1);
  assert.equal(causes[0].ruleId, 'r1');
});

test('groupIssues keeps the suite id namespace and source by default', () => {
  const causes = groupIssues(
    [{ ruleId: 'r1', selectors: ['img'], tagName: 'img', properties: ['high'], needFixTitle: 'x', flowName: 'Home' }],
    'site-x',
  );
  assert.equal(causes[0].id, 'cause-site-x-1');
  assert.equal(causes[0].source, 'suite');
  assert.equal(causes[0].journeyId, null);
});

// ── Pipeline (mock evaluate + real Chromium runner) ──────────────────────────

let browserMissing = null;
try {
  const { chromium } = await import('@playwright/test');
  const exe = chromium.executablePath();
  if (!existsSync(exe)) browserMissing = `chromium not installed (${exe}); run: npx playwright install chromium`;
} catch (err) {
  browserMissing = `@playwright/test unavailable: ${err.message}`;
}
if (browserMissing) console.log(`journey pipeline tests skipped: ${browserMissing}`);

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Journey fixture</title></head>
<body>
  <button id="cookie-accept">Accept all cookies</button>
  <img class="hero" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">
  <nav>
    <button id="menu-toggle">Menu</button>
    <div id="menu" hidden><a id="cart" href="/cart"><span aria-hidden="true">cart-icon</span></a></div>
  </nav>
  <script>
    document.getElementById('cookie-accept').addEventListener('click', (e) => e.target.remove());
    document.getElementById('menu-toggle').addEventListener('click', () => {
      document.getElementById('menu').hidden = false;
    });
  </script>
</body></html>`;

// Stub for aqa-analyzer.js. The real analyzer rewrites the DOM into the form
// the rule engine wants; for the pipeline all that matters is that injection
// works and _aqaProcessDOM() returns the live DOM as a string.
const ANALYZER_STUB = `window._aqaProcessDOM = async function () { return document.documentElement.outerHTML; };`;

const ISSUE_ALT = evIssue('wcag21-1_1_1', 'missing_alt', 'img.hero', 'img', ['needs fix', 'high', 'average']);
const ISSUE_LINK = evIssue('wcag21-2_4_4', 'empty_link', 'a#cart', 'a', ['needs fix', 'high', 'average']);

let mock;
let mockBase;
let appProc;
let runnerProc;
const evaluateCalls = [];

function mockHandler(req, res) {
  const p = new URL(req.url, 'http://localhost').pathname;
  const send = (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && p === '/analyzer.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(ANALYZER_STUB);
  }
  if (req.method === 'GET' && p === '/fixture') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(FIXTURE_HTML);
  }
  if (req.method === 'POST' && p === '/mock/a11y/tests/evaluate') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const call = {
        contentType: req.headers['content-type'],
        team: req.headers['x-team'],
        keys: [...params.keys()],
        rulesetId: params.get('rulesetId'),
        pageUrl: params.get('pageUrl'),
        context: params.get('context'),
        manual: params.get('manual'),
        codeLength: (params.get('code') || '').length,
      };
      evaluateCalls.push(call);

      // The spec's `required` array uses a different case from its property
      // definitions. The client sends camelCase; the mock only accepts that,
      // so a silent switch to lowercase would fail the pipeline tests.
      const missing = ['rulesetId', 'pageUrl', 'code'].filter((k) => !params.get(k));
      if (missing.length) return send({ error: `missing_parameter: ${missing.join(', ')}` }, 400);
      if (!params.get('rulesetPackId')) return send({ error: 'missing_parameter: rulesetPackId' }, 400);

      const code = params.get('code') || '';
      const menuOpen = !/id="menu"[^>]*\shidden/.test(code);
      // context scopes scoring to a subtree: the menu link only, never the hero.
      const issues = params.get('context')
        ? (menuOpen ? [ISSUE_LINK] : [])
        : (menuOpen ? [ISSUE_ALT, ISSUE_LINK] : [ISSUE_ALT]);
      send({ issues, propertyTitles: { high: 'High' }, descriptions: {}, status: 'ok' });
    });
    return;
  }
  send({ error: `mock has no route for ${req.method} ${p}` }, 404);
}

async function waitForHealth(url, label) {
  for (let i = 0; i < 60; i++) {
    try { await fetch(url); return; } catch { await delay(200); }
  }
  throw new Error(`${label} did not start`);
}

before(async () => {
  mock = createServer(mockHandler);
  await new Promise((r) => mock.listen(0, r));
  mockBase = `http://localhost:${mock.address().port}`;

  // The control plane runs in demo mode on purpose: it never calls AQA for a
  // journey. Only the runner process holds credentials.
  appProc = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AQA_TEAMSLUG: '', AQA_API_KEY: '', CURSOR_API_KEY: '',
      RUNNER_URL: `http://localhost:${RUNNER_PORT}`,
      STATE_FILE,
    },
    stdio: 'ignore',
  });
  await waitForHealth(`${BASE}/api/health`, 'control plane');

  if (browserMissing) return;
  runnerProc = spawn(process.execPath, ['runner/index.mjs'], {
    env: {
      ...process.env,
      RUNNER_PORT: String(RUNNER_PORT),
      AQA_TEAMSLUG: 'mock',
      AQA_API_KEY: 'mock-key',
      AQA_BASE: mockBase,
      AQA_ANALYZER_URL: `${mockBase}/analyzer.js`,
    },
    stdio: 'ignore',
  });
  await waitForHealth(`http://localhost:${RUNNER_PORT}/health`, 'runner');
});

after(() => {
  appProc?.kill();
  runnerProc?.kill();
  mock?.close();
  try { unlinkSync(STATE_FILE); } catch {}
});

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const stateJourney = async (id) => {
  const s = await (await fetch(`${BASE}/api/state`)).json();
  return s.journeys.find((j) => j.id === id);
};

const stateCauses = async (siteId) => {
  const s = await (await fetch(`${BASE}/api/state`)).json();
  return s.causes.filter((c) => c.siteId === siteId);
};

async function waitForRun(id) {
  for (let i = 0; i < 300; i++) {
    const j = await stateJourney(id);
    if (j && !j.runState && j.lastRun) return j;
    await delay(200);
  }
  throw new Error(`journey ${id} never finished`);
}

// ── CRUD ────────────────────────────────────────────────────────────────────

let crudId;

test('POST /api/journeys rejects an unknown siteId', async () => {
  const { status, body } = await api('POST', '/api/journeys', { ...MINIMAL, siteId: 'site-nope' });
  assert.equal(status, 400);
  assert.match(body.error, /siteId/);
});

test('POST /api/journeys rejects an invalid journey with per-field errors', async () => {
  const { status, body } = await api('POST', '/api/journeys', { siteId: 'site-demo', name: 'bad' });
  assert.equal(status, 400);
  assert.ok(Array.isArray(body.errors));
  assert.ok(body.errors.some((e) => e.includes('rulesetId')));
});

test('POST /api/journeys creates a journey, and re-posting the same name is idempotent', async () => {
  const created = await api('POST', '/api/journeys', { ...MINIMAL, name: 'crud-journey', siteId: 'site-demo' });
  assert.equal(created.status, 201);
  assert.equal(created.body.siteId, 'site-demo');
  assert.equal(created.body.runState, null);
  crudId = created.body.id;

  const again = await api('POST', '/api/journeys', { ...MINIMAL, name: 'crud-journey', siteId: 'site-demo' });
  assert.equal(again.status, 200);
  assert.equal(again.body.existed, true);
  assert.equal(again.body.id, crudId);
});

test('GET /api/journeys lists and filters by site, GET by id returns one', async () => {
  const all = await api('GET', '/api/journeys');
  assert.ok(all.body.journeys.some((j) => j.id === crudId));
  const filtered = await api('GET', '/api/journeys?siteId=site-nope');
  assert.equal(filtered.body.journeys.length, 0);
  const one = await api('GET', `/api/journeys/${crudId}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.name, 'crud-journey');
  assert.equal((await api('GET', '/api/journeys/journey-nope')).status, 404);
});

test('POST /api/journeys/:id updates the editable fields and keeps the site', async () => {
  const { status, body } = await api('POST', `/api/journeys/${crudId}`, {
    rulesetId: 'wcag-2.2-aa',
    siteId: 'site-hijack',
    steps: [{ type: 'snapshot', label: 'renamed' }],
  });
  assert.equal(status, 200);
  assert.equal(body.rulesetId, 'wcag-2.2-aa');
  assert.equal(body.siteId, 'site-demo');
  assert.equal(body.steps.at(-1).label, 'renamed');
  const bad = await api('POST', `/api/journeys/${crudId}`, { steps: [] });
  assert.equal(bad.status, 400);
});

test('DELETE /api/journeys/:id removes the journey', async () => {
  const { status, body } = await api('DELETE', `/api/journeys/${crudId}`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal((await api('GET', `/api/journeys/${crudId}`)).status, 404);
  assert.equal((await api('DELETE', `/api/journeys/${crudId}`)).status, 404);
});

// ── Full pipeline ───────────────────────────────────────────────────────────

let runId;

test('the runner reports healthy through the control plane', { skip: browserMissing || false }, async () => {
  const { body } = await api('GET', '/api/runner/health');
  assert.equal(body.ok, true);
  assert.equal(body.runner.aqa, 'real');
});

test('a journey run walks the browser, scores each snapshot and groups the issues', { skip: browserMissing || false }, async () => {
  const created = await api('POST', '/api/journeys', {
    siteId: 'site-demo',
    name: 'menu-journey',
    rulesetId: 'wcag-2.1-aa',
    startUrl: `${mockBase}/fixture`,
    steps: [
      { type: 'click', selector: '#cookie-accept', optional: true },
      { type: 'snapshot', label: 'home' },
      { type: 'click', selector: '#menu-toggle' },
      { type: 'waitFor', selector: '#menu:not([hidden]) #cart' },
      { type: 'snapshot', label: 'menu-open' },
    ],
  });
  assert.equal(created.status, 201);
  runId = created.body.id;

  const started = await api('POST', `/api/journeys/${runId}/run`);
  assert.equal(started.status, 202);
  const dup = await api('POST', `/api/journeys/${runId}/run`);
  assert.equal(dup.status, 409);

  const journey = await waitForRun(runId);
  assert.equal(journey.lastRun.ok, true, journey.lastRun.error || '');
  assert.deepEqual(journey.lastRun.snapshots.map((s) => s.label), ['home', 'menu-open']);
  assert.deepEqual(journey.lastRun.snapshots.map((s) => s.status), ['ok', 'ok']);
  assert.deepEqual(journey.lastRun.snapshots.map((s) => s.issues), [1, 2]);
  assert.ok(journey.lastRun.snapshots[0].bytes > 0);
  // The implicit goto plus the five declared steps, all reported with timings.
  assert.equal(journey.lastRun.steps.length, 6);
  assert.ok(journey.lastRun.steps.every((s) => s.status === 'ok'));

  // The client sends form-encoded camelCase, and pageUrl is only a label.
  assert.equal(evaluateCalls.length, 2);
  for (const call of evaluateCalls) {
    assert.match(call.contentType, /application\/x-www-form-urlencoded/);
    assert.equal(call.team, 'mock-key');
    assert.deepEqual(call.keys.sort(), ['code', 'manual', 'pageUrl', 'rulesetId', 'rulesetPackId']);
    assert.equal(call.rulesetId, 'wcag21');
    assert.equal(call.pageUrl, `${mockBase}/fixture`);
    assert.ok(call.codeLength > 0);
  }
});

test('journey causes land beside the suite causes without disturbing them', { skip: browserMissing || false }, async () => {
  const causes = await stateCauses('site-demo');
  const suite = causes.filter((c) => c.source !== 'journey');
  const journeyCauses = causes.filter((c) => c.source === 'journey');

  // The seeded suite causes are untouched: supplement, not replace.
  assert.deepEqual(suite.map((c) => c.id).sort(), ['cause-demo-1', 'cause-demo-2']);

  assert.equal(journeyCauses.length, 2);
  assert.ok(journeyCauses.every((c) => c.journeyId === runId));
  assert.ok(journeyCauses.every((c) => c.id.startsWith(`cause-${runId}-`)));

  const alt = journeyCauses.find((c) => c.ruleId === 'wcag21-1_1_1');
  const link = journeyCauses.find((c) => c.ruleId === 'wcag21-2_4_4');
  // img.hero is flagged in both snapshots, so it groups once with two instances.
  assert.equal(alt.instances, 2);
  assert.deepEqual(alt.pages, ['home', 'menu-open']);
  assert.equal(alt.severity, 'critical');
  assert.equal(alt.status, 'open');
  assert.equal(link.instances, 1);
  assert.deepEqual(link.pages, ['menu-open']);
});

test('a second run keeps cause ids and reports every cause as persisting', { skip: browserMissing || false }, async () => {
  const before = await stateCauses('site-demo');
  const beforeIds = before.filter((c) => c.journeyId === runId).map((c) => c.id).sort();

  assert.equal((await api('POST', `/api/journeys/${runId}/run`)).status, 202);
  const journey = await waitForRun(runId);
  assert.equal(journey.lastRun.ok, true);
  assert.equal(journey.lastRun.diff.new.length, 0);
  assert.equal(journey.lastRun.diff.fixed.length, 0);
  assert.equal(journey.lastRun.diff.persisting.length, 2);

  const after = await stateCauses('site-demo');
  assert.deepEqual(after.filter((c) => c.journeyId === runId).map((c) => c.id).sort(), beforeIds);
  assert.equal(after.filter((c) => c.source !== 'journey').length, 2);
});

test('an optional step whose selector misses is skipped, not fatal', { skip: browserMissing || false }, async () => {
  const created = await api('POST', '/api/journeys', {
    siteId: 'site-demo',
    name: 'optional-journey',
    rulesetId: 'wcag-2.1-aa',
    startUrl: `${mockBase}/fixture`,
    steps: [
      { type: 'click', selector: '#no-such-banner', optional: true, timeoutMs: 1500 },
      { type: 'snapshot', label: 'home' },
    ],
  });
  await api('POST', `/api/journeys/${created.body.id}/run`);
  const journey = await waitForRun(created.body.id);

  assert.equal(journey.lastRun.ok, true, journey.lastRun.error || '');
  const skipped = journey.lastRun.steps.find((s) => s.status === 'skipped');
  assert.ok(skipped, 'the optional click should be reported as skipped');
  assert.equal(skipped.type, 'click');
  assert.ok(skipped.error);
  assert.equal(journey.lastRun.snapshots.length, 1);
});

test('a snapshot context is passed through and scopes the issues', { skip: browserMissing || false }, async () => {
  const created = await api('POST', '/api/journeys', {
    siteId: 'site-demo',
    name: 'context-journey',
    rulesetId: 'wcag-2.1-aa',
    startUrl: `${mockBase}/fixture`,
    steps: [
      { type: 'click', selector: '#menu-toggle' },
      { type: 'waitFor', selector: '#menu:not([hidden]) #cart' },
      { type: 'snapshot', label: 'menu-only', context: '#menu' },
    ],
  });
  await api('POST', `/api/journeys/${created.body.id}/run`);
  const journey = await waitForRun(created.body.id);

  assert.equal(journey.lastRun.ok, true, journey.lastRun.error || '');
  assert.equal(journey.lastRun.snapshots[0].context, '#menu');
  assert.equal(journey.lastRun.snapshots[0].issues, 1);
  assert.equal(evaluateCalls.at(-1).context, '#menu');

  const causes = await stateCauses('site-demo');
  const scoped = causes.filter((c) => c.journeyId === created.body.id);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].ruleId, 'wcag21-2_4_4');
});

test('a failed run is recorded and leaves the previous causes alone', { skip: browserMissing || false }, async () => {
  const before = (await stateCauses('site-demo')).filter((c) => c.journeyId === runId);
  assert.equal(before.length, 2);

  // Both snapshots still succeed; the run dies on a step after them. Folding
  // that partial result in would read as "the rest got fixed".
  const updated = await api('POST', `/api/journeys/${runId}`, {
    steps: [
      { type: 'click', selector: '#cookie-accept', optional: true },
      { type: 'snapshot', label: 'home' },
      { type: 'click', selector: '#menu-toggle' },
      { type: 'waitFor', selector: '#menu:not([hidden]) #cart' },
      { type: 'snapshot', label: 'menu-open' },
      { type: 'click', selector: '#definitely-not-here', timeoutMs: 1500 },
    ],
  });
  assert.equal(updated.status, 200);

  await api('POST', `/api/journeys/${runId}/run`);
  const journey = await waitForRun(runId);
  assert.equal(journey.lastRun.ok, false);
  // Six declared steps plus the prepended implicit goto: the bad click is 7.
  assert.match(journey.lastRun.error, /step 7 \(click\)/);

  const after = (await stateCauses('site-demo')).filter((c) => c.journeyId === runId);
  assert.deepEqual(after.map((c) => c.id).sort(), before.map((c) => c.id).sort());
  assert.deepEqual(after.map((c) => c.instances), before.map((c) => c.instances));
});
