import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { hasFixtureData, seedImportedData } from './shared/seed-imported-data';

const unitImportDir = path.join(process.cwd(), '.test-artifacts', 'unit-import');
process.env.CLAUD_OMETER_IMPORT_DIR = unitImportDir;
if (hasFixtureData()) {
  seedImportedData(unitImportDir);
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(unitImportDir, { recursive: true, force: true });
});
