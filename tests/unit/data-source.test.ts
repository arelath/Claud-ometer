import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('data source helpers', () => {
  const importDir = path.join(process.cwd(), '.test-artifacts', 'data-source-import');

  beforeEach(() => {
    fs.rmSync(importDir, { recursive: true, force: true });
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(importDir, { recursive: true, force: true });
  });

  it('uses the import-dir override and only activates imported mode when metadata exists', async () => {
    const module = await import('@/lib/claude-data/data-source');

    expect(module.getImportDir()).toBe(importDir);
    module.setDataSource('imported');
    expect(module.getActiveDataSource()).toBe('live');

    fs.writeFileSync(path.join(importDir, 'meta.json'), JSON.stringify({ importedAt: 'now' }));
    module.setDataSource('imported');

    expect(module.hasImportedData()).toBe(true);
    expect(module.getActiveDataSource()).toBe('imported');
  });

  it('clears imported data recursively', async () => {
    const module = await import('@/lib/claude-data/data-source');

    fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(path.join(importDir, 'meta.json'), '{}');
    fs.writeFileSync(path.join(importDir, '.use-imported'), '1');

    module.clearImportedData();

    expect(fs.existsSync(importDir)).toBe(false);
  });
});