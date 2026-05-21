import path from 'path';
import { defineConfig, devices } from '@playwright/test';

const e2eImportDir = path.resolve(__dirname, '.test-artifacts', 'e2e-import');
const e2eHomeDir = path.resolve(__dirname, '.test-artifacts', 'e2e-home');

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
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
      AGENT_SCOPE_IMPORT_DIR: e2eImportDir,
      AGENT_SCOPE_CLAUDE_DIR: path.join(e2eHomeDir, '.claude'),
      AGENT_SCOPE_CODEX_DIR: path.join(e2eHomeDir, '.codex'),
      AGENT_SCOPE_LIVE_SESSIONS_DIR: path.join(e2eHomeDir, '.claude', 'sessions'),
      AGENT_SCOPE_LIVE_PROJECTS_DIR: path.join(e2eHomeDir, '.claude', 'projects'),
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
