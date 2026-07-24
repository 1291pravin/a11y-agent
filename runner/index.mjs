// Journey runner: a separate process that owns the browser.
//
// Kept out of server/ on purpose. PLAN.md design rule 5 says `git pull` +
// `npm start` must work on any Node 20+ machine with zero runtime deps, and
// Playwright is a heavyweight devDependency with a browser download behind it.
// Splitting it into its own process keeps the control plane installable and
// makes the browser independently restartable when a page wedges it.
//
// Usage: npm run runner        (RUNNER_PORT env, default 4174)
// The control plane finds it via RUNNER_URL (default http://localhost:4174).

import { createServer } from 'node:http';
import { runJourney, dryRunJourney, inspectPage } from './journey-run.mjs';
import * as aqa from '../integrations/aqa.mjs';

const PORT = Number(process.env.RUNNER_PORT) || 4174;
// Loopback by default: this endpoint drives a real browser at any URL it is
// given, which is not something to expose on a shared interface without intent.
const HOST = process.env.RUNNER_HOST || '127.0.0.1';

// Browser launches are heavy, so runs are serialized rather than refused. The
// control plane already prevents a single journey from running twice at once;
// this covers several journeys arriving together.
let queue = Promise.resolve();
let depth = 0;

function enqueue(fn) {
  depth += 1;
  const next = queue.then(fn, fn);
  queue = next.then(() => { depth -= 1; }, () => { depth -= 1; });
  return next;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, browser: 'chromium', aqa: aqa.isReal ? 'real' : 'demo', queued: depth });
    }

    if (req.method === 'POST' && req.url === '/run') {
      const body = await readBody(req);
      const journey = body?.journey;
      if (!journey?.steps?.length) return json(res, 400, { error: 'body must be {journey} with a non-empty steps array' });
      if (!aqa.isReal) return json(res, 400, { error: 'AQA credentials not set (AQA_TEAMSLUG, AQA_API_KEY); evaluate needs real credentials' });
      const result = await enqueue(() => runJourney(journey));
      console.log(`run ${journey.id || journey.name}: ${result.ok ? 'ok' : 'failed'} in ${result.ms} ms, ${result.snapshots.length} snapshot(s)`);
      return json(res, 200, result);
    }

    // Discovery support. Neither endpoint scores anything, so both work without
    // AQA credentials: a user can discover and validate journeys in demo mode
    // and only needs real credentials to actually run them.
    if (req.method === 'POST' && req.url === '/inspect') {
      const body = await readBody(req);
      if (!body?.url) return json(res, 400, { error: 'body must be {url}' });
      const result = await enqueue(() => inspectPage({ url: body.url, viewport: body.viewport }));
      console.log(`inspect ${body.url}: ${result.links?.length ?? 0} link(s), ${result.buttons?.length ?? 0} button(s)`);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && req.url === '/dryrun') {
      const body = await readBody(req);
      const journey = body?.journey;
      if (!journey?.steps?.length) return json(res, 400, { error: 'body must be {journey} with a non-empty steps array' });
      const result = await enqueue(() => dryRunJourney(journey));
      console.log(`dryrun ${journey.name || journey.id}: ${result.ok ? 'ok' : 'failed'} in ${result.ms} ms`);
      return json(res, 200, result);
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(`${req.method} ${req.url}:`, err.message);
    return json(res, 500, { error: err.message });
  }
});

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 5e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

server.listen(PORT, HOST, () => {
  console.log('A11y Agent journey runner');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  AQA:    ${aqa.isReal ? 'REAL (' + process.env.AQA_TEAMSLUG + ')' : 'demo mode - /run will refuse'}`);
});
