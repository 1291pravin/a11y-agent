// Journey discovery: propose the journeys for a site instead of making someone
// hand-build them.
//
// Hand-configuring step selectors is the friction that stops journeys being used
// at all, so this is the primary path and the visual builder is the fallback for
// editing what lands here.
//
// Two signals feed a proposal, and using both is what makes the selectors good:
//   - the LIVE PAGE, inspected through the runner (what actually renders), and
//   - the LOCAL REPO, when the site has a repoPath (what the markup is called in
//     source: data-testid, id, aria-label and component names, via mapper's index).
//
// An LLM turns those into journeys when one is configured; otherwise a
// deterministic heuristic pass does, so discovery still works with no API key -
// the same fallback shape triage.mjs uses. Every proposal is then dry-run in a
// real browser, so a selector the model invented is caught before it is saved
// rather than on the first scored run.

import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getState, update } from './store.mjs';
import { buildIndex } from './mapper.mjs';
import { validateJourney } from './journey-model.mjs';
import { callRunner, allJourneys, makeJourney } from './journeys.mjs';
import { chatJson, llmConfigured } from '../integrations/llm.mjs';

// Repo-relative screenshots root the runner writes into. The runner and the
// server share a filesystem on every supported deployment (both are Node
// processes on the same host), so a common absolute path is the simplest
// wire format between the two.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_ROOT = process.env.SCREENSHOT_DIR
  ? resolve(process.env.SCREENSHOT_DIR)
  : resolve(__dirname, '..', 'data', 'screenshots');

export function screenshotRoot() {
  return SCREENSHOT_ROOT;
}

// Public URL prefix for a screenshot file the runner wrote for this site.
// Kept in sync with the static handler in server/index.mjs; if you change
// one, change the other.
export function screenshotUrl(siteId, tag, basename) {
  return `/screenshots/${encodeURIComponent(siteId)}/${encodeURIComponent(tag)}/${encodeURIComponent(basename)}`;
}

const MAX_PROPOSALS = Math.max(1, Number(process.env.DISCOVER_MAX) || 6);
const INSPECT_TIMEOUT_MS = Number(process.env.DISCOVER_INSPECT_TIMEOUT_MS) || 60000;
const DRYRUN_TIMEOUT_MS = Number(process.env.DISCOVER_DRYRUN_TIMEOUT_MS) || 90000;
const DEFAULT_RULESET = process.env.AQA_RULESET_ID || 'wcag21_needfix_1';

// What the user can ask the agent to concentrate on. Free-form focus strings are
// passed through too; these are just the ones the UI offers and the heuristics
// understand.
export const FOCUS_AREAS = ['Home', 'Mega-menu', 'Add to cart', 'Search', 'Login', 'Checkout'];

const STAGES = {
  inspecting: 'Loading the page and reading its structure',
  proposing: 'Proposing journeys',
  validating: 'Validating selectors in a real browser',
};

export function findSite(siteId, state = getState()) {
  return state.sites.find((x) => x.id === siteId) || null;
}

function setDiscover(siteId, patch) {
  update((s) => {
    const site = findSite(siteId, s);
    if (site) site.discover = { ...(site.discover || {}), ...patch };
  });
}

// Fire-and-forget, mirroring startJourneyRun/startRealScan: the route returns
// 202 and the client watches site.discover through the state poll.
export function startDiscovery(siteId, { focus, intent } = {}) {
  setDiscover(siteId, {
    state: 'running', stage: 'inspecting', startedAt: Date.now(),
    error: null, proposals: [], focus: focus || [], intent: intent || '',
  });
  update((s) => {
    const site = findSite(siteId, s);
    s.activity.unshift({ ts: Date.now(), msg: `Discovering journeys for ${site?.url || siteId}` });
  });

  return discover(siteId, focus || [], intent || '').catch((err) => {
    setDiscover(siteId, { state: null, stage: null, error: err.message, finishedAt: Date.now() });
    update((s) => {
      s.activity.unshift({ ts: Date.now(), msg: `Journey discovery failed for ${findSite(siteId, s)?.url || siteId}: ${err.message}` });
    });
    return false;
  });
}

async function discover(siteId, focus, intent) {
  const site = findSite(siteId);
  if (!site) throw new Error('site not found');

  const page = await callRunner('/inspect', { url: site.url }, INSPECT_TIMEOUT_MS);

  setDiscover(siteId, { stage: 'proposing' });
  const repoHints = collectRepoHints(site.repoPath);
  const rulesetId = site.rulesetId || DEFAULT_RULESET;

  let raw = [];
  let source = 'heuristic';
  if (llmConfigured()) {
    try {
      raw = await proposeWithLlm({ site, page, focus, intent, repoHints });
      source = 'llm';
    } catch (err) {
      console.error(`discovery: LLM pass failed for ${siteId}, falling back to heuristics:`, err.message);
    }
  }
  if (!raw.length) {
    raw = proposeWithHeuristics({ page, focus, intent });
    source = 'heuristic';
  }

  // Shape each candidate through the real journey validator, so a proposal that
  // could never be saved never reaches the review screen.
  const candidates = [];
  for (const cand of raw.slice(0, MAX_PROPOSALS)) {
    const parsed = validateJourney({
      name: cand.name, rulesetId, startUrl: site.url, steps: cand.steps,
    });
    if (parsed.errors) {
      console.error(`discovery: dropped proposal "${cand.name}": ${parsed.errors.join('; ')}`);
      continue;
    }
    candidates.push({ name: parsed.journey.name, focus: cand.focus || null, source, steps: parsed.journey.steps });
  }

  setDiscover(siteId, { stage: 'validating', proposals: candidates.map((c) => ({ ...c, dryRun: null })) });

  // A re-discovery replaces the whole proposals list, so the previous batch's
  // screenshots are orphaned. Wipe the site's screenshot subtree before the
  // fresh dry-runs write into it so the review UI never shows stale
  // thumbnails and disk usage stays bounded.
  const siteShotDir = resolve(SCREENSHOT_ROOT, siteId);
  try { rmSync(siteShotDir, { recursive: true, force: true }); } catch { /* fine */ }

  // Dry-run each in a real browser. This is the step that separates a plausible
  // selector from a real one. M7: also captures a viewport screenshot after
  // every successful step so the reviewer can see what the browser sees,
  // not just the selector list.
  const proposals = [];
  for (const [idx, cand] of candidates.entries()) {
    let dryRun = null;
    const tag = `proposal-${idx}`;
    try {
      const r = await callRunner('/dryrun', {
        journey: { name: cand.name, startUrl: site.url, steps: cand.steps, viewport: site.viewport },
        screenshotDir: siteShotDir,
        screenshotTag: tag,
      }, DRYRUN_TIMEOUT_MS);
      // The runner returns a screenshot BASENAME per step. Rewrite each to
      // the public URL the static handler serves so the UI can drop it into
      // <img src> without knowing the filesystem layout.
      const steps = (r.steps || []).map((s) => s.screenshot
        ? { ...s, screenshot: screenshotUrl(siteId, tag, s.screenshot) }
        : s);
      dryRun = { ok: Boolean(r.ok), error: r.error || null, steps };
    } catch (err) {
      dryRun = { ok: false, error: err.message, steps: [] };
    }
    proposals.push({ ...cand, dryRun });
    setDiscover(siteId, { proposals: [...proposals] });
  }

  const good = proposals.filter((p) => p.dryRun?.ok).length;
  setDiscover(siteId, { state: null, stage: null, finishedAt: Date.now(), error: null, proposals });
  update((s) => {
    s.activity.unshift({
      ts: Date.now(),
      msg: `Discovered ${proposals.length} journey(s) for ${findSite(siteId, s)?.url || siteId} (${good} validated, source: ${source})`,
    });
  });
  return true;
}

// ── repo signal ─────────────────────────────────────────────────────────────

// The tokens the codebase actually uses. Handing these to the model is what
// makes it propose `[data-testid="add-to-cart"]` instead of guessing `.cart-btn`.
function collectRepoHints(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return null;
  try {
    const index = buildIndex(repoPath);
    const top = (map, n) => [...map.keys()].slice(0, n);
    return {
      files: index.files,
      testids: top(index.testid, 60),
      ids: top(index.id, 60),
      ariaLabels: top(index.aria, 40),
      components: top(index.component, 60),
    };
  } catch (err) {
    console.error('discovery: repo index failed:', err.message);
    return null;
  }
}

// ── LLM proposal ────────────────────────────────────────────────────────────

async function proposeWithLlm({ site, page, focus, intent, repoHints }) {
  const system = [
    'You design accessibility test journeys for a web page.',
    'A journey is an ordered list of steps a real browser walks, ending in at least one snapshot that captures the DOM for scoring.',
    'Step types: goto {url}, click {selector}, fill {selector,value}, hover {selector}, waitFor {selector|networkIdle|ms}, snapshot {label,context?}.',
    'Do NOT emit a leading goto for the start URL; it is added automatically.',
    'Use ONLY selectors that appear in the supplied page structure, or that are clearly implied by the repo tokens.',
    'Prefer stable hooks: id, data-testid, aria-label. Avoid nth-of-type when a named hook exists.',
    'snapshot.context scopes scoring to a subtree; set it when the journey is about one region (a menu, a drawer, a form).',
    'Mark a step optional:true when its target may legitimately be absent (cookie banners above all).',
    'If the operator supplied an "intent" prompt, treat it as the primary guide: it names the flows to prioritize and the ones to skip. Focus chips are secondary hints.',
    'Return JSON: { "journeys": [{ "name": string, "focus": string, "steps": [step] }] }',
    `Return at most ${MAX_PROPOSALS} journeys, each 1-6 steps, covering distinct user flows.`,
  ].join(' ');

  const user = JSON.stringify({
    siteUrl: site.url,
    // The free-form onboarding prompt — verbatim so the model can weigh phrases
    // like "skip the blog" or "cover the 3-step checkout" against the focus chips.
    intent: intent || '',
    focusAreas: focus?.length ? focus : FOCUS_AREAS,
    page: {
      title: page.title, nav: page.nav, buttons: page.buttons,
      links: (page.links || []).slice(0, 30), inputs: page.inputs, landmarks: page.landmarks,
    },
    repoTokens: repoHints,
  });

  const result = await chatJson({ system, user });
  const journeys = Array.isArray(result?.journeys) ? result.journeys : [];
  return journeys
    .filter((j) => j && typeof j.name === 'string' && Array.isArray(j.steps) && j.steps.length)
    .map((j) => ({ name: j.name.trim(), focus: typeof j.focus === 'string' ? j.focus : null, steps: j.steps }));
}

// ── deterministic fallback ──────────────────────────────────────────────────

// No API key, or the model failed: still propose something useful from the page
// structure alone. Covers the flows the focus chips name. When the operator
// supplied a free-form intent instead of chips, harvest known area keywords
// from the prompt so the heuristic still narrows correctly.
export function proposeWithHeuristics({ page, focus, intent }) {
  const derivedFocus = deriveFocusFromIntent(intent);
  const effective = (focus && focus.length) ? focus : derivedFocus;
  const wanted = (area) => !effective.length || effective.some((f) => String(f).toLowerCase().includes(area));
  const out = [];
  const byText = (list, re) => (list || []).find((x) => re.test(x.text || ''));

  if (wanted('home')) {
    out.push({ name: 'Home page', focus: 'Home', steps: [{ type: 'snapshot', label: 'Home page' }] });
  }

  const nav = (page.nav || [])[0];
  if (nav && (wanted('menu') || wanted('nav'))) {
    out.push({
      name: 'Main navigation',
      focus: 'Mega-menu',
      steps: [
        { type: 'hover', selector: nav.selector, optional: true },
        { type: 'snapshot', label: 'Main navigation', context: nav.selector },
      ],
    });
  }

  const cart = byText(page.buttons, /cart|bag|basket/i) || byText(page.links, /cart|bag|basket/i);
  if (cart && wanted('cart')) {
    out.push({
      name: 'Add to cart',
      focus: 'Add to cart',
      steps: [
        { type: 'click', selector: cart.selector },
        { type: 'snapshot', label: 'Cart' },
      ],
    });
  }

  const search = (page.inputs || []).find((i) =>
    i.type === 'search' || /search|query|q$/i.test(`${i.name || ''} ${i.placeholder || ''}`));
  if (search && wanted('search')) {
    out.push({
      name: 'Search',
      focus: 'Search',
      steps: [
        { type: 'fill', selector: search.selector, value: 'test' },
        { type: 'snapshot', label: 'Search results' },
      ],
    });
  }

  const login = byText(page.links, /log ?in|sign ?in|account/i) || byText(page.buttons, /log ?in|sign ?in/i);
  if (login && wanted('login')) {
    out.push({
      name: 'Login',
      focus: 'Login',
      steps: [
        { type: 'click', selector: login.selector },
        { type: 'snapshot', label: 'Login form' },
      ],
    });
  }

  const checkout = byText(page.buttons, /checkout/i) || byText(page.links, /checkout/i);
  if (checkout && wanted('checkout')) {
    out.push({
      name: 'Checkout',
      focus: 'Checkout',
      steps: [
        { type: 'click', selector: checkout.selector },
        { type: 'snapshot', label: 'Checkout' },
      ],
    });
  }

  return out;
}

// Pull keyword hints out of the free-form intent so the heuristic fallback
// still narrows when the operator wrote prose instead of ticking chips.
// Tolerant on purpose: "add to cart", "cart page", "shopping bag" all match.
export function deriveFocusFromIntent(intent) {
  if (!intent) return [];
  const t = String(intent).toLowerCase();
  const found = [];
  if (/\b(home|landing|homepage)\b/.test(t)) found.push('Home');
  if (/\b(menu|mega[- ]?menu|nav|navigation)\b/.test(t)) found.push('Mega-menu');
  if (/\b(cart|basket|bag|add[- ]to[- ]cart)\b/.test(t)) found.push('Add to cart');
  if (/\b(search|find|query)\b/.test(t)) found.push('Search');
  if (/\b(log ?in|sign ?in|account|auth)\b/.test(t)) found.push('Login');
  if (/\b(checkout|purchase|payment|shipping|delivery)\b/.test(t)) found.push('Checkout');
  return found;
}

// ── accept ──────────────────────────────────────────────────────────────────

// Turn reviewed proposals into real journeys. Names already on the site are
// skipped rather than duplicated, matching the idempotent create route.
export function acceptProposals(siteId, indices) {
  const site = findSite(siteId);
  if (!site) return { error: 'site not found' };
  const proposals = site.discover?.proposals || [];
  if (!proposals.length) return { error: 'no proposals to accept' };

  const pick = Array.isArray(indices) && indices.length
    ? indices.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < proposals.length)
    : proposals.map((_, i) => i);

  const rulesetId = site.rulesetId || DEFAULT_RULESET;
  const created = [];
  const skipped = [];

  update((s) => {
    const list = allJourneys(s);
    for (const i of pick) {
      const p = proposals[i];
      const parsed = validateJourney({
        name: p.name, rulesetId, startUrl: site.url, steps: p.steps,
      });
      if (parsed.errors) { skipped.push({ name: p.name, error: parsed.errors.join('; ') }); continue; }
      if (list.some((j) => j.siteId === site.id && j.name === parsed.journey.name)) {
        skipped.push({ name: p.name, error: 'a journey with this name already exists' });
        continue;
      }
      const journey = makeJourney(site.id, parsed.journey);
      journey.source = 'auto';
      list.push(journey);
      created.push(journey);
    }
    const target = findSite(siteId, s);
    if (target?.discover) target.discover = { ...target.discover, proposals: [], acceptedAt: Date.now() };
    if (created.length) {
      s.activity.unshift({ ts: Date.now(), msg: `Accepted ${created.length} discovered journey(s) for ${site.url}` });
    }
  });

  return { created, skipped };
}
