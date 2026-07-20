// A11y Agent control plane. Zero-dep HTTP server: static webapp + JSON API.
// Usage: node server/index.mjs   (PORT env, default 4173)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle as handleApi } from './routes.mjs';
import * as aqa from '../integrations/aqa.mjs';
import * as cursor from '../integrations/cursor.mjs';
import { bootstrapFleet, usesRealFleet, getState } from './store.mjs';
import { hasFleetConfig } from './bootstrap.mjs';
import { resumePolling } from './orchestrator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
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

  server.listen(PORT, () => {
    console.log(`A11y Agent control plane`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  AQA:    ${aqa.isReal ? 'REAL (' + process.env.AQA_TEAMSLUG + ')' : 'demo mode'}`);
    console.log(`  Cursor: ${cursor.isReal ? 'REAL' : 'demo mode'}`);
    resumePolling();
  });
}

start();
