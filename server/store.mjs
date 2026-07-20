// State store. The in-memory state object is the single source of truth for
// every consumer; only the persistence layer is pluggable (M5):
//   - SQLite (node:sqlite, Node 22.5+) when available - single-row table
//     holding the JSON blob, written on the same debounced save.
//   - JSON file (data/state.json) otherwise, and always when STATE_FILE or
//     STORE_BACKEND=json is set (tests pin the JSON backend via STATE_FILE).
// If state.json exists and the DB is empty, it is imported once and renamed
// to state.json.migrated. Real fleet data is hydrated from AQA on startup
// (see bootstrap.mjs + index.mjs).

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapFromAqa, demoSeed, hasFleetConfig } from './bootstrap.mjs';
import * as aqa from '../integrations/aqa.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// STATE_FILE override keeps parallel test runs from sharing data/state.json.
const STATE_PATH = process.env.STATE_FILE
  ? resolve(process.env.STATE_FILE)
  : resolve(__dirname, '..', 'data', 'state.json');
const DB_PATH = process.env.STATE_DB
  ? resolve(process.env.STATE_DB)
  : resolve(__dirname, '..', 'data', 'state.db');

// node:sqlite only exists on Node 22.5+; on Node 20 the import throws and we
// fall back to the JSON file. STATE_FILE forces JSON so tests stay
// deterministic regardless of the Node version they run on.
let db = null;
if (!process.env.STATE_FILE && process.env.STORE_BACKEND !== 'json') {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)');
  } catch {
    db = null;
  }
}

export const backend = db ? 'sqlite' : 'json';
console.log(db ? `store: sqlite backend (${DB_PATH})` : `store: json backend (${STATE_PATH})`);

let state = load();
let saveTimer = null;

export function getState() { return state; }

export function setState(next) {
  state = next;
  scheduleSave();
}

export function update(fn) {
  fn(state);
  scheduleSave();
}

function scheduleSave() {
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        persist(state);
      } catch (err) {
        console.error('store: save failed:', err.message);
      }
    }, 200);
  }
}

function persist(s) {
  if (db) {
    db.prepare('INSERT INTO state (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json')
      .run(JSON.stringify(s));
    return;
  }
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function clearPersisted() {
  if (db) {
    try { db.exec('DELETE FROM state'); } catch {}
    return;
  }
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
}

export function usesRealFleet() {
  return aqa.isReal && hasFleetConfig() && process.env.USE_DEMO_DATA !== '1';
}

export async function bootstrapFleet({ clearFile = false } = {}) {
  if (!usesRealFleet()) {
    state = seedDemo();
    if (clearFile) clearPersisted();
    scheduleSave();
    return state;
  }
  state = await bootstrapFromAqa();
  if (clearFile) clearPersisted();
  scheduleSave();
  return state;
}

export async function resetToSeed() {
  return bootstrapFleet({ clearFile: true });
}

export function nextId(prefix) {
  state.counter = (state.counter || 1000) + 1;
  return `${prefix}${state.counter}`;
}

function load() {
  if (db) {
    const row = db.prepare('SELECT json FROM state WHERE id = 1').get();
    if (row?.json) {
      const parsed = parseState(row.json, 'state.db');
      if (parsed) return parsed;
      return seedDemo();
    }
    // One-time migration: DB is empty but a JSON store exists from before.
    if (existsSync(STATE_PATH)) {
      const imported = parseState(readFileSync(STATE_PATH, 'utf8'), 'state.json');
      if (imported) {
        persist(imported);
        try { renameSync(STATE_PATH, `${STATE_PATH}.migrated`); } catch {}
        console.log('store: imported state.json into sqlite (renamed to state.json.migrated)');
        return imported;
      }
    }
    return seedDemo();
  }
  if (existsSync(STATE_PATH)) {
    const parsed = parseState(readFileSync(STATE_PATH, 'utf8'), 'state.json');
    if (parsed) return parsed;
  }
  return seedDemo();
}

function parseState(text, from) {
  try {
    const parsed = JSON.parse(text);
    if (usesRealFleet() && isLegacyDemoState(parsed)) return null;
    return parsed;
  } catch (err) {
    console.error(`store: corrupt ${from}, reseeding:`, err.message);
    return null;
  }
}

function isLegacyDemoState(s) {
  const ids = new Set((s.sites || []).map((x) => x.id));
  return ids.has('site-filorga') || ids.has('site-brandx') || ids.has('site-contoso');
}

function seedDemo() {
  if (usesRealFleet()) {
    // Placeholder until async bootstrap completes on startup.
    return {
      counter: 1000,
      settings: demoSeed().settings,
      sites: [],
      causes: [],
      tasks: [],
      prs: [],
      activity: [{ ts: Date.now(), msg: 'Loading fleet from AQA…' }],
    };
  }
  return demoSeed();
}
