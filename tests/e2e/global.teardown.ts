import fs from 'fs';
import path from 'path';
import type { FullConfig } from '@playwright/test';
import { CoverageReport } from 'monocart-coverage-reports';

export default async function globalTeardown(_config: FullConfig) {
  const rawDir = path.join(process.cwd(), '.test-artifacts', 'e2e-coverage', 'raw');
  if (!fs.existsSync(rawDir)) return;

  const entries = fs.readdirSync(rawDir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf-8')) as unknown[]);

  if (entries.length === 0) return;

  const report = new CoverageReport({
    name: 'Playwright E2E Coverage',
    outputDir: path.join(process.cwd(), 'coverage', 'e2e'),
    clean: true,
    reports: [
      ['v8'],
      ['json-summary', { file: 'coverage-summary.json' }],
      ['console-summary'],
    ],
    sourceFilter: (sourcePath: string) => /[/\\]src[/\\]/.test(sourcePath) && !/[/\\]node_modules[/\\]/.test(sourcePath),
    all: ['src/**/*.{ts,tsx}'],
  });

  await report.add(entries as never);
  await report.generate();
}