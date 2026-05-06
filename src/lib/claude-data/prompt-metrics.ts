import claudeTokenizerModel from '@anthropic-ai/tokenizer/dist/cjs/claude.json';
import { Tiktoken } from 'tiktoken/lite';
import type { SessionMessage, SessionPromptTokenBreakdown, TokenUsage } from './types';
import { isRecord } from './record-utils';

let claudeTokenizer: Tiktoken | null = null;

function getClaudeTokenizer(): Tiktoken {
  if (!claudeTokenizer) {
    claudeTokenizer = new Tiktoken(
      claudeTokenizerModel.bpe_ranks,
      claudeTokenizerModel.special_tokens,
      claudeTokenizerModel.pat_str,
    );
  }
  return claudeTokenizer;
}

export interface PromptTokenTotals {
  systemTokens: number;
  conversationTokens: number;
  filesTokens: number;
  thinkingTokens: number;
  toolTokens: number;
  otherTokens: number;
  hiddenThinkingBlocks: number;
}

export function zeroPromptTokenTotals(): PromptTokenTotals {
  return {
    systemTokens: 0,
    conversationTokens: 0,
    filesTokens: 0,
    thinkingTokens: 0,
    toolTokens: 0,
    otherTokens: 0,
    hiddenThinkingBlocks: 0,
  };
}

function getPromptUsageTokenCount(usage?: TokenUsage): number | null {
  if (!usage) return null;
  return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
}

export function buildPromptBreakdown(
  totals: PromptTokenTotals,
  usage?: TokenUsage,
  sessionId?: string,
  timestamp?: string,
): SessionPromptTokenBreakdown {
  const systemTokens = totals.systemTokens;
  const conversationTokens = totals.conversationTokens;
  const filesTokens = totals.filesTokens;
  let thinkingTokens = totals.thinkingTokens;
  const toolTokens = totals.toolTokens;
  let otherTokens = totals.otherTokens;

  const knownTotal = systemTokens + conversationTokens + filesTokens + thinkingTokens + toolTokens + otherTokens;
  const exactTotal = getPromptUsageTokenCount(usage);

  if (exactTotal != null) {
    if (knownTotal > exactTotal) {
      const contextLabel = [sessionId, timestamp].filter(Boolean).join(' @ ');
      throw new Error(`Prompt breakdown exceeds assistant usage${contextLabel ? ` for ${contextLabel}` : ''}: ${knownTotal} > ${exactTotal}`);
    }

    const residualTokens = exactTotal - knownTotal;
    if (residualTokens > 0) {
      if (totals.hiddenThinkingBlocks > 0) {
        thinkingTokens += residualTokens;
      } else {
        otherTokens += residualTokens;
      }
    }

    return {
      totalTokens: exactTotal,
      systemTokens,
      conversationTokens,
      filesTokens,
      thinkingTokens,
      toolTokens,
      otherTokens,
    };
  }

  return {
    totalTokens: knownTotal,
    systemTokens,
    conversationTokens,
    filesTokens,
    thinkingTokens,
    toolTokens,
    otherTokens,
  };
}

export function addPromptTokenTotals(target: PromptTokenTotals, source: PromptTokenTotals): void {
  target.systemTokens += source.systemTokens;
  target.conversationTokens += source.conversationTokens;
  target.filesTokens += source.filesTokens;
  target.thinkingTokens += source.thinkingTokens;
  target.toolTokens += source.toolTokens;
  target.otherTokens += source.otherTokens;
  target.hiddenThinkingBlocks += source.hiddenThinkingBlocks;
}

export function hasPromptTokens(totals: PromptTokenTotals): boolean {
  return Boolean(
    totals.systemTokens ||
    totals.conversationTokens ||
    totals.filesTokens ||
    totals.thinkingTokens ||
    totals.toolTokens ||
    totals.otherTokens ||
    totals.hiddenThinkingBlocks
  );
}

function countTokenizedText(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return getClaudeTokenizer().encode(normalized.normalize('NFKC'), 'all').length;
}

function countSerializedTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return countTokenizedText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return countTokenizedText(String(value));

  try {
    const serialized = JSON.stringify(value);
    return serialized ? countTokenizedText(serialized) : 0;
  } catch {
    return 0;
  }
}

function getImageBlockTokenCount(block: Record<string, unknown>): number {
  const descriptor: Record<string, unknown> = { type: 'image' };

  if (typeof block.alt_text === 'string' && block.alt_text.trim()) {
    descriptor.alt_text = block.alt_text.trim();
  }

  if (typeof block.file_id === 'string' && block.file_id.trim()) {
    descriptor.file_id = block.file_id.trim();
  }

  if (typeof block.filename === 'string' && block.filename.trim()) {
    descriptor.filename = block.filename.trim();
  }

  if (isRecord(block.source)) {
    const sourceDescriptor: Record<string, unknown> = {};

    if (typeof block.source.type === 'string' && block.source.type.trim()) {
      sourceDescriptor.type = block.source.type.trim();
    }

    if (typeof block.source.media_type === 'string' && block.source.media_type.trim()) {
      sourceDescriptor.media_type = block.source.media_type.trim();
    }

    if (typeof block.source.width === 'number') sourceDescriptor.width = block.source.width;
    if (typeof block.source.height === 'number') sourceDescriptor.height = block.source.height;
    if (typeof block.source.width_px === 'number') sourceDescriptor.width_px = block.source.width_px;
    if (typeof block.source.height_px === 'number') sourceDescriptor.height_px = block.source.height_px;

    if (Object.keys(sourceDescriptor).length > 0) {
      descriptor.source = sourceDescriptor;
    }
  }

  return countSerializedTokens(descriptor);
}

function getFileAttachmentTokenCount(attachment: Record<string, unknown>): number {
  const parts: string[] = [];

  if (typeof attachment.filename === 'string') parts.push(attachment.filename);
  if (typeof attachment.displayPath === 'string') parts.push(attachment.displayPath);

  const fileContent = isRecord(attachment.content) && isRecord(attachment.content.file)
    ? attachment.content.file.content
    : undefined;

  if (typeof fileContent === 'string') {
    parts.push(fileContent);
  } else {
    return countSerializedTokens(attachment);
  }

  return countTokenizedText(parts.join('\n\n'));
}

function isCommandLikeUserContent(text: string): boolean {
  return /<command-name>|<local-command-stdout>|<local-command-caveat>/.test(text);
}

export function getAttachmentPromptContribution(msg: SessionMessage): PromptTokenTotals {
  const totals = zeroPromptTokenTotals();
  if (msg.type !== 'attachment' || !isRecord(msg.attachment)) return totals;

  const attachmentType = typeof msg.attachment.type === 'string' ? msg.attachment.type : 'attachment';
  if (attachmentType === 'file') {
    totals.filesTokens += getFileAttachmentTokenCount(msg.attachment);
    return totals;
  }

  if (attachmentType === 'hook_success') {
    totals.otherTokens += countSerializedTokens(msg.attachment);
    return totals;
  }

  totals.systemTokens += countSerializedTokens(msg.attachment);
  return totals;
}

export function getUserPromptContribution(msg: SessionMessage): PromptTokenTotals {
  const totals = zeroPromptTokenTotals();
  if (msg.type !== 'user' || msg.message?.role !== 'user') return totals;

  const content = msg.message.content;
  if (typeof content === 'string') {
    if (isCommandLikeUserContent(content) || msg.isMeta) {
      totals.systemTokens += countTokenizedText(content);
    } else {
      totals.conversationTokens += countTokenizedText(content);
    }
    return totals;
  }

  if (!Array.isArray(content)) return totals;

  if (isRecord(msg.toolUseResult)) {
    totals.toolTokens += countSerializedTokens(msg.toolUseResult);
    return totals;
  }

  for (const block of content) {
    if (!isRecord(block)) {
      totals.toolTokens += countSerializedTokens(block);
      continue;
    }

    if (block.type === 'text') {
      totals.conversationTokens += countSerializedTokens(block.text ?? block.content ?? block);
      continue;
    }

    if (block.type === 'tool_result') {
      totals.toolTokens += countSerializedTokens(block.content ?? block);
      continue;
    }

    if (block.type === 'image') {
      totals.otherTokens += getImageBlockTokenCount(block);
      continue;
    }

    totals.otherTokens += countSerializedTokens({ type: block.type });
  }

  return totals;
}

export function getAssistantPromptContribution(msg: SessionMessage): PromptTokenTotals {
  const totals = zeroPromptTokenTotals();
  if (msg.type !== 'assistant' || !msg.message?.content) return totals;

  const content = msg.message.content;
  if (typeof content === 'string') {
    totals.conversationTokens += countTokenizedText(content);
    return totals;
  }

  if (!Array.isArray(content)) return totals;

  for (const block of content) {
    if (!isRecord(block)) {
      totals.otherTokens += countSerializedTokens(block);
      continue;
    }

    if (block.type === 'text') {
      totals.conversationTokens += countSerializedTokens(block.text);
      continue;
    }

    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      const thinkingText = typeof block.thinking === 'string'
        ? block.thinking.trim()
        : typeof block.text === 'string'
          ? block.text.trim()
          : '';

      if (thinkingText) {
        totals.thinkingTokens += countTokenizedText(thinkingText);
      } else if (typeof block.signature === 'string' && block.signature.trim()) {
        totals.hiddenThinkingBlocks += 1;
      }
      continue;
    }

    if (block.type === 'tool_use') {
      totals.toolTokens += countSerializedTokens({ name: block.name, input: block.input });
      continue;
    }

    totals.otherTokens += countSerializedTokens({ type: block.type });
  }

  return totals;
}
