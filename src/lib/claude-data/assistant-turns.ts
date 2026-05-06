import type { SessionMessage, TokenUsage } from './types';
import { isRecord } from './record-utils';

export interface AssistantTurnAggregate {
  model: string;
  usage?: TokenUsage;
  timestamp: string;
  topLevel: boolean;
  toolCalls: Map<string, string>;
  extraCacheWriteTokens: number;
  pendingThinkingOnlyCacheWriteTokens: number;
  sawNonThinkingSnapshot: boolean;
}

function getAssistantTurnKey(filePath: string, msg: SessionMessage): string {
  const messageId = typeof msg.message?.id === 'string' && msg.message.id
    ? msg.message.id
    : msg.uuid || msg.timestamp || 'unknown-assistant-turn';
  return `${filePath}:${messageId}`;
}

function isThinkingOnlyAssistantSnapshot(msg: SessionMessage): boolean {
  const content = msg.message?.content;
  return Array.isArray(content)
    && content.length > 0
    && content.every(block => isRecord(block) && block.type === 'thinking');
}

function hasVisibleAssistantSnapshotContent(msg: SessionMessage): boolean {
  const content = msg.message?.content;
  if (typeof content === 'string') return Boolean(content.trim());
  if (!Array.isArray(content)) return false;

  return content.some(block => isRecord(block) && (
    (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
    || block.type === 'tool_use'
  ));
}

export function getAssistantTurnCacheWriteTokens(turn: AssistantTurnAggregate): number {
  return (turn.usage?.cache_creation_input_tokens || 0) + turn.extraCacheWriteTokens;
}

export function recordAssistantTurn(
  turns: Map<string, AssistantTurnAggregate>,
  filePath: string,
  msg: SessionMessage,
  topLevel: boolean,
): void {
  if (msg.type !== 'assistant') return;

  const turnKey = getAssistantTurnKey(filePath, msg);
  let turn = turns.get(turnKey);

  if (!turn) {
    turn = {
      model: '',
      timestamp: msg.timestamp || '',
      topLevel,
      toolCalls: new Map<string, string>(),
      extraCacheWriteTokens: 0,
      pendingThinkingOnlyCacheWriteTokens: 0,
      sawNonThinkingSnapshot: false,
    };
    turns.set(turnKey, turn);
  }

  turn.topLevel = turn.topLevel || topLevel;
  if (msg.timestamp) turn.timestamp = msg.timestamp;
  if (typeof msg.message?.model === 'string' && msg.message.model) turn.model = msg.message.model;

  const isThinkingOnlySnapshot = isThinkingOnlyAssistantSnapshot(msg);
  const hasVisibleContent = hasVisibleAssistantSnapshotContent(msg);

  if (msg.message?.usage) {
    const usage = msg.message.usage as TokenUsage;

    if (isThinkingOnlySnapshot && !turn.sawNonThinkingSnapshot) {
      turn.pendingThinkingOnlyCacheWriteTokens = usage.cache_creation_input_tokens || 0;
    } else {
      if (
        hasVisibleContent
        && msg.message?.stop_reason === 'end_turn'
        && !turn.sawNonThinkingSnapshot
        && turn.pendingThinkingOnlyCacheWriteTokens > 0
      ) {
        turn.extraCacheWriteTokens += turn.pendingThinkingOnlyCacheWriteTokens;
      }

      if (!isThinkingOnlySnapshot) {
        turn.sawNonThinkingSnapshot = true;
      }

      turn.pendingThinkingOnlyCacheWriteTokens = 0;
    }

    turn.usage = usage;
  }

  if (!topLevel || !Array.isArray(msg.message?.content)) return;

  msg.message.content.forEach((contentBlock, index) => {
    if (!isRecord(contentBlock) || contentBlock.type !== 'tool_use') return;
    const toolName = typeof contentBlock.name === 'string' && contentBlock.name ? contentBlock.name : 'unknown';
    const toolId = typeof contentBlock.id === 'string' && contentBlock.id ? contentBlock.id : `${toolName}-${index}`;
    turn.toolCalls.set(toolId, toolName);
  });
}
