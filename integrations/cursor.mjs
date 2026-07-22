// Cursor Cloud Agents API client (v1).
// Real mode when CURSOR_API_KEY is set; otherwise callers use the demo simulator
// in server/orchestrator.mjs.

// CURSOR_BASE override lets tests point the client at a local mock server.
const BASE = process.env.CURSOR_BASE || 'https://api.cursor.com/v1';
const apiKey = process.env.CURSOR_API_KEY;

// Always dispatch fix tasks on Composer 2.5 (see GET /v1/models).
export const MODEL_ID = 'composer-2.5';

export const isReal = Boolean(apiKey);

// Verify the API key against Cursor. Returns { ok, ...profile } or throws.
export async function verifyApiKey() {
  assertReal();
  return req('GET', '/me');
}

// Launch one cloud agent for one root cause. Returns { id, runId, status }.
export async function launchAgent({ repo, ref = 'main', prompt }) {
  assertReal();
  const res = await req('POST', '/agents', {
    prompt: { text: prompt },
    model: { id: MODEL_ID },
    repos: [{ url: `https://github.com/${repo}`, startingRef: ref }],
    autoCreatePR: true,
  });
  return {
    id: res.agent.id,
    runId: res.run?.id || res.agent.latestRunId,
    status: res.run?.status || res.agent.status,
  };
}

export async function getAgent(id) {
  assertReal();
  const agent = await req('GET', `/agents/${id}`);
  if (!agent.latestRunId) return { ...agent, run: null };
  const run = await getRun(id, agent.latestRunId);
  return { ...agent, run };
}

export async function getRun(agentId, runId) {
  assertReal();
  return req('GET', `/agents/${agentId}/runs/${runId}`);
}

// Build the fix prompt from a triaged root cause. Kept here so the prompt contract
// lives next to the API client. One task per root cause, evidence included.
export function buildFixPrompt(cause, site) {
  return [
    `Fix an accessibility violation in this repository.`,
    ``,
    `Rule: ${cause.rule} (${cause.ruleId})`,
    `Root cause: ${cause.title}`,
    `Instances: ${cause.instances} across pages: ${cause.pages.join(', ')}`,
    `Likely source location: ${cause.mappedFile}`,
    `DOM evidence: ${cause.evidence}`,
    `Live site: ${site.url}`,
    ``,
    `Requirements:`,
    `- Fix the root cause at the mapped location; do not patch page-by-page.`,
    `- Keep the change minimal and consistent with surrounding code style.`,
    `- Run existing tests if present.`,
    `- Open a PR titled "fix(a11y): <short description>" and include the rule,`,
    `  instance count, and affected pages in the PR description.`,
  ].join('\n');
}

function assertReal() {
  if (!isReal) {
    const e = new Error('CURSOR_API_KEY not set - demo mode');
    e.code = 'DEMO_MODE';
    throw e;
  }
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const e = new Error(`Cursor ${method} ${path} -> HTTP ${res.status}`);
    e.status = res.status;
    e.body = parsed;
    throw e;
  }
  return parsed;
}

function safeJson(t) { try { return JSON.parse(t); } catch { return t; } }

// Network blips and upstream 5xx/429 are worth retrying; 4xx auth/validation are not.
export function isTransientError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout')
    || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('enotfound')
    || msg.includes('socket hang up')) return true;
  const code = err.cause?.code || err.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) return true;
  const status = err.status;
  return status === 429 || status === 502 || status === 503 || status === 504;
}
