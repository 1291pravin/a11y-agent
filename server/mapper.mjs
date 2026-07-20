// Selector-to-source mapper. Walks a local clone of a site's frontend repo,
// indexes tokens (class names, ids, data-testid, aria-label, component file
// basenames), and maps a grouped root cause to the most likely file:line.
// Pure fs reads only - no network, no store access.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';

const SOURCE_EXTS = new Set(['.vue', '.jsx', '.tsx', '.js', '.ts', '.html', '.liquid', '.svelte']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const MAX_FILES = 2000;

// Build a token index for a repo. Returns maps of token -> [{file, line}]
// (file relative to repoPath) split by token kind so lookups can be ranked.
export function buildIndex(repoPath) {
  const index = {
    testid: new Map(),
    id: new Map(),
    aria: new Map(),
    class: new Map(),
    component: new Map(),
    files: 0,
  };
  if (!repoPath || !existsSync(repoPath)) return index;

  for (const file of walk(repoPath)) {
    index.files += 1;
    const rel = relative(repoPath, file).replaceAll('\\', '/');
    addHit(index.component, basename(file, extname(file)), rel, 1);

    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      indexLine(index, lines[i], rel, i + 1);
    }
  }
  return index;
}

function indexLine(index, line, file, lineNo) {
  let m;
  const classRe = /\bclass(?:Name)?\s*=\s*["']([^"']+)["']/g;
  while ((m = classRe.exec(line))) {
    for (const cls of m[1].split(/\s+/)) {
      if (cls) addHit(index.class, cls, file, lineNo);
    }
  }
  const idRe = /\bid\s*=\s*["']([^"'\s]+)["']/g;
  while ((m = idRe.exec(line))) addHit(index.id, m[1], file, lineNo);

  const testidRe = /\bdata-testid\s*=\s*["']([^"']+)["']/g;
  while ((m = testidRe.exec(line))) addHit(index.testid, m[1], file, lineNo);

  const ariaRe = /\baria-label\s*=\s*["']([^"']+)["']/g;
  while ((m = ariaRe.exec(line))) addHit(index.aria, m[1], file, lineNo);
}

function addHit(map, token, file, line) {
  if (!map.has(token)) map.set(token, []);
  map.get(token).push({ file, line });
}

function* walk(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTS.has(extname(entry.name))) continue;
      if (++count > MAX_FILES) return;
      yield join(dir, entry.name);
    }
  }
}

// Map a cause to its best source location. Candidate tokens come from the
// cause's selectors/evidence (CSS fragments: .class, #id, [data-testid="x"],
// [aria-label="x"]; bare tag names are ignored). Preference order:
// data-testid > id > aria-label > class; ties go to the token with fewer
// total occurrences (a more specific file). Returns "file:line" or null.
export function mapCause(cause, index) {
  const source = [cause?.evidence, ...(cause?.selectors || [])].filter(Boolean).join(' ');
  const tokens = extractTokens(source);

  for (const kind of ['testid', 'id', 'aria', 'class']) {
    let best = null;
    for (const token of tokens[kind]) {
      const hits = index[kind].get(token);
      if (hits?.length && (!best || hits.length < best.length)) best = hits;
    }
    if (best) return `${best[0].file}:${best[0].line}`;
  }

  // Last resort: a BEM-ish class like product-card__img often matches a
  // component file named ProductCard.vue.
  for (const token of tokens.class) {
    const base = normalizeName(token.replace(/(__|--).*$/, ''));
    for (const [name, hits] of index.component) {
      if (normalizeName(name) === base) return `${hits[0].file}:${hits[0].line}`;
    }
  }
  return null;
}

function extractTokens(text) {
  const tokens = { testid: new Set(), id: new Set(), aria: new Set(), class: new Set() };
  let m;
  const attrRe = /\[(data-testid|aria-label)\s*=\s*["']?([^"'\]]+)["']?\]/g;
  while ((m = attrRe.exec(text))) {
    tokens[m[1] === 'data-testid' ? 'testid' : 'aria'].add(m[2]);
  }
  const bare = text.replace(attrRe, ' ');
  const classRe = /\.(-?[A-Za-z_][\w-]*)/g;
  while ((m = classRe.exec(bare))) tokens.class.add(m[1]);
  const idRe = /#(-?[A-Za-z_][\w-]*)/g;
  while ((m = idRe.exec(bare))) tokens.id.add(m[1]);
  return tokens;
}

function normalizeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
