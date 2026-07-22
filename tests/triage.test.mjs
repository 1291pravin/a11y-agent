// Issue filter + triage unit tests. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNeedFixIssue, filterNeedFixIssues } from '../server/issue-filter.mjs';
import { triageCauses, clusterKey } from '../server/triage.mjs';

test('isNeedFixIssue excludes check-manually properties', () => {
  assert.equal(isNeedFixIssue({ properties: ['Check manually'], ruleId: 'x' }), false);
  assert.equal(isNeedFixIssue({ properties: ['high', 'Check manually'] }), false);
  assert.equal(isNeedFixIssue({ properties: ['manual review'] }), false);
});

test('isNeedFixIssue includes need-fix markers and needFixTitle', () => {
  assert.equal(isNeedFixIssue({ needFixTitle: 'Add alt text', properties: [] }), true);
  assert.equal(isNeedFixIssue({ properties: ['Need fix', 'high'] }), true);
  assert.equal(isNeedFixIssue({ properties: ['high'], category: 'need_fix' }), true);
});

test('filterNeedFixIssues drops manual bucket issues', () => {
  const issues = [
    { ruleId: 'a', needFixTitle: 'Fix A', properties: ['high'] },
    { ruleId: 'b', properties: ['Check manually'] },
  ];
  const out = filterNeedFixIssues(issues);
  assert.equal(out.length, 1);
  assert.equal(out[0].ruleId, 'a');
});

test('deterministic triage merges same rule + similar title', async () => {
  const causes = [
    {
      id: 'c1', siteId: 's1', ruleId: 'image-alt', rule: 'IMAGE-ALT', title: 'Add missing alt text',
      severity: 'critical', instances: 2, pages: ['Home'], mappedFile: null, status: 'open', evidence: 'a',
    },
    {
      id: 'c2', siteId: 's1', ruleId: 'image-alt', rule: 'IMAGE-ALT', title: 'Add missing alt text',
      severity: 'serious', instances: 3, pages: ['PLP'], mappedFile: 'src/Hero.vue:4', status: 'open', evidence: 'b',
    },
    {
      id: 'c3', siteId: 's1', ruleId: 'frame-title', rule: 'FRAME-TITLE', title: 'Title the chat iframe',
      severity: 'serious', instances: 1, pages: ['Home'], mappedFile: null, status: 'open', evidence: 'c',
    },
  ];
  const out = await triageCauses(causes);
  assert.equal(out.length, 2);
  const merged = out.find((c) => c.ruleId === 'image-alt');
  assert.equal(merged.instances, 5);
  assert.equal(merged.severity, 'critical');
  assert.equal(merged.mappedFile, 'src/Hero.vue:4');
  assert.deepEqual(merged.pages.sort(), ['Home', 'PLP']);
});

test('clusterKey normalizes title casing', () => {
  assert.equal(
    clusterKey({ ruleId: 'link-name', title: 'Name the cart link' }),
    clusterKey({ ruleId: 'link-name', title: 'Name the Cart Link' }),
  );
});
