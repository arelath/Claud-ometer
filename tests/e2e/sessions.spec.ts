import { test, expect } from './coverage.fixture';
import { fixtureSessionIds } from '../shared/seed-imported-data';

test('sessions page supports search and navigation to session detail', async ({ page }) => {
  await page.goto('/sessions');

  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.locator(`a[href="/sessions/${fixtureSessionIds[0]}"]`)).toBeVisible();

  const search = page.getByPlaceholder('Search across all session messages...');
  await search.fill('Context Builder');

  await expect(page).toHaveURL(/\/sessions\?q=Context\+Builder|\/sessions\?q=Context%20Builder/);
  await expect(page.getByText(/session matching "Context Builder"/i)).toBeVisible();

  const filteredResult = page.locator('a[href^="/sessions/"]').first();
  await expect(filteredResult).toBeVisible();
  await filteredResult.click();
  await expect(page).toHaveURL(/\/sessions\/.+/);
  await expect(page.getByText('Token usage')).toBeVisible();
  await page.getByRole('button', { name: 'Window' }).click();
  await expect(page.getByText('current prompt')).toBeVisible();
  await expect(page.getByText('Files', { exact: true })).toBeVisible();
  await expect(page.getByText('Tools', { exact: true })).toBeVisible();
  await expect(page.getByText('Files in context')).toBeVisible();
});

test('session detail renders multiline tool output and theme toggle persists', async ({ page }) => {
  await page.goto(`/sessions/${fixtureSessionIds[0]}`);

  await expect(page.getByRole('button', { name: /Narrative/i })).toBeVisible();
  const html = page.locator('html');
  const initialIsDark = ((await html.getAttribute('class')) || '').includes('dark');

  const themeToggle = page.getByRole('button', { name: /Light Mode|Dark Mode/i });
  await themeToggle.click();
  await expect.poll(async () => (((await html.getAttribute('class')) || '').includes('dark'))).toBe(!initialIsDark);

  await page.getByRole('button', { name: /\+ Tools/i }).click();

  const expandPreviewButton = page.getByRole('button', { name: 'Expand' }).first();
  await expect(expandPreviewButton).toBeVisible();
  await expandPreviewButton.click();
  await expect(page.locator('*:visible').filter({ hasText: 'Everything else is deferred until a real run demands it.' }).first()).toBeVisible();

  await page.goto('/data');
  await expect.poll(async () => (((await page.locator('html').getAttribute('class')) || '').includes('dark'))).toBe(!initialIsDark);
});
