import fs from 'fs';
import path from 'path';
import { isExcludedCopilotExportPath, toZipPath } from '@/lib/agent-data/archive';
import { isCopilotChatSessionFile } from './chat-session';

interface ArchiveWriter {
  file(source: string, data: { name: string }): void;
}

function getWorkspaceStorageDir(copilotDir: string): string {
  return path.basename(copilotDir).toLowerCase() === 'workspacestorage'
    ? copilotDir
    : path.join(copilotDir, 'workspaceStorage');
}

function getArchiveRoot(copilotDir: string, workspaceStorageDir: string): string {
  return path.basename(copilotDir).toLowerCase() === 'workspacestorage'
    ? path.dirname(workspaceStorageDir)
    : copilotDir;
}

function addFile(archive: ArchiveWriter, filePath: string, rootDir: string, prefix: string): void {
  const relativePath = path.relative(rootDir, filePath);
  if (isExcludedCopilotExportPath(relativePath)) return;
  archive.file(filePath, { name: toZipPath(prefix, relativePath) });
}

export function addCopilotDataToArchive(archive: ArchiveWriter, copilotDir: string, prefix: string): void {
  const workspaceStorageDir = getWorkspaceStorageDir(copilotDir);
  if (!fs.existsSync(workspaceStorageDir)) return;

  const rootDir = getArchiveRoot(copilotDir, workspaceStorageDir);
  for (const workspace of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(workspaceStorageDir, workspace.name);
    const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
    if (fs.existsSync(workspaceJsonPath)) {
      addFile(archive, workspaceJsonPath, rootDir, prefix);
    }

    const transcriptsDir = path.join(workspaceDir, 'GitHub.copilot-chat', 'transcripts');
    const exportedChatSessions = new Set<string>();
    if (fs.existsSync(transcriptsDir)) {
      for (const entry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          addFile(archive, path.join(transcriptsDir, entry.name), rootDir, prefix);
          const chatSessionPath = path.join(workspaceDir, 'chatSessions', entry.name);
          if (fs.existsSync(chatSessionPath)) {
            addFile(archive, chatSessionPath, rootDir, prefix);
            exportedChatSessions.add(entry.name);
          }
        }
      }
    }

    const chatSessionsDir = path.join(workspaceDir, 'chatSessions');
    if (!fs.existsSync(chatSessionsDir)) continue;
    for (const entry of fs.readdirSync(chatSessionsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && !exportedChatSessions.has(entry.name)) {
        const chatSessionPath = path.join(chatSessionsDir, entry.name);
        if (isCopilotChatSessionFile(chatSessionPath)) {
          addFile(archive, chatSessionPath, rootDir, prefix);
        }
      }
    }
  }
}
