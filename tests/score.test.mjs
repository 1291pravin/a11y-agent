// Accessibility score tests.
//
// The score is our own number, so its calibration is a product decision, not an
// implementation detail. These tests pin the anchors documented in aqa-sync so a
// tweak to the weights or the decay constant cannot silently turn every real
// site into an F (or into an A).
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreCauses, gradeFor, openCauses } from '../server/aqa-sync.mjs';

const cause = (severity, instances, extra = {}) => ({ severity, instances, ...extra });

// Allow a little slack: the anchors are targets, not exact arithmetic.
const near = (actual, expected, slack = 4) =>
  assert.ok(Math.abs(actual - expected) <= slack, `expected ~${expected}, got ${actual}`);

test('a clean page scores 100', () => {
  const r = scoreCauses([], { units: 1 });
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  assert.equal(r.instances, 0);
});

test('one minor instance barely moves the score', () => {
  near(scoreCauses([cause('minor', 1)], { units: 1 }).score, 98);
});

test('one critical instance is noticeable but not catastrophic', () => {
  near(scoreCauses([cause('critical', 1)], { units: 1 }).score, 85);
});

test('three critical plus a serious is clearly failing', () => {
  const r = scoreCauses([cause('critical', 3), cause('serious', 1)], { units: 1 });
  near(r.score, 58);
  assert.equal(r.counts.critical, 3);
  assert.equal(r.counts.serious, 1);
  assert.equal(r.instances, 4);
});

test('ten critical instances score badly', () => {
  const r = scoreCauses([cause('critical', 10)], { units: 1 });
  near(r.score, 20);
  assert.equal(r.grade, 'F');
});

test('severity is weighted: critical hurts more than the same count of minor', () => {
  const crit = scoreCauses([cause('critical', 3)], { units: 1 }).score;
  const minor = scoreCauses([cause('minor', 3)], { units: 1 }).score;
  assert.ok(crit < minor, `critical (${crit}) should score below minor (${minor})`);
});

test('score normalizes by scored surface, so a bigger site is not automatically worse', () => {
  // Same density: one critical per unit should land on the same score.
  const small = scoreCauses([cause('critical', 1)], { units: 1 }).score;
  const large = scoreCauses([cause('critical', 10)], { units: 10 }).score;
  assert.equal(small, large);
});

test('score never leaves 0-100', () => {
  const awful = scoreCauses([cause('critical', 100000)], { units: 1 }).score;
  assert.ok(awful >= 0 && awful <= 100, `out of range: ${awful}`);
  assert.equal(awful, 0);
});

test('an unknown severity is treated as minor rather than crashing', () => {
  const r = scoreCauses([cause('bogus', 4)], { units: 1 });
  assert.equal(r.counts.minor, 4);
  assert.ok(r.score > 0);
});

test('grade bands line up with the score', () => {
  assert.equal(gradeFor(100), 'A');
  assert.equal(gradeFor(90), 'A');
  assert.equal(gradeFor(89), 'B');
  assert.equal(gradeFor(75), 'B');
  assert.equal(gradeFor(60), 'C');
  assert.equal(gradeFor(40), 'D');
  assert.equal(gradeFor(39), 'F');
});

test('fixed causes are history and do not drag the score down', () => {
  const causes = [cause('critical', 3, { status: 'fixed' }), cause('minor', 1, { status: 'open' })];
  const open = openCauses(causes);
  assert.equal(open.length, 1);
  near(scoreCauses(open, { units: 1 }).score, 98);
});
