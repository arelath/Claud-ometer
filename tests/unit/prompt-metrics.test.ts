import { describe, expect, it } from 'vitest';
import {
  addPromptTokenTotals,
  buildPromptBreakdown,
  getAssistantPromptContribution,
  getAttachmentPromptContribution,
  getUserPromptContribution,
  hasPromptTokens,
  zeroPromptTokenTotals,
} from '@/lib/claude-data/prompt-metrics';
import type { SessionMessage } from '@/lib/claude-data/types';

function baseMessage(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    type: 'user',
    sessionId: 'session-1',
    timestamp: '2026-05-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('prompt metrics', () => {
  it('builds zero totals, adds totals, and reconciles usage residuals', () => {
    const totals = zeroPromptTokenTotals();
    expect(hasPromptTokens(totals)).toBe(false);

    const source = {
      ...zeroPromptTokenTotals(),
      systemTokens: 2,
      conversationTokens: 3,
      filesTokens: 5,
      thinkingTokens: 7,
      toolTokens: 11,
      otherTokens: 13,
      hiddenThinkingBlocks: 1,
    };
    addPromptTokenTotals(totals, source);
    expect(hasPromptTokens(totals)).toBe(true);

    const breakdown = buildPromptBreakdown(totals, {
      input_tokens: 50,
      output_tokens: 1,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 4,
    });
    expect(breakdown.totalTokens).toBe(59);
    expect(breakdown.thinkingTokens).toBe(25);

    const noUsage = buildPromptBreakdown({ ...zeroPromptTokenTotals(), conversationTokens: 3 });
    expect(noUsage.totalTokens).toBe(3);

    expect(() => buildPromptBreakdown(
      { ...zeroPromptTokenTotals(), conversationTokens: 100 },
      { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      'session-1',
      '2026-05-08T12:00:00.000Z',
    )).toThrow(/Prompt breakdown exceeds assistant usage/);
  });

  it('classifies attachments into file, hook, and system prompt buckets', () => {
    const fileTotals = getAttachmentPromptContribution(baseMessage({
      type: 'attachment',
      attachment: {
        type: 'file',
        filename: 'app.ts',
        displayPath: 'src/app.ts',
        content: { file: { content: 'export const answer = 42;' } },
      },
    }));
    const hookTotals = getAttachmentPromptContribution(baseMessage({
      type: 'attachment',
      attachment: { type: 'hook_success', stdout: 'lint passed' },
    }));
    const genericTotals = getAttachmentPromptContribution(baseMessage({
      type: 'attachment',
      attachment: { type: 'permission', prompt: 'Allow edit?' },
    }));

    expect(fileTotals.filesTokens).toBeGreaterThan(0);
    expect(hookTotals.otherTokens).toBeGreaterThan(0);
    expect(genericTotals.systemTokens).toBeGreaterThan(0);
    expect(getAttachmentPromptContribution(baseMessage({ type: 'user' }))).toEqual(zeroPromptTokenTotals());
  });

  it('classifies user strings, arrays, tool results, image descriptors, and meta commands', () => {
    const normal = getUserPromptContribution(baseMessage({
      type: 'user',
      message: { role: 'user', content: 'Please inspect the dashboard.' },
    }));
    const command = getUserPromptContribution(baseMessage({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<command-name>/model</command-name>' },
    }));
    const toolUseResult = getUserPromptContribution(baseMessage({
      type: 'user',
      toolUseResult: { type: 'read', content: 'tool output' },
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ignored because toolUseResult wins' }] },
    }));
    const mixedBlocks = getUserPromptContribution(baseMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'A text block' },
          { type: 'tool_result', content: [{ type: 'text', text: 'Tool text' }] },
          { type: 'image', alt_text: 'Screenshot', source: { type: 'base64', media_type: 'image/png', width: 10, height: 20, data: 'AAAA' } },
          { type: 'custom' },
          'raw primitive block',
        ],
      },
    }));

    expect(normal.conversationTokens).toBeGreaterThan(0);
    expect(command.systemTokens).toBeGreaterThan(0);
    expect(toolUseResult.toolTokens).toBeGreaterThan(0);
    expect(mixedBlocks.conversationTokens).toBeGreaterThan(0);
    expect(mixedBlocks.toolTokens).toBeGreaterThan(0);
    expect(mixedBlocks.otherTokens).toBeGreaterThan(0);
    expect(getUserPromptContribution(baseMessage({ type: 'assistant' }))).toEqual(zeroPromptTokenTotals());
  });

  it('classifies assistant content, thinking, hidden thinking, tool calls, and unknown blocks', () => {
    const stringAssistant = getAssistantPromptContribution(baseMessage({
      type: 'assistant',
      message: { role: 'assistant', content: 'Here is the answer.' },
    }));
    const blockAssistant = getAssistantPromptContribution(baseMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Visible response' },
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'redacted_thinking', signature: 'signature-only' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/app.ts' } },
          { type: 'server_tool_use' },
          42,
        ],
      },
    }));

    expect(stringAssistant.conversationTokens).toBeGreaterThan(0);
    expect(blockAssistant.conversationTokens).toBeGreaterThan(0);
    expect(blockAssistant.thinkingTokens).toBeGreaterThan(0);
    expect(blockAssistant.hiddenThinkingBlocks).toBe(1);
    expect(blockAssistant.toolTokens).toBeGreaterThan(0);
    expect(blockAssistant.otherTokens).toBeGreaterThan(0);
    expect(getAssistantPromptContribution(baseMessage({ type: 'user' }))).toEqual(zeroPromptTokenTotals());
  });
});
