import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { calculateCostAllModes, getModelDisplayName, DEFAULT_COST_MODE } from '@/config/pricing';
import { getActiveDataSource, getImportDir } from './data-source';
import type {
  StatsCache,
  HistoryEntry,
  ProjectInfo,
  SessionInfo,
  SessionDetail,
  SessionMessageBlockDisplay,
  SessionMessageDisplay,
  SessionToolCallDisplay,
  DashboardStats,
  DailyActivity,
  DailyModelTokens,
  TokenUsage,
  SessionMessage,
  CostEstimates,
} from './types';

function zeroCosts(): CostEstimates {
  return { api: 0, conservative: 0, subscription: 0 };
}

function addCosts(a: CostEstimates, b: CostEstimates): CostEstimates {
  return {
    api: a.api + b.api,
    conservative: a.conservative + b.conservative,
    subscription: a.subscription + b.subscription,
  };
}

async function forEachJsonlLine(filePath: string, callback: (msg: SessionMessage) => void): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as SessionMessage;
      callback(msg);
    } catch { /* skip malformed line */ }
  }
}

function getClaudeDir(): string {
  if (getActiveDataSource() === 'imported') {
    return path.join(getImportDir(), 'claude-data');
  }
  return path.join(os.homedir(), '.claude');
}

function getProjectsDir(): string {
  return path.join(getClaudeDir(), 'projects');
}

const TOOL_DETAIL_LABELS: Record<string, string> = {
  args: 'Args',
  addedNames: 'Added',
  command: 'Command',
  content: 'Content',
  'content.file.filePath': 'File',
  'content.file.numLines': 'Lines',
  'content.file.totalLines': 'Total lines',
  displayPath: 'Display path',
  endLine: 'End line',
  exitCode: 'Exit code',
  filename: 'Filename',
  file_path: 'File',
  filePath: 'File',
  file_text: 'Content',
  goal: 'Goal',
  hookCount: 'Hook count',
  hookInfos: 'Hooks',
  includePattern: 'Include',
  lastPrompt: 'Prompt',
  leafUuid: 'Leaf UUID',
  level: 'Level',
  lineContent: 'Line match',
  max_results: 'Max results',
  maxResults: 'Max results',
  messageCount: 'Message count',
  messageId: 'Message ID',
  mode: 'Mode',
  newString: 'New text',
  new_string: 'New text',
  newName: 'New name',
  oldString: 'Old text',
  old_string: 'Old text',
  originalFile: 'Original file',
  path: 'Path',
  paths: 'Paths',
  permissionMode: 'Permission mode',
  promptText: 'Prompt',
  query: 'Query',
  replace_all: 'Replace all',
  removedNames: 'Removed',
  scope: 'Scope',
  selector: 'Selector',
  signature: 'Signature',
  skillCount: 'Skills',
  sourceToolAssistantUUID: 'Source assistant',
  startLine: 'Start line',
  stderr: 'Stderr',
  stdout: 'Stdout',
  symbol: 'Symbol',
  thinking: 'Thinking',
  timeout: 'Timeout',
  tool_use_id: 'Tool call',
  toolUseId: 'Tool call',
  durationMs: 'Duration',
  url: 'URL',
};

const TOOL_DETAIL_PRIORITY: Record<string, string[]> = {
  Bash: ['command', 'goal', 'mode', 'timeout'],
  Edit: ['file_path', 'replace_all', 'old_string', 'new_string'],
  Read: ['file_path', 'startLine', 'endLine'],
  ToolSearch: ['query', 'max_results'],
  Write: ['file_path', 'content'],
};

const COMMON_TOOL_DETAIL_KEYS = [
  'file_path',
  'filePath',
  'path',
  'paths',
  'command',
  'query',
  'goal',
  'mode',
  'url',
  'selector',
  'symbol',
  'newName',
  'scope',
  'includePattern',
  'lineContent',
  'args',
  'startLine',
  'endLine',
  'replace_all',
  'max_results',
  'maxResults',
];

const LARGE_TEXT_TOOL_KEYS = new Set(['code', 'content', 'file_text', 'new_string', 'old_string']);
const FILE_LIKE_TOOL_KEYS = new Set(['file_path', 'filePath', 'path', 'paths']);

const STRUCTURED_DETAIL_KEYS = [
  'type',
  'subtype',
  'permissionMode',
  'filePath',
  'file_path',
  'path',
  'displayPath',
  'filename',
  'content.file.filePath',
  'content.file.numLines',
  'content.file.totalLines',
  'query',
  'command',
  'tool_use_id',
  'toolUseId',
  'sourceToolAssistantUUID',
  'messageId',
  'leafUuid',
  'durationMs',
  'messageCount',
  'exitCode',
  'level',
  'matches',
  'addedNames',
  'removedNames',
  'hookCount',
  'hookInfos',
  'skillCount',
];

const LARGE_TEXT_DETAIL_KEYS = new Set([
  ...LARGE_TEXT_TOOL_KEYS,
  'content',
  'lastPrompt',
  'newString',
  'oldString',
  'originalFile',
  'signature',
  'stderr',
  'stdout',
  'thinking',
]);

const PREVIEW_TEXT_DETAIL_KEYS = new Set(['content', 'lastPrompt', 'stderr', 'stdout', 'text', 'thinking']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getDetailKeyTail(key: string): string {
  const parts = key.split('.');
  return parts[parts.length - 1] || key;
}

function humanizeToolKey(key: string): string {
  return key
    .replace(/\./g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, char => char.toUpperCase());
}

function truncateInline(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function summarizeLargeText(value: string): string {
  const lineCount = value.split(/\r\n?|\n/).length;
  if (lineCount > 1) return `${lineCount.toLocaleString()} lines`;
  return `${value.length.toLocaleString()} chars`;
}

function formatToolDetailValue(key: string, value: unknown): string | null {
  if (value == null) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '""';
    if (LARGE_TEXT_TOOL_KEYS.has(key)) return summarizeLargeText(trimmed);
    return truncateInline(trimmed);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const primitiveValues = value.filter(item => item != null).map(item => {
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'number' || typeof item === 'boolean') return String(item);
      return null;
    }).filter(Boolean) as string[];

    if (primitiveValues.length === value.length) {
      const joined = FILE_LIKE_TOOL_KEYS.has(key) ? primitiveValues.join('\n') : primitiveValues.join(', ');
      if (joined.length <= 220) return truncateInline(joined, 220);
      return `${value.length.toLocaleString()} items`;
    }

    return `${value.length.toLocaleString()} items`;
  }

  if (typeof value === 'object') {
    const fieldCount = Object.keys(value as Record<string, unknown>).length;
    return fieldCount === 0 ? '{}' : `${fieldCount.toLocaleString()} fields`;
  }

  return null;
}

function buildToolCallDetails(name: string, input: unknown): SessionToolCallDisplay['details'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const singleValue = formatToolDetailValue('input', input);
    return singleValue ? [{ key: 'input', label: 'Input', value: singleValue }] : [];
  }

  const inputObject = input as Record<string, unknown>;
  const candidateKeys = [
    ...(TOOL_DETAIL_PRIORITY[name] || []),
    ...COMMON_TOOL_DETAIL_KEYS,
    ...Object.keys(inputObject),
  ];

  const details: SessionToolCallDisplay['details'] = [];
  const seenKeys = new Set<string>();

  for (const key of candidateKeys) {
    if (seenKeys.has(key) || !(key in inputObject)) continue;

    const value = formatToolDetailValue(key, inputObject[key]);
    if (!value) continue;

    details.push({
      key,
      label: TOOL_DETAIL_LABELS[key] || humanizeToolKey(key),
      value,
    });
    seenKeys.add(key);

    if (details.length >= 6) break;
  }

  return details;
}

function buildToolCallSummary(name: string, details: SessionToolCallDisplay['details']): string {
  const primaryDetail =
    details.find(detail => FILE_LIKE_TOOL_KEYS.has(detail.key)) ||
    details.find(detail => detail.key === 'command') ||
    details.find(detail => detail.key === 'query') ||
    details[0];

  if (!primaryDetail) return name;

  if (name === 'Read') {
    const startLine = details.find(detail => detail.key === 'startLine')?.value;
    const endLine = details.find(detail => detail.key === 'endLine')?.value;
    if (startLine || endLine) {
      const rangeStart = startLine || '?';
      const rangeEnd = endLine || '?';
      return `${primaryDetail.value} (${rangeStart}-${rangeEnd})`;
    }
  }

  return primaryDetail.value;
}

function buildToolCallDisplay(name: string, id: string, input: unknown): SessionToolCallDisplay {
  const details = buildToolCallDetails(name, input);
  return {
    name,
    id,
    summary: buildToolCallSummary(name, details),
    details,
  };
}

function toPreviewText(text: string, maxLength = 2_000): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}\n\n[truncated ${text.length.toLocaleString()} chars]`;
}

function flattenStructuredRecord(
  record: Record<string, unknown>,
  prefix = '',
  depth = 0,
): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (value == null) continue;

    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value) && depth < 2) {
      Object.assign(flattened, flattenStructuredRecord(value, nextKey, depth + 1));
      continue;
    }

    flattened[nextKey] = value;
  }

  return flattened;
}

function formatStructuredDetailValue(key: string, value: unknown): string | null {
  const keyTail = getDetailKeyTail(key);

  if (value == null) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '""';

    if (keyTail === 'signature') {
      return `${truncateInline(trimmed, 72)} (${trimmed.length.toLocaleString()} chars)`;
    }

    if (LARGE_TEXT_DETAIL_KEYS.has(keyTail)) return summarizeLargeText(trimmed);
    return truncateInline(trimmed, 220);
  }

  if (typeof value === 'number') {
    if (keyTail === 'durationMs') return `${value.toLocaleString()} ms`;
    return value.toLocaleString();
  }

  if (typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';

    const primitiveValues = value
      .map(item => {
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'number' || typeof item === 'boolean') return String(item);
        return null;
      })
      .filter(Boolean) as string[];

    if (primitiveValues.length === value.length) {
      const joined = FILE_LIKE_TOOL_KEYS.has(keyTail) ? primitiveValues.join('\n') : primitiveValues.join(', ');
      return joined.length <= 220 ? truncateInline(joined, 220) : `${value.length.toLocaleString()} items`;
    }

    return `${value.length.toLocaleString()} items`;
  }

  if (isRecord(value)) {
    const fieldCount = Object.keys(value).length;
    return fieldCount === 0 ? '{}' : `${fieldCount.toLocaleString()} fields`;
  }

  return null;
}

function buildStructuredDetails(
  value: unknown,
  priorityKeys: string[] = STRUCTURED_DETAIL_KEYS,
  maxDetails = 8,
): SessionToolCallDisplay['details'] {
  if (!isRecord(value)) {
    const singleValue = formatStructuredDetailValue('value', value);
    return singleValue ? [{ key: 'value', label: 'Value', value: singleValue }] : [];
  }

  const flattened = flattenStructuredRecord(value);
  const details: SessionToolCallDisplay['details'] = [];
  const seenKeys = new Set<string>();

  for (const key of [...priorityKeys, ...Object.keys(flattened)]) {
    if (seenKeys.has(key) || !(key in flattened)) continue;

    const detailValue = formatStructuredDetailValue(key, flattened[key]);
    if (!detailValue) continue;

    details.push({
      key,
      label: TOOL_DETAIL_LABELS[key] || TOOL_DETAIL_LABELS[getDetailKeyTail(key)] || humanizeToolKey(key),
      value: detailValue,
    });
    seenKeys.add(key);

    if (details.length >= maxDetails) break;
  }

  return details;
}

function extractTextPreview(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? toPreviewText(trimmed) : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(item => {
        if (typeof item === 'string') return item.trim();
        if (isRecord(item)) {
          if (typeof item.text === 'string') return item.text.trim();
          if (typeof item.content === 'string') return item.content.trim();
          if (typeof item.tool_name === 'string') return item.tool_name;
          if (typeof item.toolName === 'string') return item.toolName;
        }
        return '';
      })
      .filter(Boolean);

    if (parts.length === 0) return undefined;
    const separator = parts.some(part => part.includes('\n')) ? '\n' : ', ';
    return toPreviewText(parts.join(separator));
  }

  if (isRecord(value)) {
    if (typeof value.text === 'string') return extractTextPreview(value.text);
    if (typeof value.content === 'string') return extractTextPreview(value.content);
  }

  return undefined;
}

function buildStructuredContent(value: unknown): string | undefined {
  const directPreview = extractTextPreview(value);
  if (directPreview) return directPreview;

  if (!isRecord(value)) return undefined;

  const flattened = flattenStructuredRecord(value);
  for (const key of Object.keys(flattened)) {
    if (!PREVIEW_TEXT_DETAIL_KEYS.has(getDetailKeyTail(key))) continue;
    const preview = extractTextPreview(flattened[key]);
    if (preview) return preview;
  }

  return undefined;
}

function detailKeyMatches(key: string, candidates: string[]): boolean {
  const keyTail = getDetailKeyTail(key);
  return candidates.includes(key) || candidates.includes(keyTail);
}

function buildStructuredSummary(
  title: string,
  details: SessionToolCallDisplay['details'],
  content?: string,
): string {
  if (content) return truncateInline(content, 160);

  const fileDetail = details.find(detail =>
    detailKeyMatches(detail.key, ['displayPath', 'filePath', 'file_path', 'filename', 'path']),
  );
  const typeDetail = details.find(detail =>
    detailKeyMatches(detail.key, ['type', 'subtype', 'permissionMode', 'query', 'command']),
  );

  if (typeDetail && fileDetail) return `${typeDetail.value}: ${fileDetail.value}`;
  if (fileDetail) return fileDetail.value;
  if (typeDetail) return typeDetail.value;
  return details[0]?.value || title;
}

function buildToolResultBlock(
  toolResultContent: Record<string, unknown> | undefined,
  toolUseResult: Record<string, unknown> | undefined,
  sourceToolAssistantUUID?: string,
): SessionMessageBlockDisplay {
  const details = buildStructuredDetails(toolUseResult || toolResultContent, [
    'type',
    'filePath',
    'path',
    'displayPath',
    'filename',
    'content.file.filePath',
    'content.file.numLines',
    'content.file.totalLines',
    'query',
    'matches',
    'addedNames',
    'removedNames',
    'oldString',
    'newString',
    'originalFile',
  ]);

  if (toolResultContent && typeof toolResultContent.tool_use_id === 'string') {
    details.unshift({
      key: 'tool_use_id',
      label: TOOL_DETAIL_LABELS.tool_use_id,
      value: toolResultContent.tool_use_id,
    });
  }

  if (sourceToolAssistantUUID) {
    details.push({
      key: 'sourceToolAssistantUUID',
      label: TOOL_DETAIL_LABELS.sourceToolAssistantUUID,
      value: sourceToolAssistantUUID,
    });
  }

  const content =
    extractTextPreview(toolResultContent?.content) ||
    buildStructuredContent(toolUseResult) ||
    buildStructuredContent(toolResultContent);

  const title = toolUseResult && typeof toolUseResult.type === 'string'
    ? humanizeToolKey(toolUseResult.type)
    : 'Tool Result';

  return {
    type: 'tool-result',
    title,
    summary: buildStructuredSummary(title, details, content),
    details,
    content,
  };
}

function buildThinkingBlock(contentBlock: Record<string, unknown>): SessionMessageBlockDisplay | null {
  const thinkingText = typeof contentBlock.thinking === 'string' ? contentBlock.thinking.trim() : '';
  const signature = typeof contentBlock.signature === 'string' ? contentBlock.signature.trim() : '';
  const details: SessionToolCallDisplay['details'] = [];

  if (thinkingText) {
    details.push({
      key: 'thinking',
      label: TOOL_DETAIL_LABELS.thinking,
      value: summarizeLargeText(thinkingText),
    });
  }

  if (signature) {
    details.push({
      key: 'signature',
      label: TOOL_DETAIL_LABELS.signature,
      value: formatStructuredDetailValue('signature', signature) || 'Present',
    });
  }

  if (details.length === 0) return null;

  return {
    type: 'thinking',
    title: 'Thinking',
    summary: thinkingText ? summarizeLargeText(thinkingText) : '',
    details,
    content: thinkingText ? toPreviewText(thinkingText) : undefined,
  };
}

function buildEventBlock(msg: SessionMessage): SessionMessageBlockDisplay | null {
  if (msg.type === 'attachment' && msg.attachment) {
    const attachmentType = typeof msg.attachment.type === 'string' ? msg.attachment.type : 'attachment';
    const details = buildStructuredDetails(msg.attachment, [
      'type',
      'displayPath',
      'filename',
      'content.file.filePath',
      'content.file.numLines',
      'content.file.totalLines',
      'skillCount',
      'addedNames',
      'removedNames',
    ]);
    const content = buildStructuredContent(msg.attachment);
    const title = `Attachment: ${humanizeToolKey(attachmentType)}`;

    return {
      type: 'event',
      title,
      summary: buildStructuredSummary(title, details, content),
      details,
      content,
    };
  }

  const eventRecord: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(msg)) {
    if (value == null) continue;
    if (['attachment', 'compactMetadata', 'data', 'message', 'microcompactMetadata', 'toolUseResult'].includes(key)) continue;
    eventRecord[key] = value;
  }

  if (Object.keys(eventRecord).length === 0) return null;

  const title = msg.type === 'system'
    ? `System: ${humanizeToolKey(msg.subtype || 'event')}`
    : humanizeToolKey(msg.type);
  const details = buildStructuredDetails(eventRecord, [
    'subtype',
    'permissionMode',
    'messageId',
    'leafUuid',
    'durationMs',
    'messageCount',
    'level',
    'exitCode',
    'command',
    'hookCount',
    'toolUseID',
  ]);
  const content = buildStructuredContent(eventRecord);

  return {
    type: 'event',
    title,
    summary: buildStructuredSummary(title, details, content),
    details,
    content,
  };
}

export function getStatsCache(): StatsCache | null {
  const statsPath = path.join(getClaudeDir(), 'stats-cache.json');
  if (!fs.existsSync(statsPath)) return null;
  return JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
}

export function getHistory(): HistoryEntry[] {
  const historyPath = path.join(getClaudeDir(), 'history.jsonl');
  if (!fs.existsSync(historyPath)) return [];
  const lines = fs.readFileSync(historyPath, 'utf-8').split('\n').filter(Boolean);
  return lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean) as HistoryEntry[];
}

function projectIdToName(id: string): string {
  const decoded = id.replace(/^-/, '/').replace(/-/g, '/');
  const parts = decoded.split('/');
  return parts[parts.length - 1] || id;
}

function projectIdToFullPath(id: string): string {
  return id.replace(/^-/, '/').replace(/-/g, '/');
}

function extractCwdFromSession(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192); // Read first 8KB, enough for first few lines
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);
    const text = buffer.toString('utf-8', 0, bytesRead);
    const lines = text.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.cwd) return msg.cwd;
      } catch { /* skip partial line */ }
    }
  } catch { /* skip */ }
  return null;
}

function getProjectNameFromDir(projectPath: string, projectId: string): { name: string; fullPath: string } {
  const jsonlFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
  if (jsonlFiles.length > 0) {
    const cwd = extractCwdFromSession(path.join(projectPath, jsonlFiles[0]));
    if (cwd) return { name: path.basename(cwd), fullPath: cwd };
  }
  return { name: projectIdToName(projectId), fullPath: projectIdToFullPath(projectId) };
}

export async function getProjects(): Promise<ProjectInfo[]> {
  if (!fs.existsSync(getProjectsDir())) return [];
  const entries = fs.readdirSync(getProjectsDir());
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const jsonlFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;

    let totalMessages = 0;
    let totalTokens = 0;
    let estimatedCosts = zeroCosts();
    let lastActive = '';
    const modelsSet = new Set<string>();

    for (const file of jsonlFiles) {
      const filePath = path.join(projectPath, file);
      const stat = fs.statSync(filePath);
      const mtime = stat.mtime.toISOString();
      if (!lastActive || mtime > lastActive) lastActive = mtime;

      await forEachJsonlLine(filePath, (msg) => {
        if (msg.type === 'user') totalMessages++;
        if (msg.type === 'assistant') {
          totalMessages++;
          const model = msg.message?.model || '';
          if (model) modelsSet.add(model);
          const usage = msg.message?.usage;
          if (usage) {
            const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) +
              (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
            totalTokens += tokens;
            const costs = calculateCostAllModes(
              model,
              usage.input_tokens || 0,
              usage.output_tokens || 0,
              usage.cache_creation_input_tokens || 0,
              usage.cache_read_input_tokens || 0
            );
            estimatedCosts = addCosts(estimatedCosts, costs);
          }
        }
      });
    }

    const firstSessionPath = path.join(projectPath, jsonlFiles[0]);
    const cwd = extractCwdFromSession(firstSessionPath);

    projects.push({
      id: entry,
      name: cwd ? path.basename(cwd) : projectIdToName(entry),
      path: cwd || projectIdToFullPath(entry),
      sessionCount: jsonlFiles.length,
      totalMessages,
      totalTokens,
      estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
      estimatedCosts,
      lastActive,
      models: Array.from(modelsSet).map(getModelDisplayName),
    });
  }

  return projects.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

export async function getProjectSessions(projectId: string): Promise<SessionInfo[]> {
  const projectPath = path.join(getProjectsDir(), projectId);
  if (!fs.existsSync(projectPath)) return [];

  const { name: projectName } = getProjectNameFromDir(projectPath, projectId);
  const jsonlFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
  const sessions: SessionInfo[] = [];
  for (const file of jsonlFiles) {
    sessions.push(await parseSessionFile(path.join(projectPath, file), projectId, projectName));
  }
  return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getSessions(limit = 50, offset = 0): Promise<SessionInfo[]> {
  const allSessions: SessionInfo[] = [];

  if (!fs.existsSync(getProjectsDir())) return [];
  const projectEntries = fs.readdirSync(getProjectsDir());

  for (const entry of projectEntries) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const { name: projectName } = getProjectNameFromDir(projectPath, entry);
    const jsonlFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      allSessions.push(await parseSessionFile(path.join(projectPath, file), entry, projectName));
    }
  }

  allSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return allSessions.slice(offset, offset + limit);
}

async function parseSessionFile(filePath: string, projectId: string, projectName: string): Promise<SessionInfo> {
  const sessionId = path.basename(filePath, '.jsonl');

  let firstTimestamp = '';
  let lastTimestamp = '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let estimatedCosts = zeroCosts();
  let gitBranch = '';
  let cwd = '';
  let version = '';
  const modelsSet = new Set<string>();
  const toolsUsed: Record<string, number> = {};

  // Compaction tracking
  let compactions = 0;
  let microcompactions = 0;
  let totalTokensSaved = 0;
  const compactionTimestamps: string[] = [];

  await forEachJsonlLine(filePath, (msg) => {
    if (msg.timestamp) {
      if (!firstTimestamp) firstTimestamp = msg.timestamp;
      lastTimestamp = msg.timestamp;
    }
    if (msg.gitBranch && !gitBranch) gitBranch = msg.gitBranch;
    if (msg.cwd && !cwd) cwd = msg.cwd;
    if (msg.version && !version) version = msg.version;

    // Track compaction events
    if (msg.compactMetadata) {
      compactions++;
      if (msg.timestamp) compactionTimestamps.push(msg.timestamp);
    }
    if (msg.microcompactMetadata) {
      microcompactions++;
      totalTokensSaved += msg.microcompactMetadata.tokensSaved || 0;
      if (msg.timestamp) compactionTimestamps.push(msg.timestamp);
    }

    if (msg.type === 'user') {
      if (msg.message?.role === 'user' && typeof msg.message.content === 'string') {
        userMessageCount++;
      } else if (msg.message?.role === 'user') {
        userMessageCount++;
      }
    }
    if (msg.type === 'assistant') {
      assistantMessageCount++;
      const model = msg.message?.model || '';
      if (model) modelsSet.add(model);
      const usage = msg.message?.usage;
      if (usage) {
        totalInputTokens += usage.input_tokens || 0;
        totalOutputTokens += usage.output_tokens || 0;
        totalCacheReadTokens += usage.cache_read_input_tokens || 0;
        totalCacheWriteTokens += usage.cache_creation_input_tokens || 0;
        const costs = calculateCostAllModes(
          model,
          usage.input_tokens || 0,
          usage.output_tokens || 0,
          usage.cache_creation_input_tokens || 0,
          usage.cache_read_input_tokens || 0
        );
        estimatedCosts = addCosts(estimatedCosts, costs);
      }
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object' && 'type' in c && c.type === 'tool_use') {
            toolCallCount++;
            const name = ('name' in c ? c.name : 'unknown') as string;
            toolsUsed[name] = (toolsUsed[name] || 0) + 1;
          }
        }
      }
    }
  });

  const duration = firstTimestamp && lastTimestamp
    ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
    : 0;

  const models = Array.from(modelsSet);

  return {
    id: sessionId,
    projectId,
    projectName,
    timestamp: firstTimestamp || new Date().toISOString(),
    duration,
    messageCount: userMessageCount + assistantMessageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    model: models[0] || 'unknown',
    models: models.map(getModelDisplayName),
    gitBranch,
    cwd,
    version,
    toolsUsed,
    compaction: {
      compactions,
      microcompactions,
      totalTokensSaved,
      compactionTimestamps,
    },
  };
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  if (!fs.existsSync(getProjectsDir())) return null;
  const projectEntries = fs.readdirSync(getProjectsDir());

  for (const entry of projectEntries) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const filePath = path.join(projectPath, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) continue;

    const { name: projectName } = getProjectNameFromDir(projectPath, entry);
    const sessionInfo = await parseSessionFile(filePath, entry, projectName);
    const messages: SessionMessageDisplay[] = [];

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as SessionMessage;
        if (msg.type === 'user' && msg.message?.role === 'user') {
          const content = msg.message.content;
          const textParts: string[] = [];
          const blocks: SessionMessageBlockDisplay[] = [];

          // Detect command XML patterns
          const rawText = typeof content === 'string' ? content : '';
          const commandNameMatch = rawText.match(/<command-name>([\s\S]*?)<\/command-name>/);
          const commandStdoutMatch = rawText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
          const commandCaveatMatch = rawText.match(/<local-command-caveat>([\s\S]*?)<\/local-command-caveat>/);

          if (commandNameMatch || commandStdoutMatch || commandCaveatMatch) {
            // This is a command message
            let commandContent = '';
            if (commandCaveatMatch) {
              commandContent = commandCaveatMatch[1].trim();
            } else if (commandNameMatch) {
              const name = commandNameMatch[1].trim();
              const argsMatch = rawText.match(/<command-args>([\s\S]*?)<\/command-args>/);
              const args = argsMatch ? argsMatch[1].trim() : '';
              commandContent = args ? `${name} ${args}` : name;
            } else if (commandStdoutMatch) {
              // Strip ANSI escape codes
              commandContent = commandStdoutMatch[1].replace(/\x1b\[[0-9;]*m/g, '').trim();
            }
            messages.push({
              role: 'command',
              content: commandContent,
              timestamp: msg.timestamp,
              isMeta: msg.isMeta || Boolean(commandCaveatMatch),
            });
            continue;
          }

          if (typeof content === 'string') {
            textParts.push(content);
          } else if (Array.isArray(content)) {
            let structuredResultUsed = false;

            for (const contentBlock of content) {
              if (!isRecord(contentBlock)) continue;

              if (contentBlock.type === 'text' && typeof contentBlock.text === 'string') {
                textParts.push(contentBlock.text);
                continue;
              }

              if (contentBlock.type === 'tool_result') {
                const structuredToolUseResult: Record<string, unknown> | undefined =
                  !structuredResultUsed && isRecord(msg.toolUseResult)
                  ? msg.toolUseResult
                  : undefined;

                blocks.push(
                  buildToolResultBlock(
                    contentBlock,
                    structuredToolUseResult,
                    typeof msg.sourceToolAssistantUUID === 'string' ? msg.sourceToolAssistantUUID : undefined,
                  ),
                );
                structuredResultUsed = structuredResultUsed || Boolean(structuredToolUseResult);
              }
            }
          }

          if (blocks.length === 0 && isRecord(msg.toolUseResult)) {
            blocks.push(
              buildToolResultBlock(
                undefined,
                msg.toolUseResult,
                typeof msg.sourceToolAssistantUUID === 'string' ? msg.sourceToolAssistantUUID : undefined,
              ),
            );
          }

          const text = textParts.join('\n').trim();
          if (text || blocks.length > 0) {
            const isToolResultOnly = !text && blocks.length > 0;
            messages.push({
              role: isToolResultOnly ? 'tool-result' : 'user',
              content: text,
              timestamp: msg.timestamp,
              blocks: blocks.length > 0 ? blocks : undefined,
              isMeta: msg.isMeta,
            });
          }
          continue;
        }

        if (msg.type === 'assistant' && msg.message?.content) {
          const content = msg.message.content;
          const toolCalls: SessionToolCallDisplay[] = [];
          const blocks: SessionMessageBlockDisplay[] = [];
          let text = '';

          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            for (const c of content) {
              if (isRecord(c)) {
                if ('type' in c && c.type === 'text' && 'text' in c) {
                  text += (c.text as string) + '\n';
                  continue;
                }

                if ('type' in c && c.type === 'thinking') {
                  const thinkingBlock = buildThinkingBlock(c);
                  if (thinkingBlock) blocks.push(thinkingBlock);
                  continue;
                }

                if ('type' in c && c.type === 'tool_use' && 'name' in c) {
                  toolCalls.push(
                    buildToolCallDisplay(
                      c.name as string,
                      (c.id as string) || '',
                      'input' in c ? c.input : undefined,
                    ),
                  );
                }
              }
            }
          }

          if (text.trim() || toolCalls.length > 0 || blocks.length > 0) {
            const isToolUseOnly = !text.trim() && toolCalls.length > 0;
            messages.push({
              role: isToolUseOnly ? 'tool-use' : 'assistant',
              content: text.trim(),
              timestamp: msg.timestamp,
              model: msg.message.model,
              usage: msg.message.usage as TokenUsage | undefined,
              stopReason: msg.message.stop_reason,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              blocks: blocks.length > 0 ? blocks : undefined,
              isMeta: msg.isMeta,
            });
          }
          continue;
        }

        const eventBlock = buildEventBlock(msg);
        if (eventBlock) {
          messages.push({
            role: 'system',
            content: eventBlock.summary,
            timestamp: msg.timestamp,
            blocks: [eventBlock],
            isMeta: msg.isMeta,
          });
        }
      } catch { /* skip */ }
    }

    return { ...sessionInfo, messages };
  }

  return null;
}

export async function searchSessions(query: string, limit = 50): Promise<SessionInfo[]> {
  if (!query.trim()) return getSessions(limit, 0);

  const lowerQuery = query.toLowerCase();
  const matchingSessions: SessionInfo[] = [];

  if (!fs.existsSync(getProjectsDir())) return [];
  const projectEntries = fs.readdirSync(getProjectsDir());

  for (const entry of projectEntries) {
    const projectPath = path.join(getProjectsDir(), entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    const jsonlFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const filePath = path.join(projectPath, file);

      let hasMatch = false;
      await forEachJsonlLine(filePath, (msg) => {
        if (hasMatch) return;
        if (msg.type === 'user' && msg.message?.role === 'user') {
          const content = msg.message.content;
          if (typeof content === 'string' && content.toLowerCase().includes(lowerQuery)) {
            hasMatch = true;
            return;
          }
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c && typeof c === 'object' && 'type' in c && c.type === 'text' && 'text' in c) {
                if ((c.text as string).toLowerCase().includes(lowerQuery)) {
                  hasMatch = true;
                  return;
                }
              }
            }
          }
        }
        if (msg.type === 'assistant' && msg.message?.content) {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c && typeof c === 'object' && 'type' in c && c.type === 'text' && 'text' in c) {
                if ((c.text as string).toLowerCase().includes(lowerQuery)) {
                  hasMatch = true;
                  return;
                }
              }
            }
          }
        }
      });

      if (hasMatch) {
        const { name: projectName } = getProjectNameFromDir(projectPath, entry);
        matchingSessions.push(await parseSessionFile(filePath, entry, projectName));
      }
    }
  }

  matchingSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return matchingSessions.slice(0, limit);
}

// --- Supplemental stats: bridge stale stats-cache.json with fresh JSONL data ---

interface SupplementalModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedCosts: CostEstimates;
}

interface SupplementalStats {
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  modelUsage: Record<string, SupplementalModelUsage>;
  hourCounts: Record<string, number>;
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  estimatedCosts: CostEstimates;
}

let supplementalCache: { key: string; data: SupplementalStats; ts: number } | null = null;
const SUPPLEMENTAL_TTL_MS = 30_000;

function getRecentSessionFiles(afterDate: string): string[] {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const cutoff = afterDate ? new Date(afterDate + 'T23:59:59Z').getTime() : 0;
  const files: string[] = [];

  for (const entry of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, entry);
    if (!fs.statSync(projectPath).isDirectory()) continue;

    for (const f of fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'))) {
      const filePath = path.join(projectPath, f);
      if (fs.statSync(filePath).mtimeMs > cutoff) {
        files.push(filePath);
      }
    }
  }

  return files;
}

async function computeSupplementalStats(afterDate: string): Promise<SupplementalStats> {
  const cacheKey = afterDate + ':' + getActiveDataSource();
  if (supplementalCache && supplementalCache.key === cacheKey && Date.now() - supplementalCache.ts < SUPPLEMENTAL_TTL_MS) {
    return supplementalCache.data;
  }

  const files = getRecentSessionFiles(afterDate);

  const dailyMap = new Map<string, DailyActivity>();
  const dailyModelMap = new Map<string, Record<string, number>>();
  const dailyModelCostMap = new Map<string, Record<string, CostEstimates>>();
  const modelUsage: Record<string, SupplementalModelUsage> = {};
  const hourCounts: Record<string, number> = {};
  let totalSessions = 0;
  let totalMessages = 0;
  let totalTokens = 0;
  let estimatedCosts = zeroCosts();

  for (const filePath of files) {
    let firstTimestamp = '';
    let sessionCounted = false;
    let firstQualifyingDate = '';

    await forEachJsonlLine(filePath, (msg) => {
      if (!msg.timestamp) return;

      if (!firstTimestamp) firstTimestamp = msg.timestamp;

      const msgDate = msg.timestamp.slice(0, 10);

      // Only count messages strictly after the cache boundary day
      if (afterDate && msgDate <= afterDate) return;

      // Count session once based on first qualifying message
      if (!sessionCounted) {
        totalSessions++;
        sessionCounted = true;
        firstQualifyingDate = msgDate;
      }

      const hour = msg.timestamp.slice(11, 13);

      if (msg.type === 'user' || msg.type === 'assistant') {
        totalMessages++;

        // dailyActivity
        let day = dailyMap.get(msgDate);
        if (!day) {
          day = { date: msgDate, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
          dailyMap.set(msgDate, day);
        }
        day.messageCount++;
      }

      if (msg.type === 'assistant') {
        const model = msg.message?.model || '';
        const usage = msg.message?.usage;

        if (usage) {
          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheWrite = usage.cache_creation_input_tokens || 0;
          const tokens = input + output + cacheRead + cacheWrite;
          totalTokens += tokens;

          const costs = calculateCostAllModes(model, input, output, cacheWrite, cacheRead);
          estimatedCosts = addCosts(estimatedCosts, costs);

          // modelUsage
          if (model) {
            if (!modelUsage[model]) {
              modelUsage[model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCosts: zeroCosts() };
            }
            modelUsage[model].inputTokens += input;
            modelUsage[model].outputTokens += output;
            modelUsage[model].cacheReadInputTokens += cacheRead;
            modelUsage[model].cacheCreationInputTokens += cacheWrite;
            modelUsage[model].estimatedCosts = addCosts(modelUsage[model].estimatedCosts, costs);
          }

          // dailyModelTokens + dailyModelCosts
          if (model) {
            let dayModel = dailyModelMap.get(msgDate);
            if (!dayModel) {
              dayModel = {};
              dailyModelMap.set(msgDate, dayModel);
            }
            dayModel[model] = (dayModel[model] || 0) + tokens;

            let dayCost = dailyModelCostMap.get(msgDate);
            if (!dayCost) {
              dayCost = {};
              dailyModelCostMap.set(msgDate, dayCost);
            }
            dayCost[model] = dayCost[model] ? addCosts(dayCost[model], costs) : { ...costs };
          }

          // hourCounts
          hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        }

        // tool calls
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          let toolCalls = 0;
          for (const c of content) {
            if (c && typeof c === 'object' && 'type' in c && c.type === 'tool_use') {
              toolCalls++;
            }
          }
          if (toolCalls > 0) {
            const day = dailyMap.get(msgDate);
            if (day) day.toolCallCount += toolCalls;
          }
        }
      }
    });

    // Track session count per day (based on first qualifying message)
    if (sessionCounted && firstQualifyingDate) {
      const day = dailyMap.get(firstQualifyingDate);
      if (day) day.sessionCount++;
    }
  }

  const dailyActivity = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const dailyModelTokens: DailyModelTokens[] = Array.from(dailyModelMap.entries())
    .map(([date, tokensByModel]) => ({
      date,
      tokensByModel,
      costsByModel: dailyModelCostMap.get(date) || {},
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const result: SupplementalStats = {
    dailyActivity,
    dailyModelTokens,
    modelUsage,
    hourCounts,
    totalSessions,
    totalMessages,
    totalTokens,
    estimatedCosts,
  };

  supplementalCache = { key: cacheKey, data: result, ts: Date.now() };
  return result;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const stats = getStatsCache();
  const projects = await getProjects();
  const afterDate = stats?.lastComputedDate || '';

  // Compute supplemental stats from JSONL files modified after the cache date
  const supplemental = await computeSupplementalStats(afterDate);

  // --- Base stats from cache ---
  let totalTokens = 0;
  let totalEstimatedCosts = zeroCosts();
  const modelUsageWithCost: Record<string, DashboardStats['modelUsage'][string]> = {};

  if (stats?.modelUsage) {
    for (const [model, usage] of Object.entries(stats.modelUsage)) {
      const costs = calculateCostAllModes(
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens
      );
      const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
      totalTokens += tokens;
      totalEstimatedCosts = addCosts(totalEstimatedCosts, costs);
      modelUsageWithCost[model] = { ...usage, estimatedCost: costs[DEFAULT_COST_MODE], estimatedCosts: costs };
    }
  }

  // --- Merge supplemental model usage ---
  for (const [model, usage] of Object.entries(supplemental.modelUsage)) {
    const costs = usage.estimatedCosts;
    totalTokens += usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    totalEstimatedCosts = addCosts(totalEstimatedCosts, costs);
    if (modelUsageWithCost[model]) {
      modelUsageWithCost[model].inputTokens += usage.inputTokens;
      modelUsageWithCost[model].outputTokens += usage.outputTokens;
      modelUsageWithCost[model].cacheReadInputTokens += usage.cacheReadInputTokens;
      modelUsageWithCost[model].cacheCreationInputTokens += usage.cacheCreationInputTokens;
      modelUsageWithCost[model].estimatedCost += costs[DEFAULT_COST_MODE];
      modelUsageWithCost[model].estimatedCosts = addCosts(modelUsageWithCost[model].estimatedCosts, costs);
    } else {
      modelUsageWithCost[model] = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
        webSearchRequests: 0,
        estimatedCost: costs[DEFAULT_COST_MODE],
        estimatedCosts: costs,
      };
    }
  }

  // --- Merge dailyActivity ---
  const dailyActivityMap = new Map<string, DailyActivity>();
  for (const d of (stats?.dailyActivity || [])) {
    dailyActivityMap.set(d.date, { ...d });
  }
  for (const d of supplemental.dailyActivity) {
    const existing = dailyActivityMap.get(d.date);
    if (existing) {
      existing.messageCount += d.messageCount;
      existing.sessionCount += d.sessionCount;
      existing.toolCallCount += d.toolCallCount;
    } else {
      dailyActivityMap.set(d.date, { ...d });
    }
  }
  const mergedDailyActivity = Array.from(dailyActivityMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // --- Merge dailyModelTokens (with costsByModel) ---
  // Build per-model cost-per-token ratios from overall model usage (for cache days without pre-computed costs)
  const modelCostPerToken: Record<string, CostEstimates> = {};
  for (const [model, usage] of Object.entries(modelUsageWithCost)) {
    const totalTok = usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    if (totalTok > 0 && usage.estimatedCosts) {
      modelCostPerToken[model] = {
        api: usage.estimatedCosts.api / totalTok,
        conservative: usage.estimatedCosts.conservative / totalTok,
        subscription: usage.estimatedCosts.subscription / totalTok,
      };
    }
  }

  const dailyModelTokenMap = new Map<string, Record<string, number>>();
  const dailyModelCostMergeMap = new Map<string, Record<string, CostEstimates>>();

  for (const d of (stats?.dailyModelTokens || [])) {
    dailyModelTokenMap.set(d.date, { ...d.tokensByModel });
    // Estimate costs for cache-sourced days using per-model ratio
    const dayCosts: Record<string, CostEstimates> = {};
    for (const [model, tokens] of Object.entries(d.tokensByModel)) {
      const ratio = modelCostPerToken[model];
      if (ratio) {
        dayCosts[model] = { api: tokens * ratio.api, conservative: tokens * ratio.conservative, subscription: tokens * ratio.subscription };
      }
    }
    dailyModelCostMergeMap.set(d.date, dayCosts);
  }

  for (const d of supplemental.dailyModelTokens) {
    const existingTokens = dailyModelTokenMap.get(d.date);
    const existingCosts = dailyModelCostMergeMap.get(d.date);
    if (existingTokens) {
      for (const [model, tokens] of Object.entries(d.tokensByModel)) {
        existingTokens[model] = (existingTokens[model] || 0) + tokens;
      }
      if (d.costsByModel && existingCosts) {
        for (const [model, costs] of Object.entries(d.costsByModel)) {
          existingCosts[model] = existingCosts[model] ? addCosts(existingCosts[model], costs) : { ...costs };
        }
      }
    } else {
      dailyModelTokenMap.set(d.date, { ...d.tokensByModel });
      dailyModelCostMergeMap.set(d.date, d.costsByModel ? { ...d.costsByModel } : {});
    }
  }

  const mergedDailyModelTokens: DailyModelTokens[] = Array.from(dailyModelTokenMap.entries())
    .map(([date, tokensByModel]) => ({
      date,
      tokensByModel,
      costsByModel: dailyModelCostMergeMap.get(date) || {},
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // --- Merge hourCounts ---
  const mergedHourCounts = { ...(stats?.hourCounts || {}) };
  for (const [hour, count] of Object.entries(supplemental.hourCounts)) {
    mergedHourCounts[hour] = (mergedHourCounts[hour] || 0) + count;
  }

  const recentSessions = await getSessions(10);

  // Use project-level totals for cost/tokens to stay consistent with the Projects page
  const projectTotalCosts: CostEstimates = projects.reduce(
    (sum, p) => addCosts(sum, p.estimatedCosts || { api: p.estimatedCost, conservative: p.estimatedCost, subscription: p.estimatedCost }),
    zeroCosts()
  );
  const projectTotalTokens = projects.reduce((sum, p) => sum + p.totalTokens, 0);

  const finalCosts = projectTotalCosts.api > 0 ? projectTotalCosts : totalEstimatedCosts;

  return {
    totalSessions: (stats?.totalSessions || 0) + supplemental.totalSessions,
    totalMessages: (stats?.totalMessages || 0) + supplemental.totalMessages,
    totalTokens: projectTotalTokens || totalTokens,
    estimatedCost: finalCosts[DEFAULT_COST_MODE],
    estimatedCosts: finalCosts,
    dailyActivity: mergedDailyActivity,
    dailyModelTokens: mergedDailyModelTokens,
    modelUsage: modelUsageWithCost,
    hourCounts: mergedHourCounts,
    firstSessionDate: stats?.firstSessionDate || '',
    longestSession: stats?.longestSession || { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: projects.length,
    recentSessions,
  };
}
