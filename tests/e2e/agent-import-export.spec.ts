import JSZip from 'jszip';
import { test, expect } from './coverage.fixture';
import { codexRouteId, resetToAllAgents, resetToClaude, restoreImportedFixtureData } from './agent-test-utils';

test.beforeEach(async ({ page }) => {
  await resetToAllAgents(page);
});

test.afterEach(async ({ page }) => {
  restoreImportedFixtureData();
  await resetToClaude(page);
});

test('mixed agent export can be imported and browsed from the app', async ({ page }) => {
  const exportResponse = await page.request.get('/api/export');
  expect(exportResponse.ok()).toBe(true);

  const archiveBuffer = await exportResponse.body();
  const zip = await JSZip.loadAsync(archiveBuffer);
  const names = Object.keys(zip.files);

  expect(names).toContain('agent-data/export-meta.json');
  expect(names.some(name => name.startsWith('agent-data/claude/projects/'))).toBe(true);
  expect(names.some(name => name.startsWith('agent-data/codex/sessions/'))).toBe(true);
  expect(names).not.toContain('agent-data/codex/auth.json');
  expect(names).not.toContain('agent-data/codex/cap_sid');

  const meta = JSON.parse(await zip.file('agent-data/export-meta.json')!.async('string'));
  expect(meta.agents).toEqual(['claude', 'codex']);
  expect(meta.agentCounts.codex.sessionCount).toBe(1);

  const importResponse = await page.request.post('/api/import', {
    multipart: {
      file: {
        name: 'mixed-agent-data.zip',
        mimeType: 'application/zip',
        buffer: archiveBuffer,
      },
    },
  });
  expect(importResponse.ok()).toBe(true);

  const sourceInfo = await (await page.request.get('/api/data-source')).json();
  expect(sourceInfo.active).toBe('imported');
  expect(sourceInfo.agents).toEqual(['claude', 'codex']);
  expect(sourceInfo.importMeta.agentCounts.codex.sessionCount).toBe(1);

  await page.goto('/sessions');
  await expect(page.locator(`main a[href="/sessions/${codexRouteId}"]`)).toBeVisible();
  await expect(page.getByLabel('Claude agent').first()).toBeVisible();
  await expect(page.getByLabel('Codex agent').first()).toBeVisible();
});
