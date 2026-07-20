// M1 pipeline tests: mock AQA server + real-mode app. Bootstrap hydrates from
// run-1; POST scan triggers run-2 on the mock, the app polls it to "finished",
// re-hydrates, preserves matched cause ids, and computes lastDiff.
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const PORT = 4518;
const BASE = `http://localhost:${PORT}`;
const STATE_FILE = join(tmpdir(), `a11y-agent-m1-state-${process.pid}.json`);
let proc;
let mock;

// ── Mock AQA ────────────────────────────────────────────────────────────────
// run-1 = bootstrap baseline (image-alt x2, frame-title x1)
// run-2 = after rescan (frame-title x1 persists, image-alt fixed, link-name new)

function mkIssue(ruleId, needFixTitle, selector, tagName, properties) {
  return {
    ruleId, ruleTitle: needFixTitle, ruleShortTitle: ruleId.toUpperCase(),
    needFixTitle, selectors: [selector], tagName, properties, solutionId: `sol-${ruleId}`,
  };
}

const RUN_ISSUES = {
  'run-1': [
    mkIssue('image-alt', 'Add missing alt text', 'img.hero', 'img', ['high']),
    mkIssue('image-alt', 'Add missing alt text', 'img.hero', 'img', ['high']),
    mkIssue('frame-title', 'Give the vendor iframe a title', 'iframe.chat', 'iframe', ['medium']),
  ],
  'run-2': [
    mkIssue('frame-title', 'Give the vendor iframe a title', 'iframe.chat', 'iframe', ['medium']),
    mkIssue('link-name', 'Name the icon-only cart link', 'a.cart', 'a', ['high']),
  ],
};

let runs = [{ id: 'run-1', time: Date.now() - 3_600_000 }];
let run2Polls = 0;

function mockHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const send = (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  let m;

  if (req.method === 'GET' && p.startsWith('/mock/a11y/suites/')) {
    return send({
      id: 'TS1', name: 'M1 Suite',
      flows: [{ id: 'f1', name: 'Home', type: 'functional', url: 'https://m1.example.com' }],
    });
  }
  if (req.method === 'POST' && p === '/mock/a11y/tests/T1/run') {
    if (!runs.some((r) => r.id === 'run-2')) runs = [{ id: 'run-2', time: Date.now() }, ...runs];
    return send({ runId: 'run-2', status: 'queued' });
  }
  if (req.method === 'GET' && p === '/mock/a11y/tests/T1') {
    return send({ runs, definition: { id: 'T1' }, suite: { id: 'TS1' } });
  }
  if (req.method === 'GET' && (m = p.match(/^\/mock\/a11y\/tests\/runs\/([\w-]+)\/flows\/([\w-]+)\/issues$/))) {
    return send({ issues: RUN_ISSUES[m[1]] || [] });
  }
  if (req.method === 'GET' && (m = p.match(/^\/mock\/a11y\/tests\/runs\/([\w-]+)\/flows$/))) {
    const isFirst = m[1] === 'run-1';
    return send({
      flows: [{
        id: 'f1', name: 'Home', numSteps: 1,
        review: {
          issues: { severity: {
            low: { numIssues: 0 },
            medium: { numIssues: 1 },
            high: { numIssues: isFirst ? 2 : 1 },
          } },
          a11yScore: { delta: isFirst ? 0 : -1 },
        },
      }],
    });
  }
  if (req.method === 'GET' && (m = p.match(/^\/mock\/a11y\/tests\/runs\/([\w-]+)$/))) {
    // First two polls report "running" to exercise the poll loop.
    const status = m[1] === 'run-2' && run2Polls++ < 2 ? 'running' : 'finished';
    return send({ id: m[1], status });
  }
  send({ error: `mock has no route for ${req.method} ${p}` }, 404);
}

// ── Boot ────────────────────────────────────────────────────────────────────

before(async () => {
  mock = createServer(mockHandler);
  await new Promise((r) => mock.listen(0, r));
  const mockPort = mock.address().port;

  proc = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AQA_TEAMSLUG: 'mock',
      AQA_API_KEY: 'mock',
      AQA_BASE: `http://localhost:${mockPort}`,
      AQA_POLL_MS: '100',
      CURSOR_API_KEY: '',
      STATE_FILE,
      FLEET_SITES: JSON.stringify([{
        id: 'm1-site', url: 'https://m1.example.com', repo: 'acme/m1',
        suiteId: 'TS1', testId: 'T1', framework: 'test',
      }]),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/health`); return; } catch { await delay(200); }
  }
  throw new Error('server did not start');
});

after(() => {
  proc?.kill();
  mock?.close();
  try { unlinkSync(STATE_FILE); } catch {}
});

async function getSiteState() {
  const s = await (await fetch(`${BASE}/api/state`)).json();
  return { site: s.sites.find((x) => x.id === 'm1-site'), causes: s.causes.filter((c) => c.siteId === 'm1-site') };
}

let baselineFrameTitleId;

test('real mode bootstraps the fleet from the mock AQA account', async () => {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(health.mode.aqa, 'real');

  const { site, causes } = await getSiteState();
  assert.ok(site, 'FLEET_SITES site should be hydrated');
  assert.equal(site.testId, 'T1');
  assert.equal(site.total, 3);
  assert.equal(site.critical, 2);

  assert.equal(causes.length, 2);
  const imageAlt = causes.find((c) => c.ruleId === 'image-alt');
  const frameTitle = causes.find((c) => c.ruleId === 'frame-title');
  assert.equal(imageAlt?.instances, 2);
  assert.equal(frameTitle?.instances, 1);
  baselineFrameTitleId = frameTitle.id;
});

test('scan rejects a site without a testId', async () => {
  const create = await fetch(`${BASE}/api/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://no-test.example.com', repo: 'acme/no-test', suiteId: 'TS9' }),
  });
  const site = await create.json();
  const res = await fetch(`${BASE}/api/sites/${site.id}/scan`, { method: 'POST' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /testId/);
});

test('scan returns 202, polls the run, re-hydrates and diffs', async () => {
  const res = await fetch(`${BASE}/api/sites/m1-site/scan`, { method: 'POST' });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'real');

  // A second scan while the first is in flight is refused.
  const dup = await fetch(`${BASE}/api/sites/m1-site/scan`, { method: 'POST' });
  assert.equal(dup.status, 409);

  // Poll loop runs at AQA_POLL_MS=100; the whole pipeline finishes in <2s.
  let site, causes;
  for (let i = 0; i < 100; i++) {
    await delay(100);
    ({ site, causes } = await getSiteState());
    if (site?.lastDiff) break;
  }

  assert.ok(site.lastDiff, 'scan should record lastDiff');
  assert.ok(!site.scanState, 'scanState should clear when the scan completes');
  assert.equal(site.total, 2);
  assert.equal(site.critical, 1);

  // Diff: image-alt fixed, link-name new, frame-title persisting.
  assert.deepEqual(site.lastDiff.new.map((d) => d.ruleId), ['link-name']);
  assert.deepEqual(site.lastDiff.fixed.map((d) => d.ruleId), ['image-alt']);
  assert.deepEqual(site.lastDiff.persisting.map((d) => d.ruleId), ['frame-title']);
  assert.equal(site.lastDiff.fixed[0].instances, 2);
  assert.ok(site.lastDiff.at > 0);

  // Causes re-grouped from run-2; the persisting cause keeps its id and status.
  assert.equal(causes.length, 2);
  assert.ok(!causes.some((c) => c.ruleId === 'image-alt'));
  const frameTitle = causes.find((c) => c.ruleId === 'frame-title');
  assert.equal(frameTitle.id, baselineFrameTitleId);
  assert.equal(frameTitle.status, 'open');
  assert.ok(causes.some((c) => c.ruleId === 'link-name'));
});
