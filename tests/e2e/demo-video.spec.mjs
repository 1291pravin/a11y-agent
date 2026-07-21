// End-to-end product demo: dashboard -> site -> dispatch -> tasks -> PR -> verified.
// Recorded by npm run record:demo (see scripts/record-demo.mjs).

import { test, expect } from '@playwright/test';

const PAUSE = 700;

async function pause(page, ms = PAUSE) {
  await page.waitForTimeout(ms);
}

async function waitForTaskState(page, check, arg, timeout = 20_000) {
  if (check === 'dispatched') {
    await page.waitForFunction(async (title) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.tasks.some((t) => t.title === title);
    }, arg, { timeout });
    return;
  }
  if (check === 'verifying') {
    await page.waitForFunction(async (title) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.tasks.some((t) => t.title === title && t.state === 'verifying' && t.pr?.num);
    }, arg, { timeout });
    return;
  }
  if (check === 'merged-verified') {
    await page.waitForFunction(async (prNum) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.prs.some((p) => p.num === prNum && p.state === 'merged-verified');
    }, arg, { timeout });
  }
}

test('a11y agent end-to-end demo', async ({ page }) => {
  // Fresh fleet with no in-flight tasks.
  await page.goto('/');
  await page.evaluate(async () => {
    await fetch('/api/fleet/sync', { method: 'POST' });
  });
  await page.waitForFunction(async () => {
    const s = await fetch('/api/state').then((r) => r.json());
    return s.sites.length > 0 && s.sites.some((x) => (x.total || 0) > 0);
  }, null, { timeout: 120_000 });

  // 1. Dashboard
  await page.goto('/#/dashboard');
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await expect(page.getByText('Open violations')).toBeVisible();
  await pause(page, 1200);

  // 2. Sites list
  await page.locator('#nav a[href="#/sites"]').click();
  await expect(page.getByRole('heading', { name: 'Sites' })).toBeVisible();
  await pause(page);

  // 3. Site detail — pick filorga-eu (distinct from intl-dev duplicate data)
  await page.getByRole('row', { name: /dev\.int\.filorga\.com/ }).first().click();
  await expect(page.getByText('Violations by root cause')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dispatch fix task' }).first()).toBeVisible();
  await page.getByText('Violations by root cause').scrollIntoViewIfNeeded();
  await pause(page, 1000);

  // 4. Dispatch fix task
  const dispatch = page.getByRole('button', { name: 'Dispatch fix task' }).first();
  const causeTitle = await dispatch.locator('xpath=ancestor::tr/td[1]').textContent();
  await dispatch.click();
  await waitForTaskState(page, 'dispatched', causeTitle?.trim());

  // 5. Tasks board — show progression
  await page.locator('#nav a[href="#/tasks"]').click();
  await expect(page.getByRole('heading', { name: 'Fix tasks' })).toBeVisible();
  await pause(page);

  // Wait until PR is open (task parks in verifying)
  await waitForTaskState(page, 'verifying', causeTitle?.trim(), 15_000);
  await page.getByText('Verifying').first().scrollIntoViewIfNeeded();
  await pause(page, 900);

  // 6. Pull requests
  await page.locator('#nav a[href="#/prs"]').click();
  await expect(page.getByRole('heading', { name: 'Pull requests' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark merged' })).toBeVisible();
  await pause(page, 1000);

  // 7. Merge + verification completes the loop
  const prNum = await page.evaluate(async () => {
    const s = await fetch('/api/state').then((r) => r.json());
    return s.prs.find((p) => p.state === 'open')?.num || null;
  });
  await page.getByRole('button', { name: 'Mark merged' }).click();
  await waitForTaskState(page, 'merged-verified', prNum, 10_000);

  // 7b. Tasks — show completed column
  await page.locator('#nav a[href="#/tasks"]').click();
  await expect(page.getByText('Done').first()).toBeVisible();
  await page.getByText('Done').first().scrollIntoViewIfNeeded();
  await pause(page, 900);

  // 8. Pull requests — verified
  await page.locator('#nav a[href="#/prs"]').click();
  await expect(page.getByRole('heading', { name: 'Pull requests' })).toBeVisible();
  await expect(page.getByText(/merged.*verified/i)).toBeVisible({ timeout: 8000 });
  await pause(page, 1200);

  // 9. Back to dashboard — show portfolio still live
  await page.locator('#nav a[href="#/dashboard"]').click();
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await pause(page, 800);
});
