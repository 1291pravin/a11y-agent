// Journey model and validation. Pure: no store, no network, no browser.
//
// A journey is an ordered list of steps that a real browser walks, with
// `snapshot` steps marking the points where the DOM is captured and scored
// through AQA's stateless evaluate endpoint. The step vocabulary is carried
// over from the earlier design pass in aqa-usablenet-helper so the two stay
// interchangeable.

export const STEP_TYPES = ['goto', 'click', 'fill', 'hover', 'waitFor', 'snapshot'];

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export function validateJourney(body) {
  const errors = [];

  const name = String(body.name || '').trim();
  if (!name) errors.push('name is required');

  // evaluate scores against a named ruleset and has no account default to fall
  // back on, so a journey without one could never be run.
  const rulesetId = String(body.rulesetId || '').trim();
  if (!rulesetId) errors.push('rulesetId is required');

  const startUrl = String(body.startUrl || '').trim();
  if (!startUrl) errors.push('startUrl is required');

  const rawSteps = Array.isArray(body.steps) ? body.steps : null;
  if (!rawSteps || !rawSteps.length) errors.push('steps must be a non-empty array');

  const steps = [];
  for (const [i, raw] of (rawSteps || []).entries()) {
    const res = validateStep(raw, i);
    if (res.error) errors.push(res.error);
    else steps.push(res.step);
  }

  if (rawSteps?.length && !steps.some((s) => s.type === 'snapshot')) {
    errors.push('at least one snapshot step is required; a journey with no snapshot scores nothing');
  }

  const viewport = normalizeViewport(body.viewport, errors);

  if (errors.length) return { errors };

  // Normalize the implicit first navigation into a real step, so the runner
  // walks one uniform list and every reported timing lines up with an index.
  if (steps[0]?.type !== 'goto') steps.unshift({ type: 'goto', url: startUrl });

  return { journey: { name, rulesetId, startUrl, viewport, steps } };
}

function validateStep(raw, i) {
  const at = `step ${i + 1}`;
  if (!raw || typeof raw !== 'object') return { error: `${at}: must be an object` };

  const type = String(raw.type || '');
  if (!STEP_TYPES.includes(type)) {
    return { error: `${at}: unknown type "${type}" (expected one of ${STEP_TYPES.join(', ')})` };
  }

  const step = { type };
  // An optional step whose target is missing is reported and skipped instead of
  // failing the run. Cookie banners are the motivating case: they appear for
  // some sessions and not others, and no journey should be hostage to that.
  if (raw.optional) step.optional = true;
  if (raw.timeoutMs != null) {
    const ms = Number(raw.timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) return { error: `${at}: timeoutMs must be a positive number` };
    step.timeoutMs = ms;
  }

  const takeSelector = () => {
    const sel = String(raw.selector || '').trim();
    if (!sel) return `${at}: ${type} requires a selector`;
    step.selector = sel;
    return null;
  };

  let err = null;
  switch (type) {
    case 'goto': {
      const url = String(raw.url || '').trim();
      if (!url) err = `${at}: goto requires a url`;
      else step.url = url;
      break;
    }
    case 'click':
    case 'hover':
      err = takeSelector();
      break;
    case 'fill':
      err = takeSelector();
      if (!err) {
        if (typeof raw.value !== 'string') err = `${at}: fill requires a string value`;
        else step.value = raw.value;
      }
      break;
    case 'waitFor': {
      // Exactly one condition, so a typo cannot quietly become a no-op wait.
      const given = ['selector', 'networkIdle', 'ms'].filter((k) => raw[k] != null && raw[k] !== false && raw[k] !== '');
      if (given.length !== 1) {
        err = `${at}: waitFor requires exactly one of selector, networkIdle, ms`;
      } else if (raw.selector) {
        err = takeSelector();
      } else if (raw.networkIdle) {
        step.networkIdle = true;
      } else {
        const ms = Number(raw.ms);
        if (!Number.isFinite(ms) || ms <= 0) err = `${at}: waitFor ms must be a positive number`;
        else step.ms = ms;
      }
      break;
    }
    case 'snapshot': {
      const label = String(raw.label || '').trim();
      if (!label) { err = `${at}: snapshot requires a label`; break; }
      step.label = label;
      if (raw.description) step.description = String(raw.description);
      // Per-snapshot overrides of the journey defaults.
      if (raw.rulesetId) step.rulesetId = String(raw.rulesetId);
      if (raw.context) step.context = String(raw.context);
      if (raw.manual) step.manual = true;
      break;
    }
  }

  return err ? { error: err } : { step };
}

function normalizeViewport(raw, errors) {
  if (raw == null) return { ...DEFAULT_VIEWPORT };
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    errors.push('viewport must be {width, height} with positive numbers');
    return { ...DEFAULT_VIEWPORT };
  }
  return { width, height };
}
