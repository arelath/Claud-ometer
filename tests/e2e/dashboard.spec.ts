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

test('stored theme is applied before the app hydrates', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('allow-theme-test-reload')) {
      localStorage.setItem('claud-ometer-theme', 'light');
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(async () => (await page.locator('html').getAttribute('class')) || '').not.toContain('dark');
  await expect(page.getByRole('button', { name: 'Dark Mode' })).toBeVisible();

  await page.evaluate(() => {
    sessionStorage.setItem('allow-theme-test-reload', '1');
    localStorage.setItem('claud-ometer-theme', 'dark');
    window.location.reload();
  });

  await expect.poll(async () => (await page.locator('html').getAttribute('class')) || '').toContain('dark');
  await expect(page.getByRole('button', { name: 'Light Mode' })).toBeVisible();
});

test('cost analytics switches estimate modes and persists the selection', async ({ page }) => {
  await page.goto('/costs');

  await expect(page.getByRole('heading', { name: 'Cost Analytics' })).toBeVisible();
  await expect(page.getByText('subscription estimate')).toBeVisible();
  await expect(page.getByText('Pricing Reference (per 1M tokens, API rates)')).toBeVisible();

  await page.getByRole('button', { name: 'API Equivalent' }).click();

  await expect(page.getByText('API Equivalent:')).toBeVisible();
  await expect(page.getByText('api equivalent estimate')).toBeVisible();
  await expect(page.getByText('This shows what your usage would cost at published API rates')).toBeVisible();

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('api equivalent estimate')).toBeVisible();
});

test('projects page links from project summaries to project sessions and session detail', async ({ page }) => {
  await page.goto('/projects');

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByText(/projects tracked/)).toBeVisible();

  const projectLink = page.locator('main a[href^="/projects/"]').first();
  await expect(projectLink).toBeVisible();
  await expect(projectLink).toContainText('sessions');
  await projectLink.click();

  await expect(page).toHaveURL(/\/projects\/fixture-project-/);
  await expect(page.getByText('Top Tools Used')).toBeVisible();

  const sessionLink = page.locator('main a[href^="/sessions/"]').first();
  await expect(sessionLink).toBeVisible();
  await sessionLink.click();

  await expect(page).toHaveURL(/\/sessions\/.+/);
  await expect(page.getByText('Token usage')).toBeVisible();
});
