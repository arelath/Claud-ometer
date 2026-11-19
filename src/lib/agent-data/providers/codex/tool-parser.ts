import type {
  SessionArtifactDisplay,
  SessionMessageImageDisplay,
  SessionMessageBlockDisplay,
  SessionToolCallDetail,
  SessionToolCallDisplay,
} from '@/lib/claude-data/types';
import { asRecord, getCodexPayloadKind, type CodexEnvelope } from './schema';
import { isEncryptedAgentMessage } from './subagent';

export interface CodexToolResult {
  kind: string;
  callId: string;
  payload: Record<string, unknown>;
  source: 'response-output' | 'event-end';
  summaryBlock?: SessionMessageBlockDisplay;
}

export const SUMMARY_TOOL_RESULT = Symbol('codex-summary-tool-result');
export type CodexSummaryEnvelope = CodexEnvelope & { [SUMMARY_TOOL_RESULT]?: CodexToolResult };

export function compactCodexToolResult(result: CodexToolResult, preserveSnapshot = false): CodexToolResult {
  const block = buildCodexToolResultBlock(result);
  const limit = 8 * 1024;
  // A sliced string can keep the entire multi-megabyte output alive in V8.
  const prefix = (value: string) => Buffer.from(value.slice(0, limit), 'utf16le').toString('utf16le');
  return {
    ...result,
    // Patch extraction needs changes and failure status, not the raw output.
    payload: {
      changes: result.payload.changes,
      success: !resultHasScriptError(result),
      exit_code: result.payload.exit_code ?? result.payload.exitCode,
      duration_ms: result.payload.duration_ms ?? result.payload.durationMs,
    },
    summaryBlock: {
      ...block,
      content: preserveSnapshot ? block.content : block.content == null ? undefined : prefix(block.content),
      outputParts: undefined,
      images: undefined,
      details: block.details.map(item => ({ ...item, value: prefix(item.value) })),
    },
  };
}

interface ParsedApplyPatchEdit {
  path: string;
  oldText: string;
  newText: string;
  location?: string;
}

function detail(key: string, value: unknown, label = key): SessionToolCallDetail | null {
  if (value == null || value === '') return null;
  const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { key, label, value: rendered };
}

function compactDetails(details: Array<SessionToolCallDetail | null>): SessionToolCallDetail[] {
  return details.filter((item): item is SessionToolCallDetail => Boolean(item));
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (asRecord(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed) || {};
  } catch {
    return { input: value };
  }
}

function getPayload(envelope: CodexEnvelope): Record<string, unknown> {
  return asRecord(envelope.payload) || {};
}

function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getDataImageMediaType(url: string): string | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(url.trim());
  return match?.[1].toLowerCase() || null;
}

function getImageUrl(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  const url = record?.url;
  return typeof url === 'string' ? url : null;
}

function getOutputImage(record: Record<string, unknown>, index: number): SessionMessageImageDisplay | undefined {
  if (getOptionalString(record, 'type') !== 'input_image') return undefined;
  const url = getImageUrl(record.image_url ?? record.image);
  if (!url) return undefined;
  const mediaType = getOptionalString(record, 'media_type')
    || getOptionalString(record, 'mime_type')
    || getDataImageMediaType(url);
  if (!mediaType?.startsWith('image/')) return undefined;
  return { url, mediaType, label: `Image ${index + 1}` };
}

function getCallId(record: Record<string, unknown>): string {
  return getOptionalString(record, 'call_id')
    || getOptionalString(record, 'callId')
    || getOptionalString(record, 'id')
    || '';
}

type ToolOutputPart = NonNullable<SessionMessageBlockDisplay['outputParts']>[number];

function decodeTextReturn(text: string): ToolOutputPart {
  if (text.trimStart().startsWith('[')) {
    try {
      const tuple: unknown = JSON.parse(text);
      if (Array.isArray(tuple) && tuple.length === 2) {
        const [label, body] = tuple;
        if (typeof label === 'string' && label.trim() && !/[\r\n]/.test(label) && typeof body === 'string') {
          return { label, text: body };
        }
      }
    } catch {
      // Text beginning with a bracket may be ordinary tool output.
    }
  }
  return { text };
}

function unpackOutput(output: unknown): { parts: ToolOutputPart[]; images: SessionMessageImageDisplay[] } | undefined {
  let entries = output;
  if (typeof output === 'string' && /^\s*\[\s*\{/.test(output)) {
    try {
      entries = JSON.parse(output);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(entries)) return undefined;

  const parts: ToolOutputPart[] = [];
  const images: SessionMessageImageDisplay[] = [];
  let hasContentBlocks = false;
  for (const entry of entries) {
    const record = asRecord(entry);
    const image = record && getOutputImage(record, images.length);
    if (image) {
      hasContentBlocks = true;
      images.push(image);
    } else if (record && (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text') && typeof record.text === 'string') {
      hasContentBlocks = true;
      parts.push(decodeTextReturn(record.text));
    } else {
      parts.push({ text: JSON.stringify(entry, null, 2) ?? '' });
    }
  }
  return hasContentBlocks ? { parts, images } : undefined;
}

export function collectCodexToolResults(records: CodexEnvelope[]): Map<string, CodexToolResult> {
  const results = new Map<string, CodexToolResult>();
  for (const record of records) {
    const payload = getPayload(record);
    const kind = getOptionalString(payload, 'kind') || getOptionalString(payload, 'type') || '';
    const callId = getCallId(payload);
    if (!callId) continue;
    const prepared = (record as CodexSummaryEnvelope)[SUMMARY_TOOL_RESULT];

    if (record.type === 'response_item' && (kind === 'function_call_output' || kind === 'custom_tool_call_output')) {
      if (!results.has(callId)) {
        results.set(callId, prepared || { kind, callId, payload, source: 'response-output' });
      }
      continue;
    }

    if (record.type === 'event_msg' && kind.endsWith('_end')) {
      results.set(callId, prepared || { kind, callId, payload, source: 'event-end' });
    }
  }
  return results;
}

export function isCodexEnrichedToolResult(result: CodexToolResult | undefined): boolean {
  return result?.source === 'event-end';
}

function getShellInput(payload: Record<string, unknown>): Record<string, unknown> {
  return parseJsonObject(payload.arguments ?? payload.input);
}

function buildShellTool(payload: Record<string, unknown>, result?: CodexToolResult): SessionToolCallDisplay {
  const input = getShellInput(payload);
  const command = getOptionalString(input, 'command') || getOptionalString(payload, 'command') || 'shell command';
  const callId = getCallId(payload);
  const resultPayload = result?.payload || {};
  const exitCode = resultPayload.exit_code ?? resultPayload.exitCode;

  return {
    name: 'shell_command',
    id: callId,
    summary: command,
    details: compactDetails([
      detail('tool_use_id', callId, 'tool use id'),
      detail('command', command, 'command'),
      detail('cwd', input.cwd ?? payload.cwd, 'cwd'),
      detail('status', result ? (typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'success') : 'pending', 'status'),
      detail('exit_code', exitCode, 'exit code'),
      detail('duration_ms', resultPayload.duration_ms ?? resultPayload.durationMs, 'duration ms'),
    ]),
  };
}

function parseUnifiedDiff(diffText: string): { oldText: string; newText: string; location?: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let location: string | undefined;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      location = line;
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git')) continue;
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }

  return { oldText: oldLines.join('\n'), newText: newLines.join('\n'), location };
}

function isApplyPatchFileHeader(line: string): boolean {
  return /^\*\*\* (?:Update|Add|Delete) File: /.test(line);
}

function parseApplyPatchInput(input: string): ParsedApplyPatchEdit[] {
  const edits: ParsedApplyPatchEdit[] = [];
  let filePath = '';
  let operation = '';
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let location: string | undefined;
  let hunkCountForFile = 0;

  const flushHunk = () => {
    if (!filePath) return;
    if (oldLines.length === 0 && newLines.length === 0) return;
    edits.push({
      path: filePath,
      oldText: oldLines.join('\n'),
      newText: newLines.join('\n'),
      location: location && location !== '@@' ? location : hunkCountForFile > 1 ? `hunk ${hunkCountForFile}` : undefined,
    });
    oldLines = [];
    newLines = [];
  };

  const startFile = (nextOperation: 'update' | 'add' | 'delete', nextPath: string) => {
    flushHunk();
    filePath = nextPath.trim();
    operation = nextOperation;
    oldLines = [];
    newLines = [];
    location = operation === 'add' || operation === 'delete' ? 'line 1' : undefined;
    hunkCountForFile = operation === 'add' || operation === 'delete' ? 1 : 0;
  };

  for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
    if (updateMatch) {
      startFile('update', updateMatch[1]);
      continue;
    }

    const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
    if (addMatch) {
      startFile('add', addMatch[1]);
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
    if (deleteMatch) {
      startFile('delete', deleteMatch[1]);
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (moveMatch) {
      filePath = moveMatch[1].trim();
      continue;
    }

    if (line.startsWith('@@')) {
      flushHunk();
      hunkCountForFile += 1;
      location = line.trim();
      continue;
    }

    if (!filePath || line === '*** Begin Patch' || line === '*** End Patch' || line === '*** End of File') continue;
    if (line.startsWith('*** ') && !isApplyPatchFileHeader(line)) continue;
    if (line.startsWith('\\')) continue;

    if (line.startsWith('+')) {
      if (operation !== 'delete') newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      if (operation !== 'add') oldLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    } else if (operation === 'update') {
      oldLines.push(line);
      newLines.push(line);
    }
  }

  flushHunk();
  return edits;
}

function getApplyPatchInput(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.input === 'string' && payload.input.trim()) return payload.input;
  if (typeof payload.patch === 'string' && payload.patch.trim()) return payload.patch;
  if (typeof payload.arguments !== 'string' || !payload.arguments.trim()) return undefined;
  const args = parseJsonObject(payload.arguments);
  if (typeof args.input === 'string' && args.input.trim()) return args.input;
  if (typeof args.patch === 'string' && args.patch.trim()) return args.patch;
  if (payload.arguments.includes('*** Begin Patch')) return payload.arguments;
  return undefined;
}

function getExecInput(payload: Record<string, unknown>): string {
  return typeof payload.input === 'string'
    ? payload.input
    : typeof payload.arguments === 'string'
      ? payload.arguments
      : '';
}

export function getCodexFileChangeItem(record: CodexEnvelope): Record<string, unknown> | null {
  if (record.type !== 'event_msg' || getCodexPayloadKind(record) !== 'item_completed') return null;
  const item = asRecord(getPayload(record).item);
  return item?.type === 'FileChange' ? item : null;
}

export function collectCodexFileChanges(records: CodexEnvelope[]): {
  byRecord: Map<CodexEnvelope, CodexToolResult>;
  coveredCallIds: Set<string>;
} {
  const byRecord = new Map<CodexEnvelope, CodexToolResult>();
  const coveredCallIds = new Set<string>();
  const pendingPatchCalls = new Set<string>();
  const seenItems = new Set<string>();

  for (const record of records) {
    const kind = getCodexPayloadKind(record);
    if (record.type === 'response_item') {
      const payload = getPayload(record);
      const callId = getCallId(payload);
      if (kind === 'custom_tool_call_output' || kind === 'function_call_output') {
        pendingPatchCalls.delete(callId);
      } else if (callId && (kind === 'custom_tool_call' || kind === 'function_call')) {
        if (payload.name === 'apply_patch' || (payload.name === 'exec' && getExecInput(payload).includes('tools.apply_patch'))) {
          pendingPatchCalls.add(callId);
        }
      }
      continue;
    }

    if (record.type !== 'event_msg') continue;
    if (kind === 'task_started' || kind === 'task_complete' || kind === 'turn_aborted') {
      pendingPatchCalls.clear();
    }
    const item = getCodexFileChangeItem(record);
    if (!item) continue;
    const itemId = getCallId(item);
    if (!itemId || seenItems.has(itemId)) continue;
    seenItems.add(itemId);

    // Nested tools get their own item IDs. Bridge to the outer call only when
    // there is a single pending patch-capable call and no exact ID match.
    coveredCallIds.add(itemId);
    if (!pendingPatchCalls.has(itemId) && pendingPatchCalls.size === 1) {
      const [parentCallId] = pendingPatchCalls;
      coveredCallIds.add(parentCallId);
    }
    if (item.status !== 'completed') continue;
    byRecord.set(record, { kind: 'file_change', callId: itemId, payload: item, source: 'event-end' });
  }

  return { byRecord, coveredCallIds };
}

function getEmbeddedApplyPatchInputs(payload: Record<string, unknown>): string[] {
  const source = getExecInput(payload);
  if (!source || !source.includes('tools.apply_patch')) return [];

  const patches: string[] = [];
  const assignmentPattern = /\b(?:const|let|var)\s+patch\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  for (const match of source.matchAll(assignmentPattern)) {
    const literal = match[1];
    try {
      const decoded = literal.startsWith('"')
        ? JSON.parse(literal)
        : literal.slice(1, -1).replace(/\\([\\'"nrt])/g, (_match, escaped: string) => ({
          '\\': '\\',
          "'": "'",
          '"': '"',
          n: '\n',
          r: '\r',
          t: '\t',
        }[escaped] || escaped));
      if (typeof decoded === 'string' && decoded.includes('*** Begin Patch') && source.includes('tools.apply_patch(patch')) {
        patches.push(decoded);
      }
    } catch {
      // The enclosing exec call remains visible even when an embedded source literal is malformed.
    }
  }
  return patches;
}

function resultHasScriptError(result?: CodexToolResult): boolean {
  if (!result) return false;
  if (result.payload.success === false) return true;
  const exitCode = result.payload.exit_code ?? result.payload.exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) return true;

  const output = result.payload.output;
  const outputText = Array.isArray(output)
    ? output.map(item => asRecord(item)?.text).filter((text): text is string => typeof text === 'string').join('\n')
    : typeof output === 'string' ? output : '';
  return /^Script error(?:\s|:)/m.test(outputText);
}

function getPatchArtifactsFromInput(payload: Record<string, unknown>): Array<{ path: string; artifact: SessionArtifactDisplay }> {
  const input = getApplyPatchInput(payload);
  if (!input) return [];

  return parseApplyPatchInput(input).map(edit => ({
    path: edit.path,
    artifact: {
      kind: 'diff' as const,
      title: `${edit.path} diff`,
      oldText: edit.oldText,
      newText: edit.newText,
      location: edit.location,
      includeWhenEmpty: true,
    },
  }));
}

function getPatchArtifactsFromResult(result?: CodexToolResult): Array<{ path: string; artifact: SessionArtifactDisplay }> {
  const changes = asRecord(result?.payload.changes);
  if (!changes) return [];

  return Object.entries(changes).flatMap(([filePath, value]) => {
    const change = asRecord(value);
    const unifiedDiff = typeof change?.unified_diff === 'string'
      ? change.unified_diff
      : typeof change?.unifiedDiff === 'string'
        ? change.unifiedDiff
        : '';
    const changeType = getOptionalString(change || {}, 'type');
    const content = typeof change?.content === 'string' ? change.content : '';
    const parsed = unifiedDiff
      ? parseUnifiedDiff(unifiedDiff)
      : changeType === 'add'
        ? { oldText: '', newText: content, location: undefined }
        : changeType === 'delete'
          ? { oldText: content, newText: '', location: undefined }
          : null;
    if (!parsed) return [];
    return [{
      path: filePath,
      artifact: {
        kind: 'diff' as const,
        title: `${filePath} diff`,
        oldText: parsed.oldText,
        newText: parsed.newText,
        location: parsed.location,
        includeWhenEmpty: true,
      },
    }];
  });
}

function buildPatchTools(payload: Record<string, unknown>, result?: CodexToolResult): SessionToolCallDisplay[] {
  const callId = getCallId(payload);
  const artifacts = getPatchArtifactsFromResult(result);
  const fallbackArtifacts = artifacts.length > 0 ? artifacts : getPatchArtifactsFromInput(payload);
  const baseDetails = compactDetails([
    detail('tool_use_id', callId, 'tool use id'),
    detail('input', payload.input, 'input'),
    detail('status', result ? (resultHasScriptError(result) ? 'failed' : 'success') : 'pending', 'status'),
  ]);

  if (fallbackArtifacts.length === 0) {
    return [{
      name: 'apply_patch',
      id: callId,
      summary: 'apply_patch',
      details: baseDetails,
    }];
  }

  return fallbackArtifacts.map(({ path, artifact }, index) => ({
    name: 'apply_patch',
    id: fallbackArtifacts.length === 1 ? callId : `${callId}:${index + 1}`,
    summary: path,
    details: compactDetails([
      detail('tool_use_id', callId, 'tool use id'),
      detail('file_path', path, 'file path'),
      detail('input', payload.input, 'input'),
      detail('status', result ? (resultHasScriptError(result) ? 'failed' : 'success') : 'pending', 'status'),
    ]),
    artifact,
  }));
}

export function buildCodexPatchResultToolCalls(result: CodexToolResult): SessionToolCallDisplay[] {
  return buildPatchTools({
    type: 'custom_tool_call',
    name: 'apply_patch',
    call_id: result.callId,
  }, result);
}

export function isAgentMessagingTool(name: string): boolean {
  return name === 'spawn_agent' || name === 'send_message' || name === 'followup_task';
}

function buildGenericTool(payload: Record<string, unknown>, result?: CodexToolResult): SessionToolCallDisplay {
  const name = getOptionalString(payload, 'name') || getOptionalString(payload, 'type') || 'tool_call';
  const callId = getCallId(payload);
  const input = parseJsonObject(payload.arguments ?? payload.input);
  let summary = name;
  if (isAgentMessagingTool(name)) {
    const target = name === 'spawn_agent' ? input.task_name : input.target;
    if (typeof target === 'string') {
      summary = name === 'spawn_agent' ? `Assigned task to ${target}`
        : name === 'followup_task' ? `Follow-up for ${target}` : `Message to ${target}`;
    }
  }
  return {
    name,
    id: callId,
    summary,
    details: compactDetails([
      detail('tool_use_id', callId, 'tool use id'),
      ...Object.entries(input).map(([key, value]) => detail(key,
        key === 'message' && isAgentMessagingTool(name) && isEncryptedAgentMessage(value)
          ? 'Message body is encrypted in the session log.' : value)),
      detail('status', result ? 'completed' : 'pending', 'status'),
    ]),
  };
}

export function buildCodexToolCalls(
  payload: Record<string, unknown>,
  results: Map<string, CodexToolResult>,
  coveredCallIds?: ReadonlySet<string>,
): SessionToolCallDisplay[] {
  const name = getOptionalString(payload, 'name') || getOptionalString(payload, 'type') || '';
  const callId = getCallId(payload);
  const result = results.get(callId);
  if (name === 'shell_command') return [buildShellTool(payload, result)];
  if (coveredCallIds?.has(callId)) return [buildGenericTool(payload, result)];
  if (name === 'apply_patch') return buildPatchTools(payload, result);
  if (name === 'exec') {
    const embeddedPatches = getEmbeddedApplyPatchInputs(payload);
    if (embeddedPatches.length > 0 && !resultHasScriptError(result)) {
      return embeddedPatches.flatMap((patch, index) => buildPatchTools({
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: `${getCallId(payload)}:embedded-patch:${index + 1}`,
        input: patch,
      }, result));
    }
  }
  return [buildGenericTool(payload, result)];
}

export function buildCodexToolResultBlock(result: CodexToolResult): SessionMessageBlockDisplay {
  if (result.summaryBlock) return result.summaryBlock;
  const stdout = getOptionalString(result.payload, 'stdout') || '';
  const stderr = getOptionalString(result.payload, 'stderr') || '';
  const rawOutput = result.payload.output;
  const unpacked = unpackOutput(rawOutput);
  const images = unpacked?.images || [];
  let output = '';
  if (unpacked) {
    output = unpacked.parts.map(part => part.label ? `${part.label}\n${part.text}` : part.text).join('\n\n');
  } else if (rawOutput != null) {
    output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2);
  }
  const outputParts = unpacked?.parts.some(part => part.label || part.text.trim()) ? [
    ...(stdout ? [{ label: 'stdout', text: stdout }] : []),
    ...(stderr ? [{ label: 'stderr', text: stderr }] : []),
    ...unpacked.parts,
  ] : undefined;
  const exitCode = result.payload.exit_code ?? result.payload.exitCode;
  const content = [stdout, stderr, output].filter(Boolean).join('\n').trim();
  const failed = result.payload.success === false || (typeof exitCode === 'number' && exitCode !== 0);

  return {
    type: 'tool-result',
    title: result.kind,
    summary: images.length > 0
      ? `${images.length} image${images.length === 1 ? '' : 's'}`
      : exitCode != null ? `exit code ${exitCode}` : (failed ? 'failed' : 'completed'),
    content,
    outputParts,
    images,
    details: compactDetails([
      detail('tool_use_id', result.callId, 'tool use id'),
      detail('status', failed ? 'failed' : 'success', 'status'),
      detail('exit_code', exitCode, 'exit code'),
      detail('stdout', stdout, 'stdout'),
      detail('stderr', stderr, 'stderr'),
      detail('output', output || (images.length ? `${images.length} image output` : ''), 'output'),
      detail('duration_ms', result.payload.duration_ms ?? result.payload.durationMs, 'duration ms'),
    ]),
  };
}
