import type {
  SessionArtifactDisplay,
  SessionMessage,
  SessionMessageBlockDisplay,
  SessionToolCallDisplay,
} from './types';
import { getDetailKeyTail, detailMatchesKey } from '@/lib/string-utils';
import { isRecord } from './record-utils';

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

export function buildToolCallDetails(name: string, input: unknown): SessionToolCallDisplay['details'] {
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

export function buildToolCallSummary(name: string, details: SessionToolCallDisplay['details']): string {
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

export function buildToolCallDisplay(name: string, id: string, input: unknown): SessionToolCallDisplay {
  const details = buildToolCallDetails(name, input);
  return {
    name,
    id,
    summary: buildToolCallSummary(name, details),
    details,
    artifact: buildToolCallArtifact(name, input),
  };
}

function toPreviewText(text: string, maxLength = 50_000): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}\n\n[truncated ${text.length.toLocaleString()} chars]`;
}

export function flattenStructuredRecord(
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

export function extractTextPreview(value: unknown): string | undefined {
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

function buildToolCallArtifact(name: string, input: unknown): SessionArtifactDisplay | undefined {
  if (!isRecord(input)) return undefined;

  const oldText = extractTextPreview(input.old_string ?? input.oldString);
  const newText = extractTextPreview(input.new_string ?? input.newString);

  if (!oldText || !newText) return undefined;

  const startLine = input.startLine;
  const location = typeof startLine === 'number' || typeof startLine === 'string'
    ? `line ${startLine}`
    : undefined;

  return {
    kind: 'diff',
    title: `${name} preview`,
    oldText,
    newText,
    location,
  };
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

function buildStructuredSummary(
  title: string,
  details: SessionToolCallDisplay['details'],
  content?: string,
): string {
  if (content) return truncateInline(content, 160);

  const fileDetail = details.find(detail =>
    detailMatchesKey(detail.key, ['displayPath', 'filePath', 'file_path', 'filename', 'path']),
  );
  const typeDetail = details.find(detail =>
    detailMatchesKey(detail.key, ['type', 'subtype', 'permissionMode', 'query', 'command']),
  );

  if (typeDetail && fileDetail) return `${typeDetail.value}: ${fileDetail.value}`;
  if (fileDetail) return fileDetail.value;
  if (typeDetail) return typeDetail.value;
  return details[0]?.value || title;
}

export function buildToolResultBlock(
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
    'exitCode',
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
    buildStructuredContent(toolUseResult) ||
    extractTextPreview(toolResultContent?.content) ||
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

export function buildThinkingBlock(contentBlock: Record<string, unknown>): SessionMessageBlockDisplay | null {
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

export function buildEventBlock(msg: SessionMessage): SessionMessageBlockDisplay | null {
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
