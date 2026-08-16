import type { SessionSubagentDisplay } from '@/lib/claude-data/types';
import { asRecord, getCodexPayloadKind, type CodexEnvelope } from './schema';
import type { CodexLogicalSessionMember } from './session-index';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function messageText(payload: Record<string, unknown>): string {
  if (typeof payload.message === 'string') return payload.message;
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .map(item => stringValue(asRecord(item)?.text))
    .filter(Boolean)
    .join('\n');
}

interface SubagentProtocolMessage {
  type: string;
  content: string;
  taskName?: string;
  author?: string;
  recipient?: string;
}

function protocolMessage(
  text: string,
  payload: Record<string, unknown>,
): SubagentProtocolMessage | null {
  const type = text.match(/^Message Type:\s*([A-Z_]+)/m)?.[1];
  if (!type || (type !== 'NEW_TASK' && type !== 'MESSAGE' && type !== 'FOLLOWUP_TASK')) return null;
  const taskName = text.match(/^Task name:\s*(\S+)/m)?.[1];
  const payloadMarker = text.match(/(?:^|\n)Payload:\s*\n/i);
  const content = payloadMarker
    ? text.slice((payloadMarker.index || 0) + payloadMarker[0].length).trim()
    : '';
  return {
    type,
    content: content || (type === 'MESSAGE' ? 'Message from parent agent' : 'New subagent task'),
    taskName,
    author: stringValue(payload.author) || undefined,
    recipient: stringValue(payload.recipient) || undefined,
  };
}

function incomingProtocol(record: CodexEnvelope): SubagentProtocolMessage | null {
  if (record.type !== 'response_item' || getCodexPayloadKind(record) !== 'agent_message') return null;
  const payload = asRecord(record.payload) || {};
  return protocolMessage(messageText(payload), payload);
}

function parentAgentPath(agentPath: string | undefined): string | undefined {
  if (!agentPath) return undefined;
  const separator = agentPath.lastIndexOf('/');
  return separator > 0 ? agentPath.slice(0, separator) : undefined;
}

function protocolAddressScore(
  protocol: SubagentProtocolMessage,
  member: CodexLogicalSessionMember,
): number {
  const agentPath = member.fileInfo.agentPath;
  if (agentPath && protocol.recipient === agentPath) return 4;
  if (agentPath && protocol.taskName === agentPath) return 3;
  if (parentAgentPath(agentPath) && protocol.author === parentAgentPath(agentPath)) return 2;
  return 0;
}

function isProtocolForMember(
  protocol: SubagentProtocolMessage,
  member: CodexLogicalSessionMember,
  allowUntargeted: boolean,
): boolean {
  if (protocolAddressScore(protocol, member) > 0) return true;
  const hasTarget = Boolean(protocol.recipient || protocol.taskName || protocol.author);
  return allowUntargeted && !hasTarget;
}

function isTriggeredInterAgentMarker(record: CodexEnvelope | undefined): boolean {
  if (record?.type !== 'inter_agent_communication_metadata') return false;
  return asRecord(record.payload)?.trigger_turn === true;
}

function nearestTaskStartBefore(records: CodexEnvelope[], boundaryIndex: number): number {
  for (let index = boundaryIndex - 1; index >= 0; index--) {
    if (records[index].type === 'event_msg' && getCodexPayloadKind(records[index]) === 'task_started') return index;
  }
  return -1;
}

function tokenTotals(record: CodexEnvelope): Record<string, number> | null {
  if (record.type !== 'event_msg' || getCodexPayloadKind(record) !== 'token_count') return null;
  const payload = asRecord(record.payload);
  const info = asRecord(payload?.info);
  const totals = asRecord(info?.total_token_usage);
  if (!totals) return null;
  return Object.fromEntries(Object.entries(totals).flatMap(([key, value]) => (
    typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : []
  )));
}

function rebaseTokenRecord(record: CodexEnvelope, baseline: Record<string, number>): CodexEnvelope {
  const payload = asRecord(record.payload);
  const info = asRecord(payload?.info);
  const totals = asRecord(info?.total_token_usage);
  if (!payload || !info || !totals) return record;
  const rebased = Object.fromEntries(Object.entries(totals).map(([key, value]) => [
    key,
    typeof value === 'number' ? Math.max(0, value - (baseline[key] || 0)) : value,
  ]));
  return {
    ...record,
    payload: {
      ...payload,
      info: {
        ...info,
        total_token_usage: rebased,
      },
    },
  };
}

function visibleProtocolRecord(record: CodexEnvelope, content: string): CodexEnvelope {
  return {
    ...record,
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    },
  };
}

export function subagentDisplay(member: CodexLogicalSessionMember): SessionSubagentDisplay {
  const fileInfo = member.fileInfo;
  return {
    id: fileInfo.nativeId,
    parentId: fileInfo.parentThreadId || fileInfo.sessionId || '',
    nickname: fileInfo.agentNickname,
    role: fileInfo.agentRole,
    path: fileInfo.agentPath,
    depth: member.depth,
  };
}

export function scopeCodexSubagentRecords(
  records: CodexEnvelope[],
  member: CodexLogicalSessionMember,
): CodexEnvelope[] {
  if (records.length === 0) return [];
  const boundaries = records.flatMap((record, index) => {
    const protocol = incomingProtocol(record);
    return protocol?.type === 'NEW_TASK' ? [{ index, protocol }] : [];
  });
  const bestScore = Math.max(0, ...boundaries.map(boundary => protocolAddressScore(boundary.protocol, member)));
  const markedBoundaries = boundaries
    .filter(candidate => isTriggeredInterAgentMarker(records[candidate.index - 1]))
    .map(candidate => ({ ...candidate, taskStartIndex: nearestTaskStartBefore(records, candidate.index) }));
  const latestTaskStart = Math.max(-1, ...markedBoundaries.map(candidate => candidate.taskStartIndex));
  const markerBoundary = markedBoundaries.find(candidate => candidate.taskStartIndex === latestTaskStart);
  const boundary = bestScore > 0
    ? boundaries.find(candidate => protocolAddressScore(candidate.protocol, member) === bestScore)
    : markerBoundary || (boundaries.length === 1 ? boundaries[0] : undefined);
  const boundaryIndex = boundary?.index ?? -1;
  if (boundaryIndex < 0) return [records[0]];

  let contextIndex = -1;
  let baseline: Record<string, number> = {};
  for (let index = 0; index < boundaryIndex; index++) {
    if (records[index].type === 'turn_context') contextIndex = index;
    const totals = tokenTotals(records[index]);
    if (totals) baseline = totals;
  }

  const scoped: CodexEnvelope[] = [records[0]];
  if (contextIndex > 0) scoped.push(records[contextIndex]);
  for (let index = boundaryIndex; index < records.length; index++) {
    const record = records[index];
    const incoming = incomingProtocol(record);
    if (incoming) {
      const selectedBoundary = index === boundaryIndex;
      const markedFollowup = incoming.type !== 'NEW_TASK' && isTriggeredInterAgentMarker(records[index - 1]);
      if (selectedBoundary
        || markedFollowup
        || isProtocolForMember(incoming, member, boundaries.length === 1)) {
        scoped.push(visibleProtocolRecord(record, incoming.content));
      }
      continue;
    }
    scoped.push(rebaseTokenRecord(record, baseline));
  }
  return scoped;
}
