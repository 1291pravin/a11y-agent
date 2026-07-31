// M3 tests: selector normalization, selector-to-source mapper (against a tiny
// fixture repo on disk), and the fix-report.md export for unmapped causes.
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeSelector } from '../server/aqa-sync.mjs';
import { buildIndex, mapCause } from '../server/mapper.mjs';

// ── normalizeSelector (pure) ────────────────────────────────────────────────

test('normalizeSelector strips positional pseudo-classes', () => {
  assert.equal(normalizeSelector('ul > li:nth-child(3) > a'), 'ul > li > a');
  assert.equal(normalizeSelector('div.card:nth-of-type(2)'), 'div.card');
  assert.equal(normalizeSelector('li:nth-child(2n+1) span'), 'li span');
});

test('normalizeSelector strips trailing "> *" chains and collapses whitespace', () => {
  assert.equal(normalizeSelector('.grid > *'), '.grid');
  assert.equal(normalizeSelector('div > * > *'), 'div');
  assert.equal(normalizeSelector('  main   .content  a '), 'main .content a');
});

test('normalizeSelector groups the same component across pages into one key', () => {
  const a = normalizeSelector('ul.nav > li:nth-child(1) > a.link');
  const b = normalizeSelector('ul.nav > li:nth-child(7) > a.link');
  assert.equal(a, b);
});

test('normalizeSelector falls back to "unknown" for empty input', () => {
  assert.equal(normalizeSelector(''), 'unknown');
  assert.equal(normalizeSelector(null), 'unknown');
  assert.equal(normalizeSelector(' > * '), 'unknown');
});

// ── mapper (fixture repo on disk) ───────────────────────────────────────────

let repo;
let index;

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'a11y-agent-m3-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'lib'), { recursive: true });

  writeFileSync(join(repo, 'src', 'ProductCard.vue'), [
    '<template>',
    '  <div class="product-card" data-testid="product-card">',
    '    <img class="product-card__img" :src="src">',
    '  </div>',
    '</template>',
  ].join('\n'));

  writeFileSync(join(repo, 'src', 'CartBadge.tsx'), [
    'export function CartBadge({ count }) {',
    '  return <span id="cart-count" className="cart-badge">{count}</span>;',
    '}',
  ].join('\n'));

  // Duplicate "cart-badge" occurrences make it less specific than "promo-banner".
  writeFileSync(join(repo, 'src', 'legacy.html'), [
    '<div class="cart-badge promo-banner" aria-label="Promotions"></div>',
    '<div class="cart-badge"></div>',
  ].join('\n'));

  // Must be skipped by the walker.
  writeFileSync(join(repo, 'node_modules', 'lib', 'vendor.js'),
    'const x = \'<i class="vendored-class" id="vendored-id"></i>\';\n');

  index = buildIndex(repo);
});

after(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
});

test('buildIndex records class/id/testid/aria occurrences with file:line', () => {
  assert.deepEqual(index.class.get('product-card__img'), [{ file: 'src/ProductCard.vue', line: 3 }]);
  assert.deepEqual(index.testid.get('product-card'), [{ file: 'src/ProductCard.vue', line: 2 }]);
  assert.deepEqual(index.id.get('cart-count'), [{ file: 'src/CartBadge.tsx', line: 2 }]);
  assert.deepEqual(index.aria.get('Promotions'), [{ file: 'src/legacy.html', line: 1 }]);
  assert.equal(index.class.get('cart-badge').length, 3);
  assert.ok(index.component.has('ProductCard'));
});

test('buildIndex skips node_modules', () => {
  assert.equal(index.class.get('vendored-class'), undefined);
  assert.equal(index.id.get('vendored-id'), undefined);
});

test('mapCause prefers data-testid over class', () => {
  const cause = { evidence: '<img img.product-card__img[data-testid="product-card"]> - Add alt text' };
  assert.equal(mapCause(cause, index), 'src/ProductCard.vue:2');
});

test('mapCause prefers id over class', () => {
  const cause = { evidence: '<a a#cart-count.cart-badge> - Name the link' };
  assert.equal(mapCause(cause, index), 'src/CartBadge.tsx:2');
});

test('mapCause falls back to class and picks the rarer token on ties', () => {
  const one = { evidence: '<img img.product-card__img> - Add alt text' };
  assert.equal(mapCause(one, index), 'src/ProductCard.vue:3');
  // cart-badge occurs 3 times, promo-banner once: the rarer token wins.
  const tie = { evidence: '<div div.cart-badge.promo-banner> - Contrast' };
  assert.equal(mapCause(tie, index), 'src/legacy.html:1');
});

test('mapCause reads selector arrays too and returns null when nothing matches', () => {
  const fromSelectors = { evidence: '', selectors: ['div.product-card > img'] };
  assert.equal(mapCause(fromSelectors, index), 'src/ProductCard.vue:2');
  const miss = { evidence: '<iframe iframe.some-vendor-chat> - Title the frame' };
  assert.equal(mapCause(miss, index), null);
});

// ── fix-report export (demo-mode server) ────────────────────────────────────

const PORT = 4523;
const BASE = `http://localhost:${PORT}`;
const STATE_FILE = join(tmpdir(), `a11y-agent-m3-state-${process.pid}.json`);
let proc;

before(async () => {
  proc = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AQA_TEAMSLUG: '', AQA_API_KEY: '', CURSOR_API_KEY: '',
      STATE_FILE,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${BASE}/api/health`); return; } catch { await delay(200); }
  }
  throw new Error('server did not start');
});

after(() => {
  proc?.kill();
  try { unlinkSync(STATE_FILE); } catch {}
});

test('fix-report exports open causes as markdown', async () => {
  const res = await fetch(`${BASE}/api/sites/site-demo/fix-report`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/markdown/);
  assert.match(res.headers.get('content-disposition'), /fix-report-site-demo\.md/);
  const body = await res.text();
  assert.match(body, /Demo vendor iframe missing title/);
  assert.match(body, /frame-title/);
  assert.match(body, /Suggested action: Add a title attribute/);
  assert.match(body, /Demo images missing alt text/);
  assert.match(body, /AQA locator/);
});

test('fix-report 404s for an unknown site', async () => {
  const res = await fetch(`${BASE}/api/sites/nope/fix-report`);
  assert.equal(res.status, 404);
});
