// Root-cause triage: merge duplicate AQA groups and drop low-relevance noise.
// Deterministic clustering always runs; optional LLM pass when TRIAGE_LLM=1.

import { chatJson, llmConfigured } from '../integrations/llm.mjs';

const MAX_CAUSES = Math.max(5, Number(process.env.TRIAGE_MAX_CAUSES) || 15);
const LLM_MIN_BATCH = Math.max(3, Number(process.env.TRIAGE_LLM_MIN) || 4);
const SEVERITY_RANK = { critical: 3, serious: 2, minor: 1 };

export async function triageCauses(causes, { siteUrl } = {}) {
  if (!causes.length) return causes;

  let merged = deterministicTriage(causes);

  if (process.env.TRIAGE_LLM === '1' && llmConfigured() && merged.length >= LLM_MIN_BATCH) {
    try {
      merged = await llmTriage(merged, siteUrl);
    } catch (err) {
      console.error('triage: LLM pass failed, using deterministic clusters:', err.message);
    }
  }

  return merged.slice(0, MAX_CAUSES);
}

function deterministicTriage(causes) {
  const groups = new Map();

  for (const cause of causes) {
    const key = clusterKey(cause);
    if (!groups.has(key)) {
      groups.set(key, { ...cause, pages: [...(cause.pages || [])], clusterKeys: [key] });
      continue;
    }
    const g = groups.get(key);
    g.instances += cause.instances;
    g.pages = [...new Set([...g.pages, ...(cause.pages || [])])].slice(0, 8);
    g.severity = pickHigherSeverity(g.severity, cause.severity);
    if (!g.mappedFile && cause.mappedFile) g.mappedFile = cause.mappedFile;
    if (cause.evidence && cause.evidence !== g.evidence) {
      g.evidence = g.evidence ? `${g.evidence}; ${cause.evidence}` : cause.evidence;
    }
    g.clusterKeys.push(key);
  }

  return [...groups.values()]
    .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) || b.instances - a.instances);
}

async function llmTriage(causes, siteUrl) {
  const payload = causes.map((c, i) => ({
    i,
    ruleId: c.ruleId,
    rule: c.rule,
    title: c.title,
    severity: c.severity,
    instances: c.instances,
    pages: c.pages,
    mappedFile: c.mappedFile,
    evidence: String(c.evidence || '').slice(0, 200),
  }));

  const system = [
    'You triage accessibility violations for an engineering team.',
    'Merge causes that describe the same underlying fix (same WCAG rule + same component pattern).',
    'Drop causes with low relevance (vendor widgets, third-party embeds, one-off CMS content) unless severity is critical.',
    'Return JSON: { "clusters": [{ "title": string, "ruleId": string, "rule": string, "severity": "critical"|"serious"|"minor", "causeIndices": number[], "relevance": number }] }',
    'relevance is 0-1 (1 = must fix in repo). Only include clusters with relevance >= 0.4.',
    'causeIndices must reference input "i" values. Each index appears at most once.',
  ].join(' ');

  const user = JSON.stringify({ siteUrl: siteUrl || '', causes: payload });
  const result = await chatJson({ system, user });
  if (!result?.clusters?.length) return causes;

  const used = new Set();
  const out = [];

  for (const cluster of result.clusters) {
    if ((cluster.relevance ?? 1) < 0.4) continue;
    const indices = (cluster.causeIndices || []).filter((n) => Number.isInteger(n) && n >= 0 && n < causes.length);
    if (!indices.length) continue;
    if (indices.some((n) => used.has(n))) continue;
    indices.forEach((n) => used.add(n));

    const members = indices.map((n) => causes[n]);
    out.push({
      ...members[0],
      title: cluster.title || members[0].title,
      ruleId: cluster.ruleId || members[0].ruleId,
      rule: cluster.rule || members[0].rule,
      severity: cluster.severity || maxSeverity(members),
      instances: members.reduce((n, c) => n + c.instances, 0),
      pages: [...new Set(members.flatMap((c) => c.pages || []))].slice(0, 8),
      mappedFile: members.find((c) => c.mappedFile)?.mappedFile || null,
      evidence: members.map((c) => c.evidence).filter(Boolean).slice(0, 3).join('; '),
      triaged: true,
    });
  }

  // Keep any causes the model skipped so we do not silently drop violations.
  for (let i = 0; i < causes.length; i++) {
    if (!used.has(i)) out.push(causes[i]);
  }

  return out.sort(
    (a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) || b.instances - a.instances,
  );
}

export function clusterKey(cause) {
  return `${cause.ruleId}|${normalizeTitle(cause.title)}`;
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .slice(0, 80);
}

function pickHigherSeverity(a, b) {
  return (SEVERITY_RANK[a] || 0) >= (SEVERITY_RANK[b] || 0) ? a : b;
}

function maxSeverity(causes) {
  return causes.reduce((best, c) => pickHigherSeverity(best, c.severity), 'minor');
}
