#!/usr/bin/env node
// Records the product demo video and copies the artifact to demo/a11y-agent-demo.webm.
// Uses real AQA violation data with a fast simulated Cursor agent (no live agent wait).

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'demo');
const outFile = resolve(outDir, 'a11y-agent-demo.webm');
const testResults = resolve(root, 'test-results');

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function newestVideo(dir) {
  let best = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = newestVideo(full);
      if (nested) best = !best || nested.mtime > best.mtime ? nested : best;
      continue;
    }
    if (entry.name.endsWith('.webm')) {
      const mtime = statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: full, mtime };
    }
  }
  return best;
}

async function maybeSpeedUp(input, output) {
  try {
    await run('ffmpeg', [
      '-y', '-i', input,
      '-filter:v', 'setpts=0.82*PTS',
      '-an',
      output,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  rmSync(testResults, { recursive: true, force: true });
  rmSync(resolve(root, 'data', 'demo-record.db'), { force: true });
  rmSync(resolve(root, 'data', 'demo-record.db-wal'), { force: true });
  rmSync(resolve(root, 'data', 'demo-record.db-shm'), { force: true });

  console.log('Recording demo (real AQA data, fast simulated agent)…');
  await run('npx', ['playwright', 'test', '-c', 'playwright.demo.config.mjs']);

  const video = newestVideo(testResults);
  if (!video) throw new Error('No .webm recording found under test-results/');

  const rawCopy = resolve(outDir, 'a11y-agent-demo-raw.webm');
  copyFileSync(video.path, rawCopy);

  const sped = await maybeSpeedUp(rawCopy, outFile);
  if (sped) {
    console.log(`Sped up with ffmpeg -> ${outFile}`);
  } else {
    copyFileSync(rawCopy, outFile);
    console.log(`ffmpeg not available; saved raw recording -> ${outFile}`);
  }

  const sizeMb = (statSync(outFile).size / (1024 * 1024)).toFixed(1);
  console.log(`Done: ${outFile} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
