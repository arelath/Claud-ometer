import fs from 'fs';
import path from 'path';
import os from 'os';

function resolveImportDir(): string {
  return process.env.CLAUD_OMETER_IMPORT_DIR?.trim() || path.join(process.cwd(), '.dashboard-data');
}

function getImportMetaPath(): string {
  return path.join(resolveImportDir(), 'meta.json');
}

export interface ImportMeta {
  importedAt: string;
  exportedAt: string;
  exportedFrom: string;
  projectCount: number;
  sessionCount: number;
}

export function getImportDir(): string {
  return resolveImportDir();
}

export function hasImportedData(): boolean {
  return fs.existsSync(getImportMetaPath());
}

export function getImportMeta(): ImportMeta | null {
  const metaPath = getImportMetaPath();
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
}

export function getActiveDataSource(): 'live' | 'imported' {
  const flagPath = path.join(resolveImportDir(), '.use-imported');
  if (fs.existsSync(flagPath) && hasImportedData()) return 'imported';
  return 'live';
}

export function setDataSource(source: 'live' | 'imported') {
  const importDir = resolveImportDir();
  const flagPath = path.join(importDir, '.use-imported');
  if (source === 'imported') {
    if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(flagPath, '1');
  } else {
    if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
  }
}

export function clearImportedData() {
  const importDir = resolveImportDir();
  if (fs.existsSync(importDir)) {
    fs.rmSync(importDir, { recursive: true, force: true });
  }
}

export function getLiveClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}
