// ~60s product demo: all pages, variable pacing, burned-in subtitles.
// Subtitles are rendered in the browser overlay and recorded into the video.
// Run: npm run record:demo

import { test, expect } from '@playwright/test';
import {
  installDemoOverlay,
  narrate,
  clickHighlighted,
  waitForTaskState,
} from './demo-overlay.mjs';

test('a11y agent end-to-end demo', async ({ page }) => {
  await installDemoOverlay(page);

  await page.goto('/');
  await page.evaluate(async () => {
    await fetch('/api/fleet/sync', { method: 'POST' });
  });
  await page.waitForFunction(async () => {
    const s = await fetch('/api/state').then((r) => r.json());
    return s.sites.length > 0 && s.sites.some((x) => (x.total || 0) > 0);
  }, null, { timeout: 120_000 });

  const sitesNav = page.locator('#nav a[href="#/sites"]');
  const tasksNav = page.locator('#nav a[href="#/tasks"]');
  const prsNav = page.locator('#nav a[href="#/prs"]');
  const settingsNav = page.locator('#nav a[href="#/settings"]');
  const dashNav = page.locator('#nav a[href="#/dashboard"]');

  // 1 · Dashboard (4s)
  await page.goto('/#/dashboard');
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await narrate(
    page,
    'Dashboard',
    'A11y Agent — portfolio view of sites covered, open violations, fix PRs, and active agent tasks.',
    4000,
  );

  // 2 · Sites (3s)
  await clickHighlighted(page, sitesNav, { label: 'Sites' });
  await expect(page.getByRole('heading', { name: 'Sites' })).toBeVisible();
  await narrate(
    page,
    'Sites',
    'Every storefront links to its GitHub repo, AQA suite, and live status.',
    3000,
  );

  // 3 · Site detail (6s)
  const siteRow = page.getByRole('row', { name: /dev\.int\.filorga\.com/ }).first();
  await clickHighlighted(page, siteRow, { label: 'Open site' });
  await expect(page.getByText('Violations by root cause')).toBeVisible();
  await page.getByText('Violations by root cause').scrollIntoViewIfNeeded();
  await narrate(
    page,
    'Site detail',
    'Violations grouped by root cause — WCAG rule, severity, instances, and mapped file:line for dispatch.',
    6000,
  );

  // 4 · Dispatch → Tasks (5s)
  const dispatch = page.getByRole('button', { name: 'Dispatch fix task' }).first();
  const causeTitle = (await dispatch.locator('xpath=ancestor::tr/td[1]').textContent())?.trim();
  await clickHighlighted(page, dispatch, { label: 'Dispatch fix' });
  await waitForTaskState(page, 'dispatched', causeTitle);
  await clickHighlighted(page, tasksNav, { label: 'Tasks' });
  await expect(page.getByRole('heading', { name: 'Fix tasks' })).toBeVisible();
  await narrate(
    page,
    'Fix tasks',
    'Task lifecycle: Queued → Working → Verifying. Agent patches the repo and opens a PR.',
    5000,
    () => waitForTaskState(page, 'verifying', causeTitle, 15_000),
  );
  await page.getByText('Verifying').first().scrollIntoViewIfNeeded();

  // 5 · Pull requests (5s)
  await clickHighlighted(page, prsNav, { label: 'Pull requests' });
  await expect(page.getByRole('heading', { name: 'Pull requests' })).toBeVisible();
  await narrate(
    page,
    'Pull requests',
    'PR shows WCAG evidence, affected pages, source file, and expected violation delta after merge.',
    5000,
  );

  // 6 · Merge + verify (2s)
  const prNum = await page.evaluate(async () => {
    const s = await fetch('/api/state').then((r) => r.json());
    return s.prs.find((p) => p.state === 'open')?.num || null;
  });
  await clickHighlighted(page, page.getByRole('button', { name: 'Mark merged' }), { label: 'Mark merged' });
  await waitForTaskState(page, 'merged-verified', prNum, 10_000);
  await narrate(
    page,
    'Merge & verify',
    'After merge, AQA re-runs to confirm the violation cleared.',
    2000,
  );

  // 7 · Tasks done (3s)
  await clickHighlighted(page, tasksNav, { label: 'Tasks' });
  await page.getByText('Done').first().scrollIntoViewIfNeeded();
  await narrate(
    page,
    'Task complete',
    'Verification passed — task in Done, root cause marked fixed.',
    3000,
  );

  // 8 · PR verified (3s)
  await clickHighlighted(page, prsNav, { label: 'PRs' });
  await expect(page.getByText(/merged.*verified/i)).toBeVisible({ timeout: 5000 });
  await narrate(
    page,
    'PR verified',
    'PR merged and verified — the accessibility fix loop is complete.',
    3000,
  );

  // 9 · Settings (4s)
  await clickHighlighted(page, settingsNav, { label: 'Settings' });
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await narrate(
    page,
    'Settings',
    'AQA, Cursor, and GitHub connections — plus policies for dispatch, merge, and scan cadence.',
    4000,
  );

  // 10 · Close on dashboard (2s)
  await clickHighlighted(page, dashNav, { label: 'Dashboard' });
  await narrate(
    page,
    'A11y Agent',
    'From scan to fix to verified merge — accessibility built into your SDLC.',
    2000,
  );
});
