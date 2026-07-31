// Cursor Agent CLI client — local fallback when Cloud Agents are unavailable.
// Spawns `agent -p ...` in the background, streams stdout/stderr under
// data/cursor-cli/<runId>/, and exposes getRun() for the orchestrator poll loop.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { MODEL_ID as CLOUD_MODEL } from './cursor.mjs';

export const MODEL_ID = process.env.CURSOR_CLI_MODEL || CLOUD_MODEL || 'composer-2.5';

const RUNS = new Map(); // runId -> { child, status, exitCode, outPath, errPath, outOffset, prUrl, startedAt }

function runsDir() {
  return resolve(process.env.CURSOR_CLI_DIR || join(process.cwd(), 'data', 'cursor-cli'));
}

// Resolve the agent binary once. Prefer CURSOR_CLI_BIN, then PATH, then ~/.local/bin.
export function resolveBin() {
  if (process.env.CURSOR_CLI_BIN) return process.env.CURSOR_CLI_BIN;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['agent'], {
    encoding: 'utf8',
    env: process.env,
  });
  const fromPath = which.status === 0 && which.stdout.trim().split(/\r?\n/)[0];
  if (fromPath) return fromPath;
  const local = join(homedir(), '.local', 'bin', 'agent');
  if (existsSync(local)) return local;
  return null;
}

export function isAvailable() {
  return Boolean(resolveBin());
}

// Launch a local CLI agent against site.repoPath. Returns { id, runId, status }.
export async function launchAgent({ workspace, prompt, taskId }) {
  const bin = resolveBin();
  if (!bin) {
    const e = new Error('Cursor CLI agent binary not found (set CURSOR_CLI_BIN or install via curl https://cursor.com/install)');
    e.code = 'CLI_MISSING';
    throw e;
  }
  if (!workspace || !existsSync(workspace)) {
    const e = new Error(`Cursor CLI needs a local repoPath that exists (got: ${workspace || 'unset'})`);
    e.code = 'CLI_NO_WORKSPACE';
    throw e;
  }

  const id = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(runsDir(), id);
  mkdirSync(dir, { recursive: true });
  const promptPath = join(dir, 'prompt.txt');
  const outPath = join(dir, 'stdout.log');
  const errPath = join(dir, 'stderr.log');
  const metaPath = join(dir, 'meta.json');
  writeFileSync(promptPath, prompt, 'utf8');

  const args = [
    '-p',
    '--force',
    '--trust',
    '--model', MODEL_ID,
    '--workspace', resolve(workspace),
    '--output-format', 'text',
    prompt,
  ];

  const env = { ...process.env };
  // Prefer an explicit key; otherwise the CLI may already be logged in via `agent login`.
  if (process.env.CURSOR_API_KEY) env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;

  const out = createWriteStream(outPath, { flags: 'a' });
  const err = createWriteStream(errPath, { flags: 'a' });
  const waitOpen = (stream) => new Promise((resolveOpen, reject) => {
    if (stream.fd != null) return resolveOpen();
    stream.once('open', resolveOpen);
    stream.once('error', reject);
  });
  await Promise.all([waitOpen(out), waitOpen(err)]);

  const child = spawn(bin, args, {
    cwd: resolve(workspace),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  child.stdout.pipe(out);
  child.stderr.pipe(err);

  const meta = {
    id,
    taskId: taskId || null,
    pid: child.pid,
    bin,
    model: MODEL_ID,
    workspace: resolve(workspace),
    startedAt: Date.now(),
    status: 'RUNNING',
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  const run = {
    id,
    child,
    status: 'RUNNING',
    exitCode: null,
    outPath,
    errPath,
    metaPath,
    outOffset: 0,
    prUrl: null,
    startedAt: meta.startedAt,
    outputTail: '',
  };
  RUNS.set(id, run);

  child.on('error', (errObj) => {
    run.status = 'ERROR';
    run.exitCode = -1;
    run.lastError = errObj.message;
    try { out.end(); err.end(); } catch {}
    persistMeta(run);
  });

  child.on('close', (code, signal) => {
    run.exitCode = code;
    run.signal = signal || null;
    // Drain a moment for pipe flush, then finalize status from logs.
    setTimeout(() => finalize(run), 50);
    try { out.end(); err.end(); } catch {}
  });

  return { id, runId: id, status: 'RUNNING', pid: child.pid };
}

export function getRun(runId) {
  const run = RUNS.get(runId) || hydrateFromDisk(runId);
  if (!run) {
    const e = new Error(`Cursor CLI run ${runId} not found`);
    e.status = 404;
    throw e;
  }

  const chunk = readNew(run);
  if (chunk) {
    run.outputTail = (run.outputTail + chunk).slice(-8000);
    const found = extractPrUrl(run.outputTail);
    if (found) run.prUrl = found;
  }

  // Process still alive → RUNNING.
  if (run.child && !run.child.killed && run.exitCode === null && run.status === 'RUNNING') {
    return shape(run);
  }
  if (run.status === 'RUNNING' && run.exitCode === null && run.pid && processAlive(run.pid)) {
    return shape(run);
  }

  if (run.status === 'RUNNING') finalize(run);
  return shape(run);
}

// Kill an in-flight CLI run (best-effort). Used on task failure / restart cleanup.
export function cancelRun(runId) {
  const run = RUNS.get(runId);
  if (!run?.child || run.exitCode !== null) return false;
  try {
    run.child.kill('SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function finalize(run) {
  if (run.status !== 'RUNNING' && run.status !== 'ERROR') return;
  const out = safeRead(run.outPath) + '\n' + safeRead(run.errPath);
  run.outputTail = out.slice(-8000);
  run.prUrl = extractPrUrl(out) || run.prUrl;
  if (run.status === 'ERROR') {
    persistMeta(run);
    return;
  }
  if (run.exitCode === 0) run.status = 'FINISHED';
  else run.status = 'ERROR';
  persistMeta(run);
}

function shape(run) {
  return {
    id: run.id,
    status: run.status,
    exitCode: run.exitCode,
    output: run.outputTail || '',
    git: run.prUrl ? { branches: [{ prUrl: run.prUrl }] } : { branches: [] },
  };
}

function persistMeta(run) {
  try {
    const prev = existsSync(run.metaPath) ? JSON.parse(readFileSync(run.metaPath, 'utf8')) : {};
    writeFileSync(run.metaPath, JSON.stringify({
      ...prev,
      status: run.status,
      exitCode: run.exitCode,
      prUrl: run.prUrl,
      endedAt: Date.now(),
      lastError: run.lastError || null,
    }, null, 2));
  } catch {}
}

function hydrateFromDisk(runId) {
  const dir = join(runsDir(), runId);
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const run = {
      id: runId,
      child: null,
      pid: meta.pid,
      status: meta.status || 'RUNNING',
      exitCode: meta.exitCode ?? null,
      outPath: join(dir, 'stdout.log'),
      errPath: join(dir, 'stderr.log'),
      metaPath,
      outOffset: 0,
      prUrl: meta.prUrl || null,
      startedAt: meta.startedAt || Date.now(),
      outputTail: '',
      lastError: meta.lastError || null,
    };
    // If meta still says RUNNING but the pid is gone, treat as ERROR (orphaned by restart).
    if (run.status === 'RUNNING' && run.pid && !processAlive(run.pid)) {
      run.status = 'ERROR';
      run.exitCode = run.exitCode ?? -1;
      run.lastError = run.lastError || 'orphaned by restart';
    }
    RUNS.set(runId, run);
    return run;
  } catch {
    return null;
  }
}

function readNew(run) {
  try {
    if (!existsSync(run.outPath)) return '';
    const size = statSync(run.outPath).size;
    if (size <= run.outOffset) return '';
    const fd = openSync(run.outPath, 'r');
    try {
      const len = size - run.outOffset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, run.outOffset);
      run.outOffset = size;
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function safeRead(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : ''; } catch { return ''; }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Pull the first GitHub PR URL out of agent output (plain or markdown).
export function extractPrUrl(text) {
  if (!text) return null;
  const md = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  return md ? md[0].replace(/[).,;]+$/, '') : null;
}
