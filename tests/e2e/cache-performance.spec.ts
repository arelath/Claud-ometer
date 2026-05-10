import { test, expect } from './coverage.fixture';
import { resetToAllAgents, resetToClaude } from './agent-test-utils';

test.beforeEach(async ({ page }) => {
  await resetToAllAgents(page);
});

test.afterEach(async ({ page }) => {
  await resetToClaude(page);
});

test('summary cache can be cleared, rebuilt, and reused for aggregate pages', async ({ page }) => {
  const cleared = await page.request.delete('/api/cache');
  expect(cleared.ok()).toBe(true);

  const stats = await page.request.get('/api/stats?agent=all');
  expect(stats.ok()).toBe(true);

  await expect.poll(async () => {
    const status = await (await page.request.get('/api/cache')).json();
    return status.exists && status.summaryCount > 0 && status.validCount > 0;
  }, { timeout: 15_000 }).toBe(true);
  const status = await (await page.request.get('/api/cache')).json();
  expect(status.exists).toBe(true);
  expect(status.summaryCount).toBeGreaterThan(0);
  expect(status.validCount).toBeGreaterThan(0);
  expect(status.summaryCount).toBeGreaterThanOrEqual(status.validCount);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.goto('/costs');
  await expect(page.getByRole('heading', { name: 'Cost Analytics' })).toBeVisible();

  const rebuilt = await (await page.request.post('/api/cache')).json();
  expect(rebuilt.rebuilt).toBeGreaterThan(0);
});
