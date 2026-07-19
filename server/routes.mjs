// API handlers. All JSON in/out. Router in index.mjs calls handle(req, res, url).

import { getState, update, nextId, resetToSeed } from './store.mjs';
import { dispatchTask, demoScan } from './orchestrator.mjs';
import * as aqa from '../integrations/aqa.mjs';
import * as cursor from '../integrations/cursor.mjs';

export async function handle(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  if (method === 'GET' && path === '/api/health') {
    return json(res, 200, {
      ok: true,
      mode: { aqa: aqa.isReal ? 'real' : 'demo', cursor: cursor.isReal ? 'real' : 'demo' },
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
    const site = {
      id: nextId('site-'),
      url: String(body.url), repo: String(body.repo), suiteId: String(body.suiteId),
      status: 'onboarding', critical: 0, total: 0, trend: [], lastRun: null,
      framework: body.framework || 'unknown',
      flows: [],
    };
    update((s) => {
      s.sites.push(site);
      s.activity.unshift({ ts: Date.now(), msg: `Onboarded ${site.url}` });
    });
    return json(res, 201, site);
  }

  let m;

  if (method === 'POST' && (m = path.match(/^\/api\/sites\/([\w-]+)\/scan$/))) {
    const site = getState().sites.find((x) => x.id === m[1]);
    if (!site) return json(res, 404, { error: 'site not found' });
    if (aqa.isReal) {
      // M1: trigger real runs per test and poll. Not implemented yet.
      return json(res, 501, { error: 'real AQA scan lands in M1; demo mode works today' });
    }
    demoScan(site);
    return json(res, 202, { ok: true, mode: 'demo' });
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

  if (method === 'POST' && path === '/api/settings') {
    const body = await readBody(req);
    update((s) => {
      if (body.policies) Object.assign(s.settings.policies, body.policies);
      if (body.notifications) Object.assign(s.settings.notifications, body.notifications);
    });
    return json(res, 200, getState().settings);
  }

  if (method === 'POST' && path === '/api/demo/reset') {
    resetToSeed();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

function publicState() {
  const s = getState();
  return {
    settings: s.settings,
    mode: { aqa: aqa.isReal ? 'real' : 'demo', cursor: cursor.isReal ? 'real' : 'demo' },
    sites: s.sites,
    causes: s.causes,
    tasks: s.tasks,
    prs: s.prs,
    activity: s.activity.slice(0, 30),
  };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}
