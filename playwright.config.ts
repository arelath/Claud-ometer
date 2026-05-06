import path from 'path';
import { defineConfig, devices } from '@playwright/test';

const e2eImportDir = path.resolve(__dirname, '.test-artifacts', 'e2e-import');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/playwright', open: 'never' }],
    ['junit', { outputFile: 'reports/playwright/junit.xml' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:3005',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  globalSetup: './tests/e2e/global.setup.ts',
  globalTeardown: './tests/e2e/global.teardown.ts',
  webServer: {
    command: 'node .next/standalone/server.js',
    url: 'http://127.0.0.1:3005',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      HOSTNAME: '127.0.0.1',
      PORT: '3005',
      CLAUD_OMETER_IMPORT_DIR: e2eImportDir,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
