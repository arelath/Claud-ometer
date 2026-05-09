import { test, expect } from './coverage.fixture';
import { claudeRouteId, codexRouteId, resetToClaude } from './agent-test-utils';

test.beforeEach(async ({ page }) => {
  await resetToClaude(page);
});

test.afterEach(async ({ page }) => {
  await resetToClaude(page);
});

test('provider switching flow moves between Claude and Codex fixture data', async ({ page }) => {
  await page.goto('/data');

  await expect(page.getByRole('heading', { name: 'Data Management' })).toBeVisible();
  await expect(page.getByLabel('Claude agent').first()).toBeVisible();
  await expect(page.getByLabel('Codex agent').first()).toBeVisible();

  await page.locator('button').filter({ hasText: 'Codex data detected' }).click();
  await expect(page.getByText('Selected Codex data.')).toBeVisible();

  await page.goto('/sessions');
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.locator(`main a[href="/sessions/${codexRouteId}"]`)).toBeVisible();
  await expect(page.getByLabel('Codex agent').first()).toBeVisible();
  await expect(page.getByText('gpt-5.5').first()).toBeVisible();

  await page.locator(`main a[href="/sessions/${codexRouteId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${codexRouteId}$`));
  await expect(page.getByLabel('Codex agent')).toBeVisible();
  await expect(page.getByText('Please add Codex support to the dashboard.')).toBeVisible();

  await page.goto('/data');
  await page.locator('button').filter({ hasText: 'Claude data detected' }).click();
  await expect(page.getByText('Selected Claude data.')).toBeVisible();

  await page.goto('/sessions');
  await expect(page.locator(`main a[href="/sessions/${claudeRouteId}"]`)).toBeVisible();
  await expect(page.getByLabel('Claude agent').first()).toBeVisible();
});
