// M0 verification checklist — browser E2E (PLAN.md).
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => fetch('/api/demo/reset', { method: 'POST' }));
});

test.describe('M0 dashboard', () => {
  test('loads portfolio with KPI cards and seeded sites', async ({ page }) => {
    await page.goto('/#/dashboard');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
    await expect(page.getByText('Sites covered')).toBeVisible();
    await expect(page.getByText('Open violations')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'demo.example.com' })).toBeVisible();
    await expect(page.locator('#mode-badge')).toHaveText('demo');
  });
});

test.describe('M0 site detail', () => {
  test('demo site shows flows and root causes', async ({ page }) => {
    await page.goto('/#/site/site-demo');
    await expect(page.getByRole('heading', { name: /demo\.example\.com/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run tests' })).toBeVisible();
    await expect(page.getByText('Violations by root cause')).toBeVisible();
    await expect(page.getByText('Demo images missing alt text')).toBeVisible();
  });

  test('dispatch fix task creates a queued task', async ({ page }) => {
    await page.goto('/#/site/site-demo');
    await page.getByRole('button', { name: 'Dispatch fix task' }).first().click();
    await page.goto('/#/tasks');
    await expect(page.getByText('Queued')).toBeVisible();
    await expect(page.locator('.kcard').first()).toBeVisible();
  });
});

test.describe('M0 onboard', () => {
  // /#/onboard is now a fork: the suite path ("full") and the quick scan. The
  // suite form moved to /#/onboard/full.
  test('offers both onboarding paths', async ({ page }) => {
    await page.goto('/#/onboard');
    await expect(page.getByRole('heading', { name: 'Full audit + auto-fix' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Quick scan' })).toBeVisible();
  });

  test('validates required fields', async ({ page }) => {
    await page.goto('/#/onboard/full');
    await page.getByLabel('Website URL').fill('https://x.example.com');
    await page.getByRole('button', { name: 'Onboard', exact: true }).click();
    await expect(page.locator('#onboard-err')).toContainText(/repo/i);
  });

  test('creates a site and navigates to detail', async ({ page }) => {
    await page.goto('/#/onboard/full');
    await page.getByLabel('Website URL').fill('https://e2e.example.com');
    await page.getByLabel('GitHub repo (owner/name)').fill('acme/e2e-test');
    await page.getByLabel('AQA suite ID').fill('TS999');
    await page.getByRole('button', { name: 'Onboard', exact: true }).click();
    await expect(page).toHaveURL(/#\/site\/site-/);
    await expect(page.getByRole('heading', { name: /e2e\.example\.com/ })).toBeVisible();
  });

  // The quick path needs only a URL: no repo, no AQA suite.
  test('quick scan accepts a URL alone', async ({ page }) => {
    await page.goto('/#/onboard/quick');
    await expect(page.getByRole('heading', { name: /Quick scan/ })).toBeVisible();
    await expect(page.getByLabel('Website URL')).toBeVisible();
    await expect(page.getByRole('button', { name: /Scan & discover journeys/ })).toBeVisible();
  });
});

test.describe('M0 settings', () => {
  test('shows demo mode for integrations', async ({ page }) => {
    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'AQA (UsableNet)' })).toBeVisible();
    await expect(page.getByText('demo', { exact: true }).first()).toBeVisible();
  });
});

test.describe('M0 demo reset', () => {
  test('reset demo data clears tasks', async ({ page }) => {
    await page.goto('/#/site/site-demo');
    await page.getByRole('button', { name: 'Dispatch fix task' }).first().click();
    await page.getByRole('button', { name: 'Reset demo data' }).click();
    await page.goto('/#/tasks');
    await expect(page.getByText('No tasks yet')).toBeVisible();
  });
});
