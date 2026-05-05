import fs from 'fs/promises';
import path from 'path';
import { test as base, expect } from '@playwright/test';

const rawCoverageDir = path.join(process.cwd(), '.test-artifacts', 'e2e-coverage', 'raw');

export const test = base.extend({
  page: async ({ page, browserName }, run, testInfo) => {
    if (browserName === 'chromium') {
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        reportAnonymousScripts: true,
      });
    }

    await run(page);

    if (browserName === 'chromium') {
      const coverage = await page.coverage.stopJSCoverage();
      await fs.mkdir(rawCoverageDir, { recursive: true });
      const safeName = `${testInfo.file.replace(/[^a-zA-Z0-9]+/g, '-')}-${testInfo.title.replace(/[^a-zA-Z0-9]+/g, '-')}-${testInfo.retry}.json`;
      await fs.writeFile(path.join(rawCoverageDir, safeName), JSON.stringify(coverage, null, 2));
    }
  },
});

export { expect };
