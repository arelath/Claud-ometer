import { test, expect } from './coverage.fixture';
import { codexRouteId, resetToAllAgents, resetToClaude } from './agent-test-utils';
import { toolPairFixtureSessionId } from '../shared/seed-imported-data';

test.beforeEach(async ({ page }) => {
  await resetToAllAgents(page);
});

test.afterEach(async ({ page }) => {
  await resetToClaude(page);
});

test('search keeps provider identity across Codex, Claude, and combined results', async ({ page }) => {
  await page.goto('/sessions');

  const search = page.getByPlaceholder('Search across all session messages...');
  await search.fill('fixture user text');
  await expect(page).toHaveURL(/\/sessions\?q=fixture\+user\+text|\/sessions\?q=fixture%20user%20text/);
  await expect(page.locator(`main a[href="/sessions/${codexRouteId}"]`)).toBeVisible();
  await expect(page.getByLabel('Codex agent').first()).toBeVisible();

  await search.fill('Context Builder');
  await expect(page.locator(`main a[href="/sessions/${toolPairFixtureSessionId}"]`)).toBeVisible();
  await expect(page.locator(`main a[href="/sessions/${codexRouteId}"]`)).toBeVisible();
  await expect(page.getByLabel('Claude agent').first()).toBeVisible();
  await expect(page.getByLabel('Codex agent').first()).toBeVisible();

  await search.fill('');
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
});
