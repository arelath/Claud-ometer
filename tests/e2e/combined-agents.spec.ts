import { test, expect } from './coverage.fixture';
import { resetToAllAgents, resetToClaude } from './agent-test-utils';

test.beforeEach(async ({ page }) => {
  await resetToAllAgents(page);
});

test.afterEach(async ({ page }) => {
  await resetToClaude(page);
});

test('combined agents overview and costs include Claude and Codex data', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Your agent usage at a glance')).toBeVisible();
  await expect(page.getByText('Total Sessions')).toBeVisible();
  await expect(page.getByLabel('Claude agent').first()).toBeVisible();
  await expect(page.getByLabel('Codex agent').first()).toBeVisible();
  await expect(page.getByText('gpt-5.5').first()).toBeVisible();
  await expect(page.getByText('Model Usage')).toBeVisible();

  const stats = await (await page.request.get('/api/stats?agent=all')).json();
  expect(stats.totalSessions).toBeGreaterThanOrEqual(5);
  expect(stats.projectCount).toBeGreaterThanOrEqual(4);
  expect(Object.keys(stats.modelUsage)).toContain('gpt-5.5');

  await page.goto('/costs');
  await expect(page.getByRole('heading', { name: 'Cost Analytics' })).toBeVisible();
  await expect(page.getByText('Estimated Cost by Model')).toBeVisible();
  await expect(page.getByText('gpt-5.5').first()).toBeVisible();
  await expect(page.getByText('OpenAI').first()).toBeVisible();
});
