// API handlers. All JSON in/out. Router in index.mjs calls handle(req, res, url).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getState, update, nextId, resetToSeed, usesRealFleet, bootstrapFleet } from './store.mjs';
import { dispatchTask, retryTask, demoScan, startRealScan, verifyMerge, cursorMode } from './orchestrator.mjs';
import { slotFor, schedulerEnabled } from './scheduler.mjs';
import { allJourneys, findJourney, makeJourney, startJourneyRun, runnerHealth } from './journeys.mjs';
import { validateJourney } from './journey-model.mjs';
import { startDiscovery, acceptProposals, FOCUS_AREAS } from './journey-propose.mjs';
import { startFixRun, cancelFixRun, findFixRun, allFixRuns } from './fix-run.mjs';
import { journeyReportMarkdown, actionFor } from './report.mjs';
import { scoreCauses, openCauses, formatCauseLocator } from './aqa-sync.mjs';
import * as aqa from '../integrations/aqa.mjs';
import * as cursor from '../integrations/cursor.mjs';
import * as cursorCli from '../integrations/cursor-cli.mjs';

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

  // Two ways to onboard. The default ("full") is the AQA suite path and keeps
  // its original contract. mode:'quick' is the evaluate path: it needs nothing
  // but a URL and a ruleset, because evaluate scores a DOM we captured
  // ourselves and never touches a suite. A repo stays optional in both - it
  // enables source mapping and Cursor auto-fix, not scanning.
  if (method === 'POST' && path === '/api/sites') {
    const body = await readBody(req);
    const required = body.mode === 'quick' ? ['url', 'rulesetId'] : ['url', 'repo', 'suiteId'];
    const missing = required.filter((k) => !body[k]);
    if (missing.length) return json(res, 400, { error: `missing: ${missing.join(', ')}` });
    const site = makeSite(body);
    update((s) => {
      s.sites.push(site);
      s.activity.unshift({ ts: Date.now(), msg: `Onboarded ${site.url}` });
    });
    return json(res, 201, site);
  }

  // Update editable site fields (local repoPath is required for Cursor CLI fallback).
  let m;
  if (method === 'PATCH' && (m = path.match(/^\/api\/sites\/([\w-]+)$/))) {
    const body = await readBody(req);
    let updated = null;
    update((s) => {
      const site = s.sites.find((x) => x.id === m[1]);
      if (!site) return;
      if (body.repoPath !== undefined) site.repoPath = body.repoPath ? String(body.repoPath) : null;
      if (body.repo !== undefined) site.repo = body.repo ? String(body.repo) : null;
      if (body.framework !== undefined) site.framework = String(body.framework || 'unknown');
      updated = site;
      s.activity.unshift({ ts: Date.now(), msg: `Updated site ${site.url}` });
    });
    if (!updated) return json(res, 404, { error: 'site not found' });
    return json(res, 200, updated);
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

  // Full scored report for a journey run: score, what is failing and where,
  // coverage, and the steps walked. Downloadable as Markdown.
  if (method === 'GET' && (m = path.match(/^\/api\/journeys\/([\w-]+)\/report$/))) {
    const s = getState();
    const journey = findJourney(m[1], s);
    if (!journey) return json(res, 404, { error: 'journey not found' });
    const site = s.sites.find((x) => x.id === journey.siteId) || null;
    const causes = openCauses(s.causes.filter((c) => c.journeyId === journey.id));
    const body = journeyReportMarkdown({ journey, site, causes });
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="a11y-report-${journey.id}.md"`,
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
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

  // ── Journey discovery ─────────────────────────────────────────────────────
  // Propose the journeys rather than making someone hand-build them. Fire and
  // forget: the client watches site.discover through the state poll, then
  // reviews and accepts.

  if (method === 'GET' && path === '/api/discover/focus-areas') {
    return json(res, 200, { focusAreas: FOCUS_AREAS });
  }

  if (method === 'POST' && (m = path.match(/^\/api\/sites\/([\w-]+)\/discover$/))) {
    const site = getState().sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    if (site.discover?.state === 'running') return json(res, 409, { error: 'discovery already running for this site' });
    const body = await readBody(req);
    const focus = Array.isArray(body.focus) ? body.focus.map(String) : [];
    // Free-form intent trumps focus chips. Persisted on the site so a
    // re-discovery uses the same prompt without the UI having to remember it.
    const intent = typeof body.intent === 'string' ? body.intent.slice(0, 4000) : (site.intent || '');
    if (intent !== site.intent) {
      update((s) => {
        const t = s.sites.find((x) => x.id === site.id);
        if (t) t.intent = intent;
      });
    }
    startDiscovery(site.id, { focus, intent });
    return json(res, 202, { ok: true, siteId: site.id });
  }

  if (method === 'POST' && (m = path.match(/^\/api\/sites\/([\w-]+)\/journeys\/accept$/))) {
    const site = getState().sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    const body = await readBody(req);
    const result = acceptProposals(site.id, body.accept, { autoRun: Boolean(body.autoRun) });
    if (result.error) return json(res, 400, { error: result.error });
    return json(res, 201, { created: result.created.length, skipped: result.skipped, journeys: result.created, autoRun: Boolean(body.autoRun) });
  }

  // M8: same shape as /accept, but always kicks off a scan on every created
  // journey. This is the "Approve & scan" button on the review screen -
  // separated as its own route so a client that just wants to persist the
  // journeys without triggering runs (batch tooling, CLI) can still use
  // /accept without opting in.
  if (method === 'POST' && (m = path.match(/^\/api\/sites\/([\w-]+)\/journeys\/approve$/))) {
    const site = getState().sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    const body = await readBody(req);
    const result = acceptProposals(site.id, body.accept, { autoRun: true });
    if (result.error) return json(res, 400, { error: result.error });
    return json(res, 201, {
      created: result.created.length, skipped: result.skipped, journeys: result.created, autoRun: true,
    });
  }

  // M8: consolidated site report - aggregates causes across every journey on
  // the site plus the AQA suite. Feeds the #/site/:id/report UI screen (the
  // "Fix All" surface); the per-journey markdown report at
  // /api/journeys/:id/report stays as it is for exports.
  if (method === 'GET' && (m = path.match(/^\/api\/sites\/([\w-]+)\/report$/))) {
    const s = getState();
    const site = s.sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    return json(res, 200, buildSiteReport(s, site));
  }

  if (method === 'POST' && (m = path.match(/^\/api\/sites\/([\w-]+)\/scan$/))) {
    const site = getState().sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    if (site.scanState === 'running') return json(res, 409, { error: 'scan already running for this site' });
    if (aqa.isReal) {
      if (!site.testId) return json(res, 400, { error: 'site has no AQA testId; provision a test before scanning' });
      startRealScan(site.id);
      return json(res, 202, { ok: true, mode: 'real' });
    }
    demoScan(site);
    return json(res, 202, { ok: true, mode: 'demo' });
  }

  // Audit-only sites (no GitHub repo): export open causes as fix-report.md.
  if (method === 'GET' && (m = path.match(/^\/api\/sites\/([\w-]+)\/fix-report$/))) {
    const s = getState();
    const site = s.sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    const causes = s.causes.filter((c) => c.siteId === site.id && c.status === 'open');
    const body = fixReport(site, causes, { auditOnly: !site.repo });
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="fix-report-${site.id}.md"`,
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  // M9: batch dispatch. Body may include:
  //   causeIds:[cause-id],   // explicit set; omit to dispatch every dispatchable cause
  //   concurrency:number,    // 1-10, defaults to FIXRUN_CONCURRENCY env or 3
  //   budgetUsd:number,      // dollars; run stops itself before exceeding
  //   autoMerge:boolean      // reserved for M10 - Local Verifier gates merges
  if (method === 'POST' && (m = path.match(/^\/api\/sites\/([\w-]+)\/fix-runs$/))) {
    const body = await readBody(req);
    const result = startFixRun(m[1], {
      causeIds: Array.isArray(body.causeIds) ? body.causeIds : undefined,
      concurrency: body.concurrency,
      budgetUsd: body.budgetUsd,
      autoMerge: body.autoMerge,
    });
    if (result.error) return json(res, 400, { error: result.error });
    return json(res, 201, result.run);
  }

  if (method === 'GET' && (m = path.match(/^\/api\/sites\/([\w-]+)\/fix-runs$/))) {
    const runs = allFixRuns().filter((r) => r.siteId === m[1]);
    return json(res, 200, { runs });
  }

  if (method === 'GET' && (m = path.match(/^\/api\/fix-runs\/([\w-]+)$/))) {
    const run = findFixRun(m[1]);
    if (!run) return json(res, 404, { error: 'fix run not found' });
    return json(res, 200, run);
  }

  if (method === 'POST' && (m = path.match(/^\/api\/fix-runs\/([\w-]+)\/cancel$/))) {
    const result = cancelFixRun(m[1]);
    if (result.error) return json(res, 404, { error: result.error });
    return json(res, 200, result.run);
  }

  if (method === 'POST' && (m = path.match(/^\/api\/causes\/([\w-]+)\/dispatch$/))) {
    const s = getState();
    const cause = s.causes.find((x) => x.id === m[1]);
    if (!cause) return json(res, 404, { error: 'cause not found' });
    if (cause.status !== 'open') return json(res, 409, { error: `cause already ${cause.status}` });
    const site = s.sites.find((x) => x.id === cause.siteId);
    if (!site) return json(res, 404, { error: 'site not found' });
    // A fix task is a code change, so it needs somewhere to land. Quick-scan
    // sites are audit-only until a GitHub repo is attached.
    if (!site.repo) {
      return json(res, 400, { error: 'site has no GitHub repo; add one to enable auto-fix, or export a report instead' });
    }
    const task = dispatchTask(cause, site);
    return json(res, 201, task);
  }

  if (method === 'POST' && (m = path.match(/^\/api\/tasks\/([\w-]+)\/retry$/))) {
    try {
      const task = retryTask(m[1]);
      return json(res, 200, task);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
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
// Rule -> suggested action now lives in report.mjs so the site hand-off report
// and the full journey report describe the same rule the same way.


function fixReport(site, causes, { auditOnly = true } = {}) {
  const lines = [
    `# Fix report - ${site.url}`,
    '',
    `- Site: ${site.url}`,
    `- Suite: ${site.suiteId}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Open causes: ${causes.length}`,
    '',
  ];
  if (auditOnly) {
    lines.push(
      'This site has no GitHub repo attached, so fixes cannot be dispatched automatically.',
      'Hand this report to the owning team.',
      '',
    );
  } else {
    lines.push('Open accessibility root causes from the latest AQA run.', '');
  }
  if (!causes.length) lines.push('No open causes to report.', '');
  for (const c of causes) {
    const locator = formatCauseLocator(c);
    lines.push(
      `## ${c.title}`,
      '',
      `- Rule: ${c.rule} (${c.ruleId})`,
      `- Severity: ${c.severity}`,
      `- Instances: ${c.instances}`,
      `- Pages: ${(c.pages || []).join(', ') || '-'}`,
      locator ? `- AQA locator: \`${locator}\`` : '',
      `- Evidence: \`${c.evidence || '-'}\``,
      `- Suggested action: ${actionFor(c.ruleId)}`,
      '',
    );
  }
  return lines.join('\n');
}

// M8: shape the site report the way the "Fix All" screen needs it - a single
// payload the UI can render without walking the full public state. Aggregates
// causes across every journey plus the AQA suite so the reviewer sees the
// site as a whole, not per-journey. Severity breakdown is precomputed so the
// UI stays presentational.
function buildSiteReport(s, site) {
  const journeys = (s.journeys || []).filter((j) => j.siteId === site.id);
  const journeyRunning = journeys.filter((j) => j.runState === 'running').length;
  const journeyReady = journeys.filter((j) => j.lastRun && j.lastRun.ok !== false).length;
  const journeyFailed = journeys.filter((j) => j.lastRun && j.lastRun.ok === false).length;

  const causesForSite = s.causes.filter((c) => c.siteId === site.id);
  const openList = openCauses(causesForSite);
  // Score across the whole site: units = one per journey snapshot (visible
  // surface). Matches how the per-journey score normalizes.
  const snapshotUnits = journeys.reduce((acc, j) => acc + (j.lastRun?.snapshots?.length || 0), 0);
  const score = scoreCauses(openList, { units: Math.max(1, snapshotUnits || journeys.length || 1) });

  const bySev = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const c of openList) bySev[c.severity] = (bySev[c.severity] || 0) + (c.instances || 1);

  const causes = openList.map((c) => ({
    id: c.id,
    title: c.title,
    ruleId: c.ruleId,
    rule: c.rule,
    severity: c.severity,
    instances: c.instances,
    pages: c.pages || [],
    journeyId: c.journeyId || null,
    status: c.status,
    // A cause the fix batch already has a task or PR against is not eligible
    // for re-dispatch. The UI uses this to gray out its row and hide the
    // Include checkbox.
    hasOpenTask: s.tasks.some((t) => t.causeId === c.id && (t.state === 'queued' || t.state === 'running')),
    hasOpenPr: s.prs.some((p) => p.causeId === c.id && p.state === 'open'),
  }));

  return {
    site: {
      id: site.id, url: site.url, mode: site.mode,
      score, framework: site.framework, repo: site.repo,
    },
    journeys: journeys.map((j) => ({
      id: j.id, name: j.name,
      runState: j.runState,
      lastRun: j.lastRun ? {
        at: j.lastRun.at, ok: j.lastRun.ok, unscored: j.lastRun.unscored,
        error: j.lastRun.error, score: j.lastRun.score, causes: j.lastRun.causes,
        snapshots: j.lastRun.snapshots?.length || 0,
      } : null,
    })),
    stats: {
      journeys: journeys.length,
      journeyRunning, journeyReady, journeyFailed,
      openCauses: openList.length,
      severity: bySev,
      // A batch dispatch cost is capped separately (see fix-runs) but this is
      // the ceiling to display next to the "Fix All" CTA so the operator sees
      // roughly what they are about to authorize.
      dispatchable: causes.filter((c) => !c.hasOpenTask && !c.hasOpenPr).length,
    },
    causes,
    lastReportAt: Date.now(),
  };
}

function publicState() {
  const s = getState();
  return {
    settings: s.settings,
    mode: modeInfo(),
    // Score is derived, not stored: computing it here keeps it consistent with
    // whatever the causes currently say instead of going stale behind them.
    sites: s.sites.map((x) => ({
      ...x,
      schedule: slotFor(x.id),
      score: scoreCauses(openCauses(s.causes.filter((c) => c.siteId === x.id)), {
        units: Math.max(1, x.flows.length),
      }),
    })),
    journeys: s.journeys || [],
    causes: s.causes,
    tasks: s.tasks,
    prs: s.prs,
    fixRuns: s.fixRuns || [],
    activity: s.activity.slice(0, 30),
  };
}

function modeInfo() {
  return {
    aqa: aqa.isReal ? 'real' : 'demo',
    cursor: cursor.isReal ? 'real' : (cursorCli.isAvailable() ? 'cli-ready' : 'demo'),
    cursorMode: cursorMode(),
    cursorCli: cursorCli.isAvailable(),
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
    url: String(body.url),
    // Optional on the quick-scan path: a journey-scored site has no AQA suite,
    // and a site with no repo is audit-only (no source mapping, no auto-fix).
    repo: body.repo ? String(body.repo) : null,
    suiteId: body.suiteId ? String(body.suiteId) : null,
    rulesetId: body.rulesetId ? String(body.rulesetId) : null,
    mode: body.mode === 'quick' ? 'quick' : 'full',
    repoPath: body.repoPath ? String(body.repoPath) : null,
    testId: body.testId ? String(body.testId) : null,
    status: 'onboarding', critical: 0, total: 0, trend: [], lastRun: null,
    framework: body.framework || 'unknown',
    flows: [],
    discover: null,
    // Free-form onboarding prompt — what the customer wants us to focus on,
    // fed into the Journey Designer LLM prompt. Optional; empty string when
    // the customer skipped the textarea.
    intent: body.intent ? String(body.intent).slice(0, 4000) : '',
    // Optional dev-server config; used by the Local Verifier once M10 lands.
    // Persisted here now so the onboarding form can capture it up front.
    devServer: normalizeDevServer(body.devServer),
  };
}

function normalizeDevServer(input) {
  if (!input || typeof input !== 'object') return null;
  const s = (k) => (input[k] ? String(input[k]).slice(0, 500) : '');
  const out = {
    installCmd: s('installCmd'),
    startCmd: s('startCmd'),
    previewUrl: s('previewUrl'),
    healthPath: s('healthPath') || '/',
    readyTimeoutSec: Math.max(5, Math.min(600, Number(input.readyTimeoutSec) || 60)),
    envFile: s('envFile'),
  };
  if (!out.installCmd && !out.startCmd && !out.previewUrl) return null;
  return out;
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
