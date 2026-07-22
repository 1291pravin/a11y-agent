// Optional LLM client for triage (zero runtime deps — global fetch only).
// Used when OPENAI_API_KEY or ANTHROPIC_API_KEY is set and TRIAGE_LLM=1.

const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

export function llmConfigured() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

export async function chatJson({ system, user }) {
  if (process.env.OPENAI_API_KEY) return openaiChat({ system, user });
  if (process.env.ANTHROPIC_API_KEY) return anthropicChat({ system, user });
  return null;
}

async function openaiChat({ system, user }) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`OpenAI chat -> HTTP ${res.status}`);
    e.body = parsed;
    throw e;
  }
  const text = parsed.choices?.[0]?.message?.content;
  return text ? JSON.parse(text) : null;
}

async function anthropicChat({ system, user }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      temperature: 0.1,
      system: `${system}\n\nRespond with valid JSON only.`,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Anthropic chat -> HTTP ${res.status}`);
    e.body = parsed;
    throw e;
  }
  const text = parsed.content?.find((b) => b.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}
