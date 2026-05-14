import fs from 'fs';
import path from 'path';
import { isExcludedCursorExportPath, toZipPath } from '@/lib/agent-data/archive';

interface ArchiveWriter {
  file(source: string, data: { name: string }): void;
}

function getProjectsDir(cursorDir: string): string {
  return path.basename(cursorDir).toLowerCase() === 'projects'
    ? cursorDir
    : path.join(cursorDir, 'projects');
}

function getArchiveRoot(cursorDir: string, projectsDir: string): string {
  return path.basename(cursorDir).toLowerCase() === 'projects'
    ? path.dirname(projectsDir)
    : cursorDir;
}

function addFile(archive: ArchiveWriter, filePath: string, rootDir: string, prefix: string): void {
  const relativePath = path.relative(rootDir, filePath);
  if (isExcludedCursorExportPath(relativePath)) return;
  archive.file(filePath, { name: toZipPath(prefix, relativePath) });
}

export function addCursorDataToArchive(archive: ArchiveWriter, cursorDir: string, prefix: string): void {
  const projectsDir = getProjectsDir(cursorDir);
  if (!fs.existsSync(projectsDir)) return;

  const rootDir = getArchiveRoot(cursorDir, projectsDir);
  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const transcriptsDir = path.join(projectsDir, project.name, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;

    for (const session of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(transcriptsDir, session.name);
      for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          addFile(archive, path.join(sessionDir, entry.name), rootDir, prefix);
        }
      }
    }
  }
}
