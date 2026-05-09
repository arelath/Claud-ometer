import fs from 'fs';
import path from 'path';
import { toZipPath } from '@/lib/agent-data/archive';

interface ArchiveWriter {
  file(source: string, data: { name: string }): void;
  directory(source: string, destination: string): void;
}

export function addClaudeDataToArchive(archive: ArchiveWriter, claudeDir: string, prefix: string): void {
  const addFile = (fileName: string) => {
    const filePath = path.join(claudeDir, fileName);
    if (fs.existsSync(filePath)) archive.file(filePath, { name: toZipPath(prefix, fileName) });
  };

  addFile('stats-cache.json');
  addFile('history.jsonl');
  addFile('settings.json');

  const projectsDir = path.join(claudeDir, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const project of fs.readdirSync(projectsDir)) {
      const projectPath = path.join(projectsDir, project);
      if (!fs.statSync(projectPath).isDirectory()) continue;

      for (const file of fs.readdirSync(projectPath)) {
        if (file.endsWith('.jsonl')) {
          archive.file(path.join(projectPath, file), {
            name: toZipPath(prefix, 'projects', project, file),
          });
        }
      }

      const memoryDir = path.join(projectPath, 'memory');
      if (fs.existsSync(memoryDir)) {
        archive.directory(memoryDir, toZipPath(prefix, 'projects', project, 'memory'));
      }
    }
  }

  const plansDir = path.join(claudeDir, 'plans');
  if (fs.existsSync(plansDir)) archive.directory(plansDir, toZipPath(prefix, 'plans'));

  const todosDir = path.join(claudeDir, 'todos');
  if (fs.existsSync(todosDir)) archive.directory(todosDir, toZipPath(prefix, 'todos'));
}
