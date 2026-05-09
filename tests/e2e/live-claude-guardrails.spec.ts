import { test, expect } from './coverage.fixture';
import { claudeRouteId, codexRouteId, resetToAllAgents, resetToClaude } from './agent-test-utils';

test.beforeEach(async ({ page }) => {
  await resetToAllAgents(page);
});

test.afterEach(async ({ page }) => {
  await resetToClaude(page);
});

test('live sidebar remains Claude-only and Codex resume paths stay blocked', async ({ page }) => {
  const liveSessions = await (await page.request.get('/api/live-sessions')).json();
  expect(liveSessions.length).toBeGreaterThan(0);
  expect(liveSessions.every((session: { agentKind?: string }) => session.agentKind === 'claude')).toBe(true);

  const codexBinding = await (await page.request.get(`/api/live-sessions/by-session/${encodeURIComponent(codexRouteId)}`)).json();
  expect(codexBinding).toBeNull();

  const resumeResponse = await page.request.post(`/api/sessions/${encodeURIComponent(codexRouteId)}/resume`);
  expect(resumeResponse.status()).toBe(501);
  expect(await resumeResponse.json()).toEqual({ error: 'Codex resume is not supported yet.' });

  await page.goto('/');
  await expect(page.locator('aside').getByText('Live Sessions', { exact: true })).toBeVisible();
  await expect(page.locator('aside').getByText('idle').first()).toBeVisible();

  await page.goto(`/sessions/${codexRouteId}`);
  await expect(page.getByLabel('Codex agent')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume session in Claude' })).toHaveCount(0);
  await expect(page.getByPlaceholder(/Message this live session|Draft a message/i)).toHaveCount(0);

  await page.goto(`/sessions/${claudeRouteId}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Claude agent')).toBeVisible();
});
