import type {
  SessionArtifactDisplay,
  SessionMessageBlockDisplay,
  SessionToolCallDetail,
  SessionToolCallDisplay,
} from '@/lib/claude-data/types';
import { asRecord, type CodexEnvelope } from './schema';

export interface CodexToolResult {
  kind: string;
  callId: string;
  payload: Record<string, unknown>;
  source: 'response-output' | 'event-end';
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

function getCallId(record: Record<string, unknown>): string {
  return getOptionalString(record, 'call_id')
    || getOptionalString(record, 'callId')
    || getOptionalString(record, 'id')
    || '';
}

export function collectCodexToolResults(records: CodexEnvelope[]): Map<string, CodexToolResult> {
  const results = new Map<string, CodexToolResult>();
  for (const record of records) {
    const payload = getPayload(record);
    const kind = getOptionalString(payload, 'kind') || getOptionalString(payload, 'type') || '';
    const callId = getCallId(payload);
    if (!callId) continue;

    if (record.type === 'response_item' && (kind === 'function_call_output' || kind === 'custom_tool_call_output')) {
      if (!results.has(callId)) {
        results.set(callId, { kind, callId, payload, source: 'response-output' });
      }
      continue;
    }

    if (record.type === 'event_msg' && kind.endsWith('_end')) {
      results.set(callId, { kind, callId, payload, source: 'event-end' });
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
    if (!unifiedDiff) return [];
    const parsed = parseUnifiedDiff(unifiedDiff);
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
    detail('status', result ? (result.payload.success === false ? 'failed' : 'success') : 'pending', 'status'),
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
      detail('status', result ? (result.payload.success === false ? 'failed' : 'success') : 'pending', 'status'),
    ]),
    artifact,
  }));
}

function buildGenericTool(payload: Record<string, unknown>, result?: CodexToolResult): SessionToolCallDisplay {
  const name = getOptionalString(payload, 'name') || getOptionalString(payload, 'type') || 'tool_call';
  const callId = getCallId(payload);
  const input = parseJsonObject(payload.arguments ?? payload.input);
  return {
    name,
    id: callId,
    summary: name,
    details: compactDetails([
      detail('tool_use_id', callId, 'tool use id'),
      ...Object.entries(input).map(([key, value]) => detail(key, value)),
      detail('status', result ? 'completed' : 'pending', 'status'),
    ]),
  };
}

export function buildCodexToolCalls(payload: Record<string, unknown>, results: Map<string, CodexToolResult>): SessionToolCallDisplay[] {
  const name = getOptionalString(payload, 'name') || getOptionalString(payload, 'type') || '';
  const result = results.get(getCallId(payload));
  if (name === 'shell_command') return [buildShellTool(payload, result)];
  if (name === 'apply_patch') return buildPatchTools(payload, result);
  return [buildGenericTool(payload, result)];
}

export function buildCodexToolResultBlock(result: CodexToolResult): SessionMessageBlockDisplay {
  const stdout = getOptionalString(result.payload, 'stdout') || '';
  const stderr = getOptionalString(result.payload, 'stderr') || '';
  const output = result.payload.output == null
    ? ''
    : typeof result.payload.output === 'string'
      ? result.payload.output
      : JSON.stringify(result.payload.output, null, 2);
  const exitCode = result.payload.exit_code ?? result.payload.exitCode;
  const content = [stdout, stderr, output].filter(Boolean).join('\n').trim();
  const failed = result.payload.success === false || (typeof exitCode === 'number' && exitCode !== 0);

  return {
    type: 'tool-result',
    title: result.kind,
    summary: exitCode != null ? `exit code ${exitCode}` : (failed ? 'failed' : 'completed'),
    content,
    details: compactDetails([
      detail('tool_use_id', result.callId, 'tool use id'),
      detail('status', failed ? 'failed' : 'success', 'status'),
      detail('exit_code', exitCode, 'exit code'),
      detail('stdout', stdout, 'stdout'),
      detail('stderr', stderr, 'stderr'),
      detail('output', output, 'output'),
      detail('duration_ms', result.payload.duration_ms ?? result.payload.durationMs, 'duration ms'),
    ]),
  };
}
