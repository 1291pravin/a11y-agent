// AQA v3.1 API client, ported to library form from 1291pravin/aqa-usablenet-helper.
// Real mode when AQA_TEAMSLUG + AQA_API_KEY are set; otherwise every call throws
// so callers fall back to demo behavior.
//
// Mutations are idempotent: existing_name errors fall back to lookup-and-return.
// Retry with backoff on 429/5xx (AQA schedulers are known to 500 intermittently).
//
// NOTE (M1): testGet, runFlows and runFlowIssues response shapes were validated
// against a live account. testRun and runGet are wired from the OpenAPI spec index
// and handled defensively by callers (status|state field, finished/completed/done
// vs error/failed) - they still need one confirmation pass against a live run.

// AQA_BASE override lets tests point the client at a local mock server.
const BASE = process.env.AQA_BASE || 'https://api-aqa.usablenet.com/v3.1';

const teamslug = process.env.AQA_TEAMSLUG;
const apiKey = process.env.AQA_API_KEY;

export const isReal = Boolean(teamslug && apiKey);

// M5: global sliding-window rate budget shared by every AQA request in this
// process - polling and retries included. When the window is exhausted the
// caller awaits until the oldest request ages out.
const MAX_RPM = Math.max(1, Number(process.env.AQA_MAX_RPM) || 60);
const RATE_WINDOW_MS = Math.max(1, Number(process.env.AQA_RATE_WINDOW_MS) || 60000);
const rateStamps = [];

export async function acquireRateSlot() {
  for (;;) {
    const now = Date.now();
    while (rateStamps.length && now - rateStamps[0] >= RATE_WINDOW_MS) rateStamps.shift();
    if (rateStamps.length < MAX_RPM) { rateStamps.push(now); return; }
    await sleep(rateStamps[0] + RATE_WINDOW_MS - now + 5);
  }
}

function assertReal() {
  if (!isReal) {
    const e = new Error('AQA credentials not set (AQA_TEAMSLUG, AQA_API_KEY) - demo mode');
    e.code = 'DEMO_MODE';
    throw e;
  }
}

export async function rulesets() { assertReal(); return req('GET', '/a11y/tests/rulesets'); }
export async function devices() { assertReal(); return req('GET', '/aqa/devices'); }
export async function suiteGet(suiteId) { assertReal(); return req('GET', `/a11y/suites/${suiteId}`); }
export async function testGet(testId) { assertReal(); return req('GET', `/a11y/tests/${testId}`); }
export async function testsList(suiteId) { assertReal(); return req('GET', `/a11y/tests?suiteId=${encodeURIComponent(suiteId)}`); }

export async function flowUrlCreate({ suiteId, name, url, deviceId, description }) {
  assertReal();
  const body = { name, url, deviceId };
  if (description) body.description = description;
  try {
    const res = await req('POST', `/a11y/suites/${suiteId}/flows/url/create`, body, { form: true });
    return { ...res, existed: false };
  } catch (err) {
    if (!isExistingName(err)) throw err;
    const details = await req('GET', `/a11y/suites/${suiteId}`);
    const found = (details.flows || []).find((f) => f.name === name);
    if (!found) throw err;
    return { id: found.id, name: found.name, existed: true };
  }
}

export async function testCreate({ suiteId, name, packId, rulesetId, flowIds }) {
  assertReal();
  const body = { suiteId, name, rulesetPackId: packId, rulesetId, flowIds };
  try {
    const res = await req('POST', '/a11y/tests/create', body);
    return { ...res, existed: false };
  } catch (err) {
    if (!isExistingName(err)) throw err;
    const list = await req('GET', '/a11y/tests');
    const found = (list.tests || []).find((t) => t.name === name);
    if (!found) throw err;
    return { id: found.id, name: found.name, existed: true };
  }
}

export async function schedulerCreate({ testId, cadence = 'week', repeats = 0 }) {
  assertReal();
  const body = { startTime: Math.floor(Date.now() / 1000), execution: cadence };
  if (cadence !== 'once') body.numRepeats = repeats;
  return req('POST', `/a11y/tests/${testId}/scheduler/create`, body);
}

// Paths from the OpenAPI spec index; testRun/runGet shapes handled defensively upstream.
export async function testRun(testId) { assertReal(); return req('POST', `/a11y/tests/${testId}/run`); }
export async function runGet(runId) { assertReal(); return req('GET', `/a11y/tests/runs/${runId}`); }
export async function runFlows(runId) { assertReal(); return req('GET', `/a11y/tests/runs/${runId}/flows`); }
export async function runIssues(runId, flowId) {
  assertReal();
  return req('GET', `/a11y/tests/runs/${runId}/flows/${flowId}/issues`);
}

// Stateless DOM scoring. Every other call here names a resource AQA already
// owns; this one hands AQA a DOM we captured ourselves. AQA never fetches
// pageUrl - it is a label carried into the response - so this is the only path
// that can score localhost, preview builds, and pages behind a login.
//
// Live API (colgate account, 2026): evaluate requires rulesetPackId (typically
// `v2` from GET /a11y/tests/rulesets) alongside rulesetId. Without the pack the
// server returns HTTP 404 `pack_not_found`, which is easy to misread as a missing
// route. The common-skills api-reference omits the pack field; testCreate uses the
// same pair.
//
// UI labels like WCAG21AA are legacy; map them to pack ruleset ids before POST.
const DEFAULT_RULESET_PACK_ID = process.env.AQA_RULESET_PACK_ID || 'v2';

const LEGACY_RULESET_ID = {
  WCAG21AA: 'wcag21',
  WCAG22AA: 'wcag22',
  WCAG21A: 'wcag21_levelA_1',
  WCAG22A: 'wcag22_levelA_1',
  wcag2aa: 'wcag21',
  'wcag-2.1-aa': 'wcag21',
  'wcag-2.2-aa': 'wcag22',
};

export function normalizeEvaluateRuleset(rulesetId) {
  const id = String(rulesetId || '').trim();
  return LEGACY_RULESET_ID[id] || id;
}

export async function evaluate({
  rulesetId,
  rulesetPackId,
  pageUrl,
  code,
  context,
  manual = false,
}) {
  assertReal();
  const body = {
    rulesetPackId: rulesetPackId || DEFAULT_RULESET_PACK_ID,
    rulesetId: normalizeEvaluateRuleset(rulesetId),
    pageUrl,
    code,
    manual: Boolean(manual),
  };
  // context scopes scoring to a subtree; omitted entirely rather than sent empty.
  if (context) body.context = context;
  return req('POST', '/a11y/tests/evaluate', body, { form: true });
}

export async function runFlowIssues(runId, flowId, { stepIndex = 0, changeIndex = -1, manual = false } = {}) {
  assertReal();
  const q = new URLSearchParams({
    changeIndex: String(changeIndex),
    manual: String(manual),
    stepIndex: String(stepIndex),
  });
  return req('GET', `/a11y/tests/runs/${runId}/flows/${flowId}/issues?${q}`);
}

async function req(method, path, body, { form = false } = {}) {
  const url = `${BASE}/${teamslug}${path}`;
  const headers = { 'x-team': apiKey, accept: 'application/json' };
  let payload;
  if (body !== undefined && method !== 'GET') {
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(flattenForm(body)).toString();
    } else {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    await acquireRateSlot();
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (res.ok) return parsed;
    if (res.status === 429 || res.status >= 500) {
      lastErr = httpErr(method, path, res.status, parsed ?? text);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    throw httpErr(method, path, res.status, parsed ?? text);
  }
  throw lastErr;
}

function httpErr(method, path, status, body) {
  const e = new Error(`AQA ${method} ${path} -> HTTP ${status}`);
  e.status = status;
  e.body = body;
  return e;
}
function isExistingName(err) { return err?.status === 400 && err.body?.error === 'existing_name'; }
function flattenForm(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}
function safeJson(t) { try { return JSON.parse(t); } catch { return t; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
