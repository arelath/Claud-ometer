import fs from 'fs';
import path from 'path';
import { isExcludedCodexExportPath, toZipPath } from '@/lib/agent-data/archive';

interface ArchiveWriter {
  file(source: string, data: { name: string }): void;
}

function addDirectoryFiles(archive: ArchiveWriter, sourceDir: string, rootDir: string, prefix: string): void {
  if (!fs.existsSync(sourceDir)) return;

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const entryPath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(rootDir, entryPath);
    if (isExcludedCodexExportPath(relativePath)) continue;

    if (entry.isDirectory()) {
      addDirectoryFiles(archive, entryPath, rootDir, prefix);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      archive.file(entryPath, { name: toZipPath(prefix, relativePath) });
    }
  }
}

export function addCodexDataToArchive(archive: ArchiveWriter, codexDir: string, prefix: string): void {
  const sessionsDir = path.join(codexDir, 'sessions');
  addDirectoryFiles(archive, sessionsDir, codexDir, prefix);

  for (const fileName of ['session_index.jsonl', 'version.json']) {
    const filePath = path.join(codexDir, fileName);
    if (fs.existsSync(filePath) && !isExcludedCodexExportPath(fileName)) {
      archive.file(filePath, { name: toZipPath(prefix, fileName) });
    }
  }
}
