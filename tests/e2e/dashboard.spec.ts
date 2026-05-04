import { test, expect } from './coverage.fixture';

test('overview and data pages load imported fixture data', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Recent Sessions')).toBeVisible();
  await expect(page.getByText('Imported')).toBeVisible();

  await page.goto('/data');

  await expect(page.getByRole('heading', { name: 'Data Management' })).toBeVisible();
  await expect(page.getByText('Imported Data').first()).toBeVisible();
  await expect(page.getByRole('main').getByText('Fixture data')).toBeVisible();
});