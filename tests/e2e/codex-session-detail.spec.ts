import { test, expect } from './coverage.fixture';
import { codexRouteId, resetToClaude, selectImportedAgents } from './agent-test-utils';

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await selectImportedAgents(page.request, ['codex']);
});

test.afterEach(async ({ page }) => {
  await resetToClaude(page);
});

test('Codex session detail renders transcript, tool calls, patch diff, and metadata', async ({ page }) => {
  await page.goto(`/sessions/${codexRouteId}`);

  await expect(page.getByLabel('Codex agent')).toBeVisible();
  await expect(page.getByText('gpt-5.5').first()).toBeVisible();
  await expect(page.getByText('Please add Codex support to the dashboard.')).toBeVisible();
  await expect(page.getByText('I will add a Codex provider and parser.')).toBeVisible();
  await expect(page.getByTestId('assistant-turn').first()).toContainText('Codex');
  await expect(page.getByTestId('assistant-turn').first()).not.toContainText('Claude');
  await expect(page.getByText('Need a provider-neutral parser.').first()).toBeVisible();
  await expect(page.getByText('redacted-fixture')).toHaveCount(0);

  await page.getByRole('button', { name: /\+ Tools/i }).click();
  await expect(page.getByTestId('tool-call-inline').filter({ hasText: 'shell_command' })).toBeVisible();
  await expect(page.getByText('npm run test:unit')).toBeVisible();
  await expect(page.getByText('Tests passed')).toBeVisible();
  await expect(page.getByTestId('tool-call-inline').filter({ hasText: 'apply_patch' })).toBeVisible();
  await expect(page.getByText('Done')).toBeVisible();

  await page.getByRole('button', { name: /Changes\s+1/i }).click();
  await expect(page.getByTestId('session-changes-view')).toBeVisible();
  await expect(page.getByTestId('session-diff-file-row').filter({ hasText: 'example.ts' })).toBeVisible();
  await expect(page.getByTestId('session-diff-viewer')).toContainText('export const oldValue = 1;');
  await expect(page.getByTestId('session-diff-viewer')).toContainText('export const oldValue = 2;');

  await expect(page.getByText('Provider')).toBeVisible();
  await expect(page.getByText('codex', { exact: true })).toBeVisible();
  await expect(page.getByText('Native ID')).toBeVisible();
});
