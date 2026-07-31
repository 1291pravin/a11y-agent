// Journey discovery tests.
//
// The heuristic proposer is the fallback that runs when no LLM is configured,
// so it is the path most installs will actually hit. These tests pin the two
// properties that matter: it only ever proposes selectors that came back from
// the real page inspection (it never invents one), and it honours the focus
// areas the user picked.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// journey-propose pulls in the store transitively. Point it at a throwaway JSON
// file before importing so a test run never touches the real state database.
process.env.STORE_BACKEND = 'json';
process.env.STATE_FILE = join(tmpdir(), `a11y-agent-discovery-${process.pid}.json`);

const { proposeWithHeuristics, deriveFocusFromIntent, FOCUS_AREAS } = await import('../server/journey-propose.mjs');

// Shaped like a real runner /inspect response.
const PAGE = {
  title: 'Shop',
  nav: [{ selector: '#main-nav', text: 'Home Products Sale' }],
  buttons: [
    { selector: '[data-testid="add-to-cart"]', text: 'Add to cart' },
    { selector: 'button.hero', text: 'Shop now' },
  ],
  links: [
    { selector: 'a.account', text: 'Sign in', href: '/login' },
    { selector: 'a.help', text: 'Help', href: '/help' },
  ],
  inputs: [
    { selector: '#site-search', type: 'search', name: 'q', placeholder: 'Search' },
    { selector: '#newsletter', type: 'email', name: 'email', placeholder: 'Email' },
  ],
  landmarks: [{ selector: 'main', tag: 'main', role: null }],
};

const BARE_PAGE = { title: 'Docs', nav: [], buttons: [], links: [], inputs: [], landmarks: [] };

const byName = (list, name) => list.find((j) => j.name === name);

test('always proposes a home-page journey', () => {
  const out = proposeWithHeuristics({ page: PAGE, focus: [] });
  const home = byName(out, 'Home page');
  assert.ok(home, 'expected a Home page proposal');
  assert.deepEqual(home.steps, [{ type: 'snapshot', label: 'Home page' }]);
});

test('uses the real nav selector, and scopes the snapshot to it', () => {
  const out = proposeWithHeuristics({ page: PAGE, focus: [] });
  const nav = byName(out, 'Main navigation');
  assert.ok(nav);
  // hover is optional: a nav that does not open on hover must not fail the run.
  assert.deepEqual(nav.steps[0], { type: 'hover', selector: '#main-nav', optional: true });
  assert.equal(nav.steps[1].type, 'snapshot');
  assert.equal(nav.steps[1].context, '#main-nav');
});

test('prefers the stable data-testid hook the page actually exposes', () => {
  const out = proposeWithHeuristics({ page: PAGE, focus: [] });
  const cart = byName(out, 'Add to cart');
  assert.ok(cart);
  assert.equal(cart.steps[0].selector, '[data-testid="add-to-cart"]');
});

test('finds search and login from input type and link text', () => {
  const out = proposeWithHeuristics({ page: PAGE, focus: [] });
  const search = byName(out, 'Search');
  assert.ok(search);
  assert.equal(search.steps[0].type, 'fill');
  assert.equal(search.steps[0].selector, '#site-search');

  const login = byName(out, 'Login');
  assert.ok(login);
  assert.equal(login.steps[0].selector, 'a.account');
});

test('never invents a selector for a flow the page does not have', () => {
  const out = proposeWithHeuristics({ page: BARE_PAGE, focus: [] });
  // A page with no nav, cart, search or login yields only the home snapshot.
  assert.deepEqual(out.map((j) => j.name), ['Home page']);
});

test('honours the focus areas the user picked', () => {
  const out = proposeWithHeuristics({ page: PAGE, focus: ['Search'] });
  assert.deepEqual(out.map((j) => j.name), ['Search']);
});

test('every proposed step uses a selector that came from the inspected page', () => {
  const known = new Set([
    ...PAGE.nav.map((x) => x.selector),
    ...PAGE.buttons.map((x) => x.selector),
    ...PAGE.links.map((x) => x.selector),
    ...PAGE.inputs.map((x) => x.selector),
  ]);
  for (const journey of proposeWithHeuristics({ page: PAGE, focus: [] })) {
    for (const step of journey.steps) {
      if (step.selector) assert.ok(known.has(step.selector), `unknown selector ${step.selector}`);
      if (step.context) assert.ok(known.has(step.context), `unknown context ${step.context}`);
    }
  }
});

test('exposes the focus areas the UI offers', () => {
  assert.ok(FOCUS_AREAS.includes('Mega-menu'));
  assert.ok(FOCUS_AREAS.includes('Add to cart'));
});

// The free-form intent textarea (M6) replaces the focus chips as the primary
// signal. When only intent is supplied, keyword extraction stands in for the
// chip picks so the heuristic fallback still narrows correctly.
test('derives focus areas from a free-form intent prompt', () => {
  assert.deepEqual(
    deriveFocusFromIntent('We really care about the checkout flow and the cookie banner.'),
    ['Checkout'],
  );
  const t = deriveFocusFromIntent('Cover the homepage, add to cart, and the login form. Skip the blog.');
  assert.ok(t.includes('Home'));
  assert.ok(t.includes('Add to cart'));
  assert.ok(t.includes('Login'));
});

test('intent narrows the heuristic proposals when no explicit focus is given', () => {
  const out = proposeWithHeuristics({ page: PAGE, focus: [], intent: 'we only care about search please' });
  assert.deepEqual(out.map((j) => j.name), ['Search']);
});

test('explicit focus wins over intent when both are given', () => {
  // The operator ticked "Login" but wrote "search" in the prompt: chips win.
  const out = proposeWithHeuristics({ page: PAGE, focus: ['Login'], intent: 'we only care about search' });
  assert.deepEqual(out.map((j) => j.name), ['Login']);
});

test('empty intent behaves like no intent (backward compatible)', () => {
  const before = proposeWithHeuristics({ page: PAGE, focus: [] });
  const after = proposeWithHeuristics({ page: PAGE, focus: [], intent: '' });
  assert.deepEqual(before, after);
});
