import fs from 'fs';
import path from 'path';
import { isExcludedCursorExportPath, toZipPath } from '@/lib/agent-data/archive';
import { getLiveCursorUserDir } from '@/lib/agent-data/data-source';

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

function addTranscriptFiles(archive: ArchiveWriter, dir: string, rootDir: string, prefix: string): void {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.txt'))) {
        addFile(archive, entryPath, rootDir, prefix);
      }
    }
  }
}

function getCursorUserDirForExport(cursorDir: string): string {
  const colocatedDbPath = path.join(cursorDir, 'globalStorage', 'state.vscdb');
  return fs.existsSync(colocatedDbPath) ? cursorDir : getLiveCursorUserDir();
}

function addCursorUserDataToArchive(archive: ArchiveWriter, cursorUserDir: string, prefix: string): void {
  const globalDbPath = path.join(cursorUserDir, 'globalStorage', 'state.vscdb');
  if (fs.existsSync(globalDbPath)) {
    addFile(archive, globalDbPath, cursorUserDir, prefix);
  }

  const workspaceStorageDir = path.join(cursorUserDir, 'workspaceStorage');
  if (!fs.existsSync(workspaceStorageDir)) return;
  for (const workspace of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(workspaceStorageDir, workspace.name);
    for (const fileName of ['workspace.json', 'state.vscdb']) {
      const filePath = path.join(workspaceDir, fileName);
      if (fs.existsSync(filePath)) addFile(archive, filePath, cursorUserDir, prefix);
    }
  }
}

export function addCursorDataToArchive(archive: ArchiveWriter, cursorDir: string, prefix: string): void {
  const projectsDir = getProjectsDir(cursorDir);

  const rootDir = getArchiveRoot(cursorDir, projectsDir);
  if (fs.existsSync(projectsDir)) {
    for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const transcriptsDir = path.join(projectsDir, project.name, 'agent-transcripts');
      if (!fs.existsSync(transcriptsDir)) continue;

      addTranscriptFiles(archive, transcriptsDir, rootDir, prefix);
    }
  }

  addCursorUserDataToArchive(archive, getCursorUserDirForExport(cursorDir), prefix);
}
