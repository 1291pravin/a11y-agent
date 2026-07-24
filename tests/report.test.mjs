// Full journey report tests.
//
// A scored run needs real AQA credentials, so the report is exercised here
// against a synthetic run record shaped exactly like the one journeys.mjs
// writes. That keeps the report honest about the two things it must never get
// wrong: the score it prints, and the fact that a failed run is labelled as one
// rather than being quietly rendered as a clean result.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { journeyReportMarkdown, actionFor, RULE_ACTIONS } from '../server/report.mjs';
import { scoreCauses } from '../server/aqa-sync.mjs';

const SITE = { id: 'site-1', url: 'https://shop.example.com' };

const CAUSES = [
  {
    title: 'Inputs missing labels', rule: 'WCAG 1.3.1 A', ruleId: 'label',
    severity: 'critical', instances: 4, pages: ['Checkout form'],
    mappedFile: 'src/Checkout.vue:44', status: 'open', evidence: '<input id="email">',
  },
  {
    title: 'Low-contrast pay button', rule: 'WCAG 1.4.3 AA', ruleId: 'color-contrast',
    severity: 'serious', instances: 1, pages: ['Payment step'],
    mappedFile: null, status: 'open', evidence: '<button class="pay">',
  },
];

function journeyWith(overrides = {}) {
  const snapshots = [
    { label: 'Checkout form', context: 'main#checkout', status: 'ok', error: null, ms: 1740, bytes: 100, issues: 4, manualIssues: 2 },
    { label: 'Payment step', context: null, status: 'ok', error: null, ms: 1610, bytes: 90, issues: 1, manualIssues: 0 },
  ];
  return {
    id: 'journey-1', siteId: 'site-1', name: 'Checkout flow', rulesetId: 'WCAG21AA',
    lastRun: {
      at: Date.now(), ok: true, ms: 6400,
      steps: [
        { index: 0, type: 'goto', label: null, ms: 820, status: 'ok' },
        { index: 1, type: 'snapshot', label: 'Checkout form', ms: 1740, status: 'ok' },
      ],
      snapshots,
      causes: CAUSES.length,
      diff: { new: ['a', 'b'], fixed: ['c'], persisting: ['d', 'e', 'f'], at: Date.now() },
      score: scoreCauses(CAUSES, { units: snapshots.length }),
      prevScore: null,
      ...overrides,
    },
  };
}

test('report leads with the score and grade actually computed for the run', () => {
  const journey = journeyWith();
  const md = journeyReportMarkdown({ journey, site: SITE, causes: CAUSES });
  const { score, grade } = journey.lastRun.score;
  assert.match(md, new RegExp(`\\*\\*${score}/100 \\(grade ${grade}\\)\\*\\*`));
  assert.match(md, /Critical: 4 \| Serious: 1 \| Minor: 0/);
  assert.match(md, /Scored over 2 snapshot\(s\)/);
});

test('report states plainly that manual findings are excluded', () => {
  const md = journeyReportMarkdown({ journey: journeyWith(), site: SITE, causes: CAUSES });
  assert.match(md, /Manual-review findings are excluded/);
});

test('report shows a real delta only when there is a previous score', () => {
  const none = journeyReportMarkdown({ journey: journeyWith(), site: SITE, causes: CAUSES });
  assert.match(none, /Previous run: none to compare against/);

  const journey = journeyWith();
  const now = journey.lastRun.score.score;
  journey.lastRun.prevScore = now - 7;
  const withPrev = journeyReportMarkdown({ journey, site: SITE, causes: CAUSES });
  assert.match(withPrev, new RegExp(`Previous run: ${now - 7}/100 \\(\\+7\\)`));
});

test('a failed run is labelled as failed, not rendered as a clean result', () => {
  const journey = journeyWith({ ok: false, error: 'step 3 (click) failed: selector not found' });
  const md = journeyReportMarkdown({ journey, site: SITE, causes: CAUSES });
  assert.match(md, /## Run failed/);
  assert.match(md, /selector not found/);
});

test('a journey that never ran says so instead of printing an empty report', () => {
  const md = journeyReportMarkdown({ journey: { name: 'X', rulesetId: 'R', lastRun: null }, site: SITE, causes: [] });
  assert.match(md, /has not been run yet/);
  assert.doesNotMatch(md, /## Score/);
});

test('every cause is listed with where it is, its source, and what to do', () => {
  const md = journeyReportMarkdown({ journey: journeyWith(), site: SITE, causes: CAUSES });
  assert.match(md, /### Inputs missing labels/);
  assert.match(md, /- Where: Checkout form/);
  assert.match(md, /- Source: src\/Checkout\.vue:44/);
  assert.match(md, new RegExp(RULE_ACTIONS['label'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // An unmapped cause must say so rather than leaving the field blank.
  assert.match(md, /- Source: unmapped \(vendor, CMS, or outside the indexed repo\)/);
});

test('coverage table carries every snapshot, splitting fix-required from manual', () => {
  const md = journeyReportMarkdown({ journey: journeyWith(), site: SITE, causes: CAUSES });
  assert.match(md, /\| Checkout form \| main#checkout \| ok \| 4 \| 2 \| 1740 \|/);
  assert.match(md, /\| Payment step \| - \| ok \| 1 \| 0 \| 1610 \|/);
});

test('manual findings are reported as excluded rather than dropped silently', () => {
  const md = journeyReportMarkdown({ journey: journeyWith(), site: SITE, causes: CAUSES });
  assert.match(md, /2 manual-review finding\(s\) were reported but are not counted in the score/);
});

test('no open violations reads as a clean result, not a blank section', () => {
  const md = journeyReportMarkdown({ journey: journeyWith(), site: SITE, causes: [] });
  assert.match(md, /No open fix-required violations/);
});

test('an unknown rule still gets an actionable suggestion', () => {
  assert.ok(actionFor('some-unknown-rule').length > 0);
  assert.equal(actionFor('image-alt'), RULE_ACTIONS['image-alt']);
});
