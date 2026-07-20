// JSON file state store. Loads data/state.json if present, otherwise seeds demo data.
// Real fleet data is hydrated from AQA on startup (see bootstrap.mjs + index.mjs).

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapFromAqa, demoSeed, hasFleetConfig } from './bootstrap.mjs';
import * as aqa from '../integrations/aqa.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// STATE_FILE override keeps parallel test runs from sharing data/state.json.
const STATE_PATH = process.env.STATE_FILE
  ? resolve(process.env.STATE_FILE)
  : resolve(__dirname, '..', 'data', 'state.json');

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
        mkdirSync(dirname(STATE_PATH), { recursive: true });
        writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      } catch (err) {
        console.error('store: save failed:', err.message);
      }
    }, 200);
  }
}

export function usesRealFleet() {
  return aqa.isReal && hasFleetConfig() && process.env.USE_DEMO_DATA !== '1';
}

export async function bootstrapFleet({ clearFile = false } = {}) {
  if (!usesRealFleet()) {
    state = seedDemo();
    if (clearFile && existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
    scheduleSave();
    return state;
  }
  state = await bootstrapFromAqa();
  if (clearFile && existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
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
  if (existsSync(STATE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      if (usesRealFleet() && isLegacyDemoState(parsed)) return seedDemo();
      return parsed;
    } catch (err) {
      console.error('store: corrupt state.json, reseeding:', err.message);
    }
  }
  return seedDemo();
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
