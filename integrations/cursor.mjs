// Cursor Background Agents API client.
// Real mode when CURSOR_API_KEY is set; otherwise callers use the demo simulator
// in server/orchestrator.mjs.
//
// NOTE (M2): endpoint shapes are best-effort from Cursor's public Background Agents
// API (api.cursor.com, v0). Validate against the office Cursor org before relying
// on them - the API is young and may have changed.

const BASE = 'https://api.cursor.com/v0';
const apiKey = process.env.CURSOR_API_KEY;

export const isReal = Boolean(apiKey);

// Launch one background agent for one root cause. Returns { id, status }.
export async function launchAgent({ repo, ref = 'main', prompt }) {
  assertReal();
  return req('POST', '/agents', {
    prompt: { text: prompt },
    source: { repository: `https://github.com/${repo}`, ref },
    target: { autoCreatePr: true },
  });
}

export async function getAgent(id) { assertReal(); return req('GET', `/agents/${id}`); }

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
