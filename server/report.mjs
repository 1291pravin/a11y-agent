// Report generation.
//
// The existing site fix-report is a narrow deliverable: a hand-off of the causes
// that could NOT be auto-fixed. This module is the general one - a full, scored
// account of a journey run: what the score is, what is failing, where, and what
// to do about it.
//
// Shared vocabulary (the rule -> suggested action map) lives here so both
// reports speak the same way about the same rule.

import { gradeFor } from './aqa-sync.mjs';

export const RULE_ACTIONS = {
  'image-alt': 'Add descriptive alt text to the image (or alt="" if purely decorative).',
  'link-name': 'Give the link a discernible name: visible text, aria-label, or a visually hidden span.',
  'color-contrast': 'Raise the text/background contrast ratio to at least 4.5:1 (3:1 for large text).',
  'frame-title': 'Add a title attribute to the iframe that describes its content.',
  'label': 'Associate a label with the form control via label[for], aria-label, or aria-labelledby.',
  'heading-order': 'Restructure headings so levels increase one step at a time without skipping.',
};

export const DEFAULT_ACTION = 'Review the element against the rule and correct the markup at the mapped source location.';

export function actionFor(ruleId) {
  return RULE_ACTIONS[ruleId] || DEFAULT_ACTION;
}

// Full report for one journey run. `causes` are this journey's open causes.
export function journeyReportMarkdown({ journey, site, causes = [] }) {
  const run = journey.lastRun;
  const score = run?.score;
  const snaps = run?.snapshots || [];
  const steps = run?.steps || [];

  const lines = [
    `# Accessibility report - ${journey.name}`,
    '',
    `- Site: ${site?.url || '-'}`,
    `- Journey: ${journey.name}`,
    `- Ruleset: ${journey.rulesetId}`,
    `- Generated: ${new Date().toISOString()}`,
    run?.at ? `- Run: ${new Date(run.at).toISOString()}${run.ms ? ` (${(run.ms / 1000).toFixed(1)}s)` : ''}` : '- Run: never',
    '',
  ];

  if (!run) {
    lines.push('This journey has not been run yet, so there is nothing to report.', '');
    return lines.join('\n');
  }

  if (!run.ok) {
    lines.push(
      '## Run failed',
      '',
      `The last run did not complete: ${run.error || 'unknown error'}.`,
      'Scores and findings below reflect the previous successful run, if any.',
      '',
    );
  }

  if (score) {
    lines.push(
      '## Score',
      '',
      `**${score.score}/100 (grade ${score.grade})**`,
      '',
      `- Fix-required instances: ${score.instances} across ${score.causes} root cause(s)`,
      `- Critical: ${score.counts.critical} | Serious: ${score.counts.serious} | Minor: ${score.counts.minor}`,
      `- Scored over ${score.units} snapshot(s)`,
      run.prevScore != null
        ? `- Previous run: ${run.prevScore}/100 (${delta(score.score, run.prevScore)})`
        : '- Previous run: none to compare against',
      '',
      'Manual-review findings are excluded: this score counts only what a',
      'developer can actually fix in code.',
      '',
    );
  }

  if (run.diff) {
    lines.push(
      '## Movement since the last run',
      '',
      `- New: ${run.diff.new.length}`,
      `- Fixed: ${run.diff.fixed.length}`,
      `- Persisting: ${run.diff.persisting.length}`,
      '',
    );
  }

  lines.push(`## What is failing (${causes.length} root cause(s))`, '');
  if (!causes.length) {
    lines.push('No open fix-required violations were found on this journey.', '');
  }
  for (const c of causes) {
    lines.push(
      `### ${c.title}`,
      '',
      `- Rule: ${c.rule} (${c.ruleId})`,
      `- Severity: ${c.severity}`,
      `- Instances: ${c.instances}`,
      `- Where: ${(c.pages || []).join(', ') || '-'}`,
      `- Source: ${c.mappedFile || 'unmapped (vendor, CMS, or outside the indexed repo)'}`,
      `- Status: ${c.status}`,
      `- Evidence: \`${c.evidence || '-'}\``,
      `- Suggested action: ${actionFor(c.ruleId)}`,
      '',
    );
  }

  lines.push('## Coverage', '');
  if (snaps.length) {
    lines.push(
      '| Snapshot | Context | Status | Fix-required | Manual | ms |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const s of snaps) {
      lines.push(`| ${s.label} | ${s.context || '-'} | ${s.status} | ${s.issues} | ${s.manualIssues || 0} | ${s.ms ?? '-'} |`);
    }
    lines.push('');
    const manual = snaps.reduce((n, s) => n + (s.manualIssues || 0), 0);
    if (manual) {
      lines.push(
        `${manual} manual-review finding(s) were reported but are not counted in the score:`,
        'they need a human judgement call, not a code change.',
        '',
      );
    }
  } else {
    lines.push('No snapshots were captured.', '');
  }

  if (steps.length) {
    lines.push('## Steps walked', '');
    for (const s of steps) {
      lines.push(`${s.index + 1}. ${s.type}${s.label ? ` "${s.label}"` : ''} - ${s.status}${s.error ? ` (${s.error})` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function delta(now, before) {
  const d = now - before;
  if (d === 0) return 'no change';
  return d > 0 ? `+${d}` : String(d);
}

// Re-exported so callers can render a grade without importing aqa-sync too.
export { gradeFor };
