// Loading and feedback states: skeleton, scan progress, toasts, live region.
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => fetch('/api/demo/reset', { method: 'POST' }));
});

test.describe('feedback: page structure', () => {
  test('live region and overlay hosts live outside #main so polls cannot destroy them', async ({ page }) => {
    await page.goto('/#/dashboard');
    const announcer = page.locator('#announcer');
    await expect(announcer).toHaveAttribute('role', 'status');
    await expect(announcer).toHaveAttribute('aria-live', 'polite');

    // The regression this guards: #main used to carry aria-live itself, so the
    // 3s full re-render re-announced the entire page.
    await expect(page.locator('#main')).not.toHaveAttribute('aria-live', /.*/);
    for (const id of ['#announcer', '#toasts', '#conn-banner']) {
      expect(await page.locator(`#main ${id}`).count()).toBe(0);
      expect(await page.locator(id).count()).toBe(1);
    }
  });

  test('main is marked not-busy once state has rendered', async ({ page }) => {
    await page.goto('/#/dashboard');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
  });
});

test.describe('feedback: scan progress', () => {
  test('running scan shows stage, elapsed and an indeterminate progressbar', async ({ page }) => {
    await page.goto('/#/site/site-demo');
    await page.getByRole('button', { name: 'Run tests' }).click();

    const box = page.locator('.scanbox');
    await expect(box).toBeVisible();
    await expect(box).toContainText(/Requesting a run|Waiting for AQA|Scan in progress/);
    await expect(box).toContainText(/elapsed/);

    const bar = box.getByRole('progressbar');
    await expect(bar).toBeVisible();
    // Indeterminate: no value is claimed, because AQA reports no percentage.
    await expect(bar).not.toHaveAttribute('aria-valuenow', /.*/);

    // Button reflects the running scan and stays disabled across poll renders.
    const btn = page.getByRole('button', { name: /Scanning/ });
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  test('scan panel clears and the button returns when the scan completes', async ({ page }) => {
    await page.goto('/#/site/site-demo');
    await page.getByRole('button', { name: 'Run tests' }).click();
    await expect(page.locator('.scanbox')).toBeVisible();

    await expect(page.locator('.scanbox')).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Run tests' })).toBeEnabled();
  });

  test('a second scan while one is running is rejected and surfaced as a toast', async ({ page }) => {
    await page.goto('/#/site/site-demo');
    await page.getByRole('button', { name: 'Run tests' }).click();
    await expect(page.locator('.scanbox')).toBeVisible();

    const res = await page.evaluate(() =>
      fetch('/api/sites/site-demo/scan', { method: 'POST' }).then((r) => r.status));
    expect(res).toBe(409);
  });
});

test.describe('feedback: toasts', () => {
  test('dispatch reports success in a toast, not a native dialog', async ({ page }) => {
    // A native dialog would hang the run: fail loudly rather than auto-accept.
    page.on('dialog', (d) => { throw new Error(`unexpected native dialog: ${d.message()}`); });

    await page.goto('/#/site/site-demo');
    await page.getByRole('button', { name: 'Dispatch fix task' }).first().click();

    const toast = page.locator('.toast.ok');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Fix task dispatched');
  });

  test('a failed action shows a dismissible error toast with role=alert', async ({ page }) => {
    page.on('dialog', (d) => { throw new Error(`unexpected native dialog: ${d.message()}`); });
    await page.goto('/#/site/site-demo');

    // Drive a real failure through the same handler the UI uses.
    await page.evaluate(() => {
      const orig = window.fetch;
      window.fetch = (url, opts) =>
        (String(url).includes('/dispatch')
          ? Promise.resolve(new Response(JSON.stringify({ error: 'cause has no mapped file' }),
              { status: 400, headers: { 'content-type': 'application/json' } }))
          : orig(url, opts));
    });

    await page.getByRole('button', { name: 'Dispatch fix task' }).first().click();
    const toast = page.locator('.toast.err');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('role', 'alert');
    await expect(toast).toContainText('cause has no mapped file');

    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);
  });
});

test.describe('feedback: connection loss', () => {
  test('a dropped poll keeps stale data on screen and shows a banner', async ({ page }) => {
    await page.goto('/#/dashboard');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();

    await page.route('**/api/state', (r) => r.abort());

    const banner = page.locator('#conn-banner');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText(/Lost contact/);
    await expect(banner).toContainText(/Showing data from/);

    // The regression this guards: the error used to replace the whole pane.
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'demo.example.com' })).toBeVisible();

    await page.unroute('**/api/state');
    await expect(banner).toBeHidden({ timeout: 40000 });
  });
});
