import fs from 'fs';
import path from 'path';
import { seedImportedData } from '../shared/seed-imported-data';

export default async function globalSetup() {
  const importDir = path.join(process.cwd(), '.test-artifacts', 'e2e-import');
  seedImportedData(importDir);

  fs.rmSync(path.join(process.cwd(), '.test-artifacts', 'e2e-coverage'), { recursive: true, force: true });
  fs.rmSync(path.join(process.cwd(), 'coverage', 'e2e'), { recursive: true, force: true });
  fs.rmSync(path.join(process.cwd(), 'reports', 'playwright'), { recursive: true, force: true });
}
