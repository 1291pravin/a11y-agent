// API handlers. All JSON in/out. Router in index.mjs calls handle(req, res, url).

import { existsSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getState, update, nextId, resetToSeed, usesRealFleet, bootstrapFleet } from './store.mjs';
import { dispatchTask, demoScan, startRealScan, verifyMerge } from './orchestrator.mjs';
import { buildIndex, mapCause } from './mapper.mjs';
import { slotFor, schedulerEnabled } from './scheduler.mjs';
import { allJourneys, findJourney, makeJourney, startJourneyRun, runnerHealth } from './journeys.mjs';
import { validateJourney } from './journey-model.mjs';
import * as aqa from '../integrations/aqa.mjs';
import * as cursor from '../integrations/cursor.mjs';

// M5: optional shared admin token. When set, every non-GET /api/* route
// requires "authorization: Bearer <token>" - except the GitHub webhook,
// which has its own HMAC auth. GET routes stay open (read-only).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

export async function handle(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  if (ADMIN_TOKEN && method !== 'GET' && path !== '/api/webhooks/github') {
    if (!validBearer(req.headers.authorization)) return json(res, 401, { error: 'auth required' });
  }

  if (method === 'GET' && path === '/api/health') {
    return json(res, 200, {
      ok: true,
      mode: modeInfo(),
      time: new Date().toISOString(),
    });
  }

  if (method === 'GET' && path === '/api/state') {
    return json(res, 200, publicState());
  }

  if (method === 'POST' && path === '/api/sites') {
    const body = await readBody(req);
    const missing = ['url', 'repo', 'suiteId'].filter((k) => !body[k]);
    if (missing.length) return json(res, 400, { error: `missing: ${missing.join(', ')}` });
    const site = makeSite(body);
    update((s) => {
      s.sites.push(site);
      s.activity.unshift({ ts: Date.now(), msg: `Onboarded ${site.url}` });
    });
    return json(res, 201, site);
  }

  // M5: batch onboarding. Body is raw CSV text with a header row naming the
  // columns (url,repo,suiteId required; testId,repoPath,framework optional;
  // any order, unknown columns ignored). Rows whose url or suiteId already
  // exist are skipped; rows missing required fields are collected as errors
  // without aborting the batch.
  if (method === 'POST' && path === '/api/sites/batch') {
    const raw = await readRawBody(req);
    const parsed = parseCsvBatch(raw);
    if (parsed.error) return json(res, 400, { error: parsed.error });
    let created = 0;
    let skipped = 0;
    update((s) => {
      for (const row of parsed.rows) {
        if (s.sites.some((x) => x.url === row.url || x.suiteId === row.suiteId)) { skipped += 1; continue; }
        s.sites.push(makeSite(row));
        created += 1;
      }
      if (created) s.activity.unshift({ ts: Date.now(), msg: `Batch onboarded ${created} site(s) from CSV (${skipped} skipped, ${parsed.errors.length} errors)` });
    });
    return json(res, 200, { created, skipped, errors: parsed.errors });
  }

  let m;

  // ── Journeys (evaluate path) ──────────────────────────────────────────────
  // A journey is the supplement to a site's AQA suite, never a replacement:
  // these routes only ever touch state.journeys and the causes a journey
  // produced. suiteId/testId and suite-derived causes are left alone.

  if (method === 'GET' && path === '/api/journeys') {
    const list = allJourneys();
    const siteId = url.searchParams.get('siteId');
    return json(res, 200, { journeys: siteId ? list.filter((j) => j.siteId === siteId) : list });
  }

  if (method === 'POST' && path === '/api/journeys') {
    const body = await readBody(req);
    const site = getState().sites.find((x) => x.id === body.siteId);
    if (!site) return json(res, 400, { error: 'unknown siteId' });
    const parsed = validateJourney(body);
    if (parsed.errors) return json(res, 400, { error: parsed.errors.join('; '), errors: parsed.errors });
    // Idempotent create: re-posting the same journey name for a site returns
    // the existing record instead of a duplicate (same rule as flowUrlCreate).
    const existing = allJourneys().find((j) => j.siteId === site.id && j.name === parsed.journey.name);
    if (existing) return json(res, 200, { ...existing, existed: true });
    const journey = makeJourney(site.id, parsed.journey);
    update((s) => {
      allJourneys(s).push(journey);
      s.activity.unshift({ ts: Date.now(), msg: `Journey "${journey.name}" created for ${site.url}` });
    });
    return json(res, 201, journey);
  }

  if (method === 'POST' && (m = path.match(/^\/api\/journeys\/([\w-]+)\/run$/))) {
    const journey = findJourney(m[1]);
    if (!journey) return json(res, 404, { error: 'journey not found' });
    if (journey.runState === 'running') return json(res, 409, { error: 'journey run already in flight' });
    startJourneyRun(journey.id);
    return json(res, 202, { ok: true, journeyId: journey.id });
  }

  if (method === 'GET' && (m = path.match(/^\/api\/journeys\/([\w-]+)$/))) {
    const journey = findJourney(m[1]);
    if (!journey) return json(res, 404, { error: 'journey not found' });
    return json(res, 200, journey);
  }

  if (method === 'POST' && (m = path.match(/^\/api\/journeys\/([\w-]+)$/))) {
    const journey = findJourney(m[1]);
    if (!journey) return json(res, 404, { error: 'journey not found' });
    if (journey.runState === 'running') return json(res, 409, { error: 'journey run in flight' });
    const body = await readBody(req);
    // Full replace of the editable fields; siteId and id are immutable so a
    // journey's causes can never migrate to another site behind our back.
    const parsed = validateJourney({ ...journey, ...body });
    if (parsed.errors) return json(res, 400, { error: parsed.errors.join('; '), errors: parsed.errors });
    update((s) => {
      const j = findJourney(journey.id, s);
      if (j) Object.assign(j, parsed.journey);
      s.activity.unshift({ ts: Date.now(), msg: `Journey "${parsed.journey.name}" updated` });
    });
    return json(res, 200, findJourney(journey.id));
  }

  if (method === 'DELETE' && (m = path.match(/^\/api\/journeys\/([\w-]+)$/))) {
    const journey = findJourney(m[1]);
    if (!journey) return json(res, 404, { error: 'journey not found' });
    if (journey.runState === 'running') return json(res, 409, { error: 'journey run in flight' });
    let dropped = 0;
    let kept = 0;
    update((s) => {
      // Open causes go with the journey. Causes that already have a task or a
      // PR against them stay: they are the evidence trail for work in flight.
      s.causes = s.causes.filter((c) => {
        if (c.journeyId !== journey.id) return true;
        if (c.status === 'open') { dropped += 1; return false; }
        kept += 1;
        return true;
      });
      s.journeys = allJourneys(s).filter((j) => j.id !== journey.id);
      s.activity.unshift({ ts: Date.now(), msg: `Journey "${journey.name}" deleted (${dropped} open cause(s) removed, ${kept} kept for in-flight work)` });
    });
    return json(res, 200, { ok: true, dropped, kept });
  }

  // The runner is a separate process, so "is it up" is a real question the
  // control plane cannot answer from its own state.
  if (method === 'GET' && path === '/api/runner/health') {
    return json(res, 200, await runnerHealth());
  }

  if (method === 'POST' && (m = path.match(/^\/api\/sites\/([\w-]+)\/scan$/))) {
    const site = getState().sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    if (aqa.isReal) {
      if (!site.testId) return json(res, 400, { error: 'site has no AQA testId; provision a test before scanning' });
      if (site.scanState === 'running') return json(res, 409, { error: 'scan already running for this site' });
      startRealScan(site.id);
      return json(res, 202, { ok: true, mode: 'real' });
    }
    demoScan(site);
    return json(res, 202, { ok: true, mode: 'demo' });
  }

  // M3: rebuild the source index and remap every open cause of the site.
  if (method === 'POST' && (m = path.match(/^\/api\/sites\/([\w-]+)\/remap$/))) {
    const site = getState().sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    if (!site.repoPath) return json(res, 400, { error: 'site has no repoPath; set one to enable source mapping' });
    if (!existsSync(site.repoPath)) return json(res, 400, { error: `repoPath does not exist: ${site.repoPath}` });
    const index = buildIndex(site.repoPath);
    let mapped = 0;
    let unmapped = 0;
    update((s) => {
      for (const cause of s.causes) {
        if (cause.siteId !== site.id || cause.status !== 'open') continue;
        cause.mappedFile = mapCause(cause, index) || cause.mappedFile || null;
        if (cause.mappedFile) mapped += 1; else unmapped += 1;
      }
      s.activity.unshift({ ts: Date.now(), msg: `Remapped ${site.url}: ${mapped} mapped, ${unmapped} unmapped` });
    });
    return json(res, 200, { mapped, unmapped });
  }

  // M3: unmapped open causes export as a fix-report.md handoff for humans.
  if (method === 'GET' && (m = path.match(/^\/api\/sites\/([\w-]+)\/fix-report$/))) {
    const s = getState();
    const site = s.sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    const causes = s.causes.filter((c) => c.siteId === site.id && c.status === 'open' && !c.mappedFile);
    const body = fixReport(site, causes);
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="fix-report-${site.id}.md"`,
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  if (method === 'POST' && (m = path.match(/^\/api\/causes\/([\w-]+)\/dispatch$/))) {
    const s = getState();
    const cause = s.causes.find((x) => x.id === m[1]);
    if (!cause) return json(res, 404, { error: 'cause not found' });
    if (!cause.mappedFile) return json(res, 400, { error: 'cause is unmapped; export a report instead' });
    if (cause.status !== 'open') return json(res, 409, { error: `cause already ${cause.status}` });
    const site = s.sites.find((x) => x.id === cause.siteId);
    const task = dispatchTask(cause, site);
    return json(res, 201, task);
  }

  // M4: GitHub pull_request webhook. Only merged closes matter; the signature
  // is verified against the raw body bytes when GITHUB_WEBHOOK_SECRET is set.
  if (method === 'POST' && path === '/api/webhooks/github') {
    const raw = await readRawBody(req);
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (secret && !validSignature(raw, req.headers['x-hub-signature-256'], secret)) {
      return json(res, 401, { error: 'invalid signature' });
    }
    let payload;
    try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
    if (payload.action !== 'closed' || !payload.pull_request?.merged) {
      return json(res, 202, { ok: true, ignored: true });
    }
    const num = String(payload.pull_request.number);
    const repo = payload.repository?.full_name;
    const s = getState();
    const pr = s.prs.find((p) => String(p.num) === num && p.state === 'open'
      && s.sites.find((x) => x.id === p.siteId)?.repo === repo);
    if (!pr) return json(res, 202, { ok: true, ignored: true });
    verifyMerge(pr).catch((err) => console.error('verifyMerge:', err.message));
    return json(res, 202, { ok: true, verifying: true });
  }

  // M4: manual merge intake - the "Mark merged" button and offices without
  // webhook access. Same verification path as the webhook.
  if (method === 'POST' && (m = path.match(/^\/api\/prs\/([\w-]+)\/merged$/))) {
    const pr = getState().prs.find((p) => String(p.num) === m[1]);
    if (!pr) return json(res, 404, { error: 'PR not found' });
    if (pr.state !== 'open') return json(res, 409, { error: `PR already ${pr.state}` });
    verifyMerge(pr).catch((err) => console.error('verifyMerge:', err.message));
    return json(res, 202, { ok: true, verifying: true });
  }

  if (method === 'POST' && path === '/api/settings') {
    const body = await readBody(req);
    update((s) => {
      if (body.policies) Object.assign(s.settings.policies, body.policies);
      if (body.notifications) Object.assign(s.settings.notifications, body.notifications);
    });
    return json(res, 200, getState().settings);
  }

  if (method === 'POST' && path === '/api/demo/reset') {
    const state = await resetToSeed();
    return json(res, 200, { ok: true, sites: state.sites.length, mode: usesRealFleet() ? 'aqa' : 'demo' });
  }

  if (method === 'POST' && path === '/api/fleet/sync') {
    if (!usesRealFleet()) return json(res, 400, { error: 'AQA credentials and FLEET_SITES required' });
    const state = await bootstrapFleet({ clearFile: true });
    return json(res, 200, { ok: true, sites: state.sites.length });
  }

  return json(res, 404, { error: 'not found' });
}

// Suggested manual actions per AQA rule, used by the fix-report export.
const RULE_ACTIONS = {
  'image-alt': 'Add descriptive alt text to the image (or alt="" if purely decorative).',
  'link-name': 'Give the link a discernible name: visible text, aria-label, or a visually hidden span.',
  'color-contrast': 'Raise the text/background contrast ratio to at least 4.5:1 (3:1 for large text).',
  'frame-title': 'Add a title attribute to the iframe that describes its content.',
  'label': 'Associate a label with the form control via label[for], aria-label, or aria-labelledby.',
  'heading-order': 'Restructure headings so levels increase one step at a time without skipping.',
};

const DEFAULT_ACTION = 'Review the flagged element against the rule and patch the owning component or template.';

function fixReport(site, causes) {
  const lines = [
    `# Fix report - ${site.url}`,
    '',
    `- Site: ${site.url}`,
    `- Suite: ${site.suiteId}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Unmapped open causes: ${causes.length}`,
    '',
    'These root causes could not be mapped to a source file (vendor embeds, CMS',
    'content, or code outside the indexed repo), so no fix task was dispatched.',
    'Hand this report to the owning team.',
    '',
  ];
  if (!causes.length) lines.push('Nothing to hand off - every open cause is mapped to a source file.', '');
  for (const c of causes) {
    lines.push(
      `## ${c.title}`,
      '',
      `- Rule: ${c.rule} (${c.ruleId})`,
      `- Severity: ${c.severity}`,
      `- Instances: ${c.instances}`,
      `- Pages: ${(c.pages || []).join(', ') || '-'}`,
      `- Evidence: \`${c.evidence || '-'}\``,
      `- Suggested action: ${RULE_ACTIONS[c.ruleId] || DEFAULT_ACTION}`,
      '',
    );
  }
  return lines.join('\n');
}

function publicState() {
  const s = getState();
  return {
    settings: s.settings,
    mode: modeInfo(),
    sites: s.sites.map((x) => ({ ...x, schedule: slotFor(x.id) })),
    journeys: s.journeys || [],
    causes: s.causes,
    tasks: s.tasks,
    prs: s.prs,
    activity: s.activity.slice(0, 30),
  };
}

function modeInfo() {
  return {
    aqa: aqa.isReal ? 'real' : 'demo',
    cursor: cursor.isReal ? 'real' : 'demo',
    auth: Boolean(ADMIN_TOKEN),
    schedule: schedulerEnabled(),
  };
}

// Constant-time bearer comparison; a length mismatch fails fast (length is
// not secret - the token itself is).
function validBearer(header) {
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(`Bearer ${ADMIN_TOKEN}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function makeSite(body) {
  return {
    id: nextId('site-'),
    url: String(body.url), repo: String(body.repo), suiteId: String(body.suiteId),
    repoPath: body.repoPath ? String(body.repoPath) : null,
    testId: body.testId ? String(body.testId) : null,
    status: 'onboarding', critical: 0, total: 0, trend: [], lastRun: null,
    framework: body.framework || 'unknown',
    flows: [],
  };
}

// Minimal CSV: comma-separated cells, optional surrounding double quotes,
// values trimmed, blank lines skipped. Commas inside quoted cells are not
// supported (no field in a site row legitimately contains one).
const CSV_COLUMNS = {
  url: 'url', repo: 'repo', suiteid: 'suiteId',
  testid: 'testId', repopath: 'repoPath', framework: 'framework',
};

function parseCsvBatch(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  let headers = null;
  const rows = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = lines[i].split(',').map(unquoteCell);
    if (!headers) {
      headers = cells.map((h) => CSV_COLUMNS[h.toLowerCase()] || null);
      const have = new Set(headers);
      const missing = ['url', 'repo', 'suiteId'].filter((k) => !have.has(k));
      if (missing.length) return { error: `CSV header row must include: ${missing.join(', ')}` };
      continue;
    }
    const row = {};
    headers.forEach((k, idx) => { if (k && cells[idx]) row[k] = cells[idx]; });
    const missing = ['url', 'repo', 'suiteId'].filter((k) => !row[k]);
    if (missing.length) { errors.push({ line: i + 1, error: `missing: ${missing.join(', ')}` }); continue; }
    rows.push(row);
  }
  if (!headers) return { error: 'empty CSV - header row with url,repo,suiteId required' };
  return { rows, errors };
}

function unquoteCell(cell) {
  const t = cell.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return readRawBody(req).then((data) => {
    try { return data ? JSON.parse(data) : {}; }
    catch { return {}; }
  });
}

// Webhook signatures are computed over the raw body bytes, so it must be read
// before any JSON parsing.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 1e6) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validSignature(raw, header, secret) {
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
