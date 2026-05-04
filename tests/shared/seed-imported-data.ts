import fs from 'fs';
import path from 'path';

export const fixtureSessionIds = [
  '5f599278-e7e6-4a18-b54f-e4f1c4f6b834',
  'f94b3f9a-85de-4730-877a-7edf4d2244a7',
] as const;

function getFixtureSessionPath(sessionId: string): string {
  return path.join(process.cwd(), 'exampleData', `${sessionId}.jsonl`);
}

export function seedImportedData(importDir: string): void {
  fs.rmSync(importDir, { recursive: true, force: true });

  const claudeDataDir = path.join(importDir, 'claude-data');
  const projectsDir = path.join(claudeDataDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  let totalSize = 0;
  for (const sessionId of fixtureSessionIds) {
    const sourcePath = getFixtureSessionPath(sessionId);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing fixture session: ${sourcePath}`);
    }
    const projectDir = path.join(projectsDir, `fixture-project-${sessionId.slice(0, 8)}`);
    fs.mkdirSync(projectDir, { recursive: true });

    const targetPath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
    totalSize += fs.statSync(targetPath).size;
  }

  const exportMeta = {
    exportedAt: '2026-05-03T00:00:00.000Z',
    exportedFrom: 'Fixture data',
  };

  fs.writeFileSync(
    path.join(claudeDataDir, 'export-meta.json'),
    JSON.stringify(exportMeta, null, 2),
  );

  fs.writeFileSync(
    path.join(importDir, 'meta.json'),
    JSON.stringify({
      importedAt: new Date().toISOString(),
      exportedAt: exportMeta.exportedAt,
      exportedFrom: exportMeta.exportedFrom,
      projectCount: fixtureSessionIds.length,
      sessionCount: fixtureSessionIds.length,
      fileCount: fixtureSessionIds.length + 1,
      totalSize,
    }, null, 2),
  );

  fs.writeFileSync(path.join(importDir, '.use-imported'), '1');
}