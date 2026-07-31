// A11y Agent control plane. Zero-dep HTTP server: static webapp + JSON API.
// Usage: node server/index.mjs   (PORT env, default 4173; auto-increments if busy)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle as handleApi } from './routes.mjs';
import * as aqa from '../integrations/aqa.mjs';
import * as cursor from '../integrations/cursor.mjs';
import * as cursorCli from '../integrations/cursor-cli.mjs';
import { bootstrapFleet, usesRealFleet, getState, update } from './store.mjs';
import { hasFleetConfig } from './bootstrap.mjs';
import { resumePolling } from './orchestrator.mjs';
import { initScheduler, schedulerEnabled } from './scheduler.mjs';
import { listenAvailable } from './listen-port.mjs';
import { screenshotRoot } from './journey-propose.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..', 'web');
const SCREENSHOT_ROOT = screenshotRoot();
const PREFERRED_PORT = Number(process.env.PORT) || 4173;
const PORT_STRICT = process.env.PORT_STRICT === '1' || process.env.PORT_STRICT === 'true';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    // M7: dry-run and journey-run screenshots live under data/screenshots/
    // and are served here so the UI can drop the runner-returned URL
    // straight into an <img src>. Path is scoped to SCREENSHOT_ROOT so a
    // walk like /screenshots/../.env cannot escape.
    if (url.pathname.startsWith('/screenshots/')) return await serveScreenshot(url.pathname, res);
    return await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(`${req.method} ${url.pathname}:`, err.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

async function serveStatic(pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = normalize(join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback: unknown paths get the app shell
    const data = await readFile(join(WEB_ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(data);
  }
}

async function serveScreenshot(pathname, res) {
  const rel = pathname.replace(/^\/screenshots\//, '');
  const file = normalize(join(SCREENSHOT_ROOT, decodeURIComponent(rel)));
  if (!file.startsWith(SCREENSHOT_ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      // Cache aggressively - screenshot filenames include the step index and
      // a re-discovery wipes the directory, so a URL that still resolves
      // is always the same bytes.
      'cache-control': 'public, max-age=3600, immutable',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'screenshot not found' }));
  }
}

async function start() {
  if (usesRealFleet()) {
    try {
      const s = getState();
      if (!s.sites.length || s.activity?.[0]?.msg?.includes('Loading fleet')) {
        console.log('  Fleet:  bootstrapping from AQA…');
        await bootstrapFleet({ clearFile: true });
        console.log(`  Fleet:  ${getState().sites.length} site(s) loaded`);
      } else {
        console.log(`  Fleet:  ${s.sites.length} site(s) from state`);
      }
    } catch (err) {
      console.error('  Fleet:  bootstrap failed:', err.message);
    }
  } else if (hasFleetConfig() && !aqa.isReal) {
    console.log('  Fleet:  FLEET_SITES set but AQA creds missing — demo mode');
  }

  const port = await listenAvailable(server, { preferredPort: PREFERRED_PORT, strict: PORT_STRICT });
  if (port !== PREFERRED_PORT) {
    console.log(`  Port ${PREFERRED_PORT} in use — listening on ${port} instead`);
  }
  console.log(`A11y Agent control plane`);
  console.log(`  http://localhost:${port}`);
  console.log(`  AQA:    ${aqa.isReal ? 'REAL (' + process.env.AQA_TEAMSLUG + ')' : 'demo mode'}`);
  console.log(`  Cursor: ${cursor.isReal ? 'REAL (cloud)' : 'demo'}${cursorCli.isAvailable() ? ` · CLI ready (${process.env.CURSOR_MODE || 'auto'})` : ''}`);
  console.log(`  Auth:   ${process.env.ADMIN_TOKEN ? 'admin token required for writes' : 'open (set ADMIN_TOKEN to protect writes)'}`);
  console.log(`  Sched:  ${schedulerEnabled() ? 'weekly staggered scans enabled' : 'disabled (set SCHEDULE_ENABLED=1 with real AQA)'}`);
  initScheduler();
  if (!process.env.GITHUB_WEBHOOK_SECRET) {
    console.log('  GitHub: webhook unauthenticated (set GITHUB_WEBHOOK_SECRET to require signatures)');
    update((s) => s.activity.unshift({
      ts: Date.now(),
      msg: 'GitHub merge webhook is unauthenticated - set GITHUB_WEBHOOK_SECRET to require signed deliveries',
    }));
  }
  resumePolling();
}

start();
