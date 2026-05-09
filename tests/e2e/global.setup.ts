import fs from 'fs';
import path from 'path';
import { seedImportedData, seedLiveAgentHomes } from '../shared/seed-imported-data';

export default async function globalSetup() {
  const importDir = path.join(process.cwd(), '.test-artifacts', 'e2e-import');
  const homeDir = path.join(process.cwd(), '.test-artifacts', 'e2e-home');
  seedImportedData(importDir);
  seedLiveAgentHomes(homeDir);

  fs.rmSync(path.join(process.cwd(), '.test-artifacts', 'e2e-coverage'), { recursive: true, force: true });
  fs.rmSync(path.join(process.cwd(), 'coverage', 'e2e'), { recursive: true, force: true });
  fs.rmSync(path.join(process.cwd(), 'reports', 'playwright'), { recursive: true, force: true });
}
