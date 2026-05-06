import { describe, expect, it } from 'vitest';
import { buildTranscriptItems } from '@/lib/session-transcript';
import { calculateCostAllModes } from '@/config/pricing';
import type { TokenUsage } from '@/lib/claude-data/types';
import type { SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';

function toolCall(name: string, id: string, details: Record<string, string>): SessionToolCallDisplay {
  return {
    name,
    id,
    summary: name,
    details: Object.entries(details).map(([key, value]) => ({ key, label: key, value })),
  };
}

function usage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function toolUse(index: number, tool: SessionToolCallDisplay, tokenUsage?: TokenUsage): SessionMessageDisplay {
  return {
    role: 'tool-use',
    content: '',
    timestamp: `2026-05-03T10:00:${String(index).padStart(2, '0')}.000Z`,
    messageId: `tool-use-${index}`,
    model: 'claude-opus-4',
    usage: tokenUsage,
    toolCalls: [tool],
  };
}

function assistantWithTool(index: number, tool: SessionToolCallDisplay, content = 'I will run this tool.'): SessionMessageDisplay {
  return {
    role: 'assistant',
    content,
    timestamp: `2026-05-03T10:00:${String(index).padStart(2, '0')}.000Z`,
    messageId: `assistant-${index}`,
    model: 'claude-opus-4',
    toolCalls: [tool],
  };
}

function toolResult(index: number, toolUseId: string, content: string): SessionMessageDisplay {
  return {
    role: 'tool-result',
    content: '',
    timestamp: `2026-05-03T10:00:${String(index).padStart(2, '0')}.000Z`,
    blocks: [
      {
        type: 'tool-result',
        title: 'Text',
        summary: content,
        content,
        details: [{ key: 'tool_use_id', label: 'Tool call', value: toolUseId }],
      },
    ],
  };
}

describe('session transcript grouping', () => {
  it('collapses adjacent tool-only Claude turns after hidden events are filtered out', () => {
    const read = toolCall('Read', 'read-hidden-event', { file_path: 'src/app.tsx' });
    const grep = toolCall('Grep', 'grep-hidden-event', { query: 'Context Builder' });
    const messages: SessionMessageDisplay[] = [
      {
        role: 'user',
        content: 'Please inspect the context builder.',
        timestamp: '2026-05-03T10:00:00.000Z',
      },
      toolUse(1, read),
      {
        role: 'system',
        content: 'Hook ran between tool-only Claude snapshots.',
        timestamp: '2026-05-03T10:00:02.000Z',
      },
      toolUse(3, grep),
      {
        role: 'system',
        content: 'Another hidden hook event.',
        timestamp: '2026-05-03T10:00:04.000Z',
      },
      toolResult(5, 'read-hidden-event', 'READ_COLLAPSE_OUTPUT'),
      toolResult(6, 'grep-hidden-event', 'GREP_COLLAPSE_OUTPUT'),
    ];

    const toolItems = buildTranscriptItems(messages, 'tools');
    const toolAssistantItems = toolItems.filter(item => item.type === 'assistant');

    expect(toolAssistantItems).toHaveLength(1);
    expect(toolAssistantItems[0].toolPairs.map(pair => pair.toolUse?.message.toolCalls?.[0]?.id)).toEqual([
      'read-hidden-event',
      'grep-hidden-event',
    ]);
    expect(toolAssistantItems[0].toolPairs.map(pair => pair.toolResult?.message.blocks?.[0]?.content)).toEqual([
      'READ_COLLAPSE_OUTPUT',
      'GREP_COLLAPSE_OUTPUT',
    ]);

    const allItems = buildTranscriptItems(messages, 'all');
    const allAssistantItems = allItems.filter(item => item.type === 'assistant');
    expect(allAssistantItems).toHaveLength(4);
    expect(allAssistantItems[0].toolPairs[0].toolUse?.message.toolCalls?.[0]?.id).toBe('read-hidden-event');
    expect(allAssistantItems[0].toolPairs[0].toolResult).toBeUndefined();
    expect(allAssistantItems[1].toolPairs[0].toolUse?.message.toolCalls?.[0]?.id).toBe('grep-hidden-event');
    expect(allAssistantItems[1].toolPairs[0].toolResult).toBeUndefined();
    expect(allAssistantItems[2].toolPairs[0].toolUse).toBeUndefined();
    expect(allAssistantItems[2].toolPairs[0].toolResult?.message.blocks?.[0]?.content).toBe('READ_COLLAPSE_OUTPUT');
    expect(allAssistantItems[3].toolPairs[0].toolUse).toBeUndefined();
    expect(allAssistantItems[3].toolPairs[0].toolResult?.message.blocks?.[0]?.content).toBe('GREP_COLLAPSE_OUTPUT');
    expect(allItems.filter(item => item.type === 'system-group')).toHaveLength(2);
  });

  it('pairs inline assistant tool calls only across events hidden by the selected preset', () => {
    const grep = toolCall('Grep', 'grep-inline-hidden-event', { query: 'Context Builder' });
    const messages: SessionMessageDisplay[] = [
      {
        role: 'user',
        content: 'Search the context builder.',
        timestamp: '2026-05-03T10:00:00.000Z',
      },
      assistantWithTool(1, grep, 'I will search for the context builder.'),
      {
        role: 'system',
        content: 'Visible in All events, hidden in + Tools.',
        timestamp: '2026-05-03T10:00:02.000Z',
      },
      toolResult(3, 'grep-inline-hidden-event', 'INLINE_GREP_OUTPUT'),
    ];

    const toolAssistantItems = buildTranscriptItems(messages, 'tools').filter(item => item.type === 'assistant');
    expect(toolAssistantItems).toHaveLength(1);
    expect(toolAssistantItems[0].toolPairs).toHaveLength(1);
    expect(toolAssistantItems[0].toolPairs[0].toolUse?.message.toolCalls?.[0]?.id).toBe('grep-inline-hidden-event');
    expect(toolAssistantItems[0].toolPairs[0].toolResult?.message.blocks?.[0]?.content).toBe('INLINE_GREP_OUTPUT');
    expect(toolAssistantItems[0].message.toolCalls).toBeUndefined();

    const allItems = buildTranscriptItems(messages, 'all');
    const allAssistantItems = allItems.filter(item => item.type === 'assistant');
    expect(allAssistantItems).toHaveLength(2);
    expect(allAssistantItems[0].message.toolCalls?.[0]?.id).toBe('grep-inline-hidden-event');
    expect(allAssistantItems[0].toolPairs).toHaveLength(0);
    expect(allAssistantItems[1].toolPairs[0].toolUse).toBeUndefined();
    expect(allAssistantItems[1].toolPairs[0].toolResult?.message.blocks?.[0]?.content).toBe('INLINE_GREP_OUTPUT');
    expect(allItems.filter(item => item.type === 'system-group')).toHaveLength(1);
  });

  it('merges adjacent Claude tool cycles into one top-level + Tools turn', () => {
    const readOne = toolCall('Read', 'read-visual-1', { file_path: 'src/one.ts' });
    const readTwo = toolCall('Read', 'read-visual-2', { file_path: 'src/two.ts' });
    const write = toolCall('Write', 'write-visual-3', { file_path: 'src/design.md' });
    const messages: SessionMessageDisplay[] = [
      {
        role: 'user',
        content: 'Inspect and write the design.',
        timestamp: '2026-05-03T10:00:00.000Z',
      },
      toolUse(1, readOne),
      toolResult(2, 'read-visual-1', 'READ_ONE_OUTPUT'),
      assistantWithTool(3, readTwo, 'I will check one more file.'),
      toolResult(4, 'read-visual-2', 'READ_TWO_OUTPUT'),
      assistantWithTool(5, write, 'Now I have enough context.'),
      toolResult(6, 'write-visual-3', 'WRITE_OUTPUT'),
    ];

    const toolAssistantItems = buildTranscriptItems(messages, 'tools').filter(item => item.type === 'assistant');

    expect(toolAssistantItems).toHaveLength(1);
    expect(toolAssistantItems[0].message.content).toBe('I will check one more file.\n\nNow I have enough context.');
    expect(toolAssistantItems[0].toolPairs.map(pair => pair.toolUse?.message.toolCalls?.[0]?.id)).toEqual([
      'read-visual-1',
      'read-visual-2',
      'write-visual-3',
    ]);
    expect(toolAssistantItems[0].toolPairs.map(pair => pair.toolResult?.message.blocks?.[0]?.content)).toEqual([
      'READ_ONE_OUTPUT',
      'READ_TWO_OUTPUT',
      'WRITE_OUTPUT',
    ]);

    const allAssistantItems = buildTranscriptItems(messages, 'all').filter(item => item.type === 'assistant');
    expect(allAssistantItems).toHaveLength(3);
  });

  it('collapses repeated tool-use/result cycles into one Claude turn and combines usage and cost', () => {
    const readOne = toolCall('Read', 'read-cycle-1', { file_path: 'src/one.ts' });
    const readTwo = toolCall('Read', 'read-cycle-2', { file_path: 'src/two.ts' });
    const grep = toolCall('Grep', 'grep-cycle-3', { query: 'needle' });
    const messages: SessionMessageDisplay[] = [
      {
        role: 'user',
        content: 'Inspect these files.',
        timestamp: '2026-05-03T10:00:00.000Z',
      },
      toolUse(1, readOne, usage(100, 10)),
      toolResult(2, 'read-cycle-1', 'ONE_RESULT'),
      toolUse(3, readTwo, usage(200, 20)),
      toolResult(4, 'read-cycle-2', 'TWO_RESULT'),
      toolUse(5, grep, usage(300, 30)),
      toolResult(6, 'grep-cycle-3', 'GREP_RESULT'),
    ];

    const toolItems = buildTranscriptItems(messages, 'tools');
    const toolAssistantItems = toolItems.filter(item => item.type === 'assistant');

    expect(toolAssistantItems).toHaveLength(1);
    expect(toolAssistantItems[0].toolPairs.map(pair => pair.toolUse?.message.toolCalls?.[0]?.id)).toEqual([
      'read-cycle-1',
      'read-cycle-2',
      'grep-cycle-3',
    ]);
    expect(toolAssistantItems[0].toolPairs.map(pair => pair.toolResult?.message.blocks?.[0]?.content)).toEqual([
      'ONE_RESULT',
      'TWO_RESULT',
      'GREP_RESULT',
    ]);
    expect(toolAssistantItems[0].message.usage).toMatchObject({
      input_tokens: 600,
      output_tokens: 60,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    const expectedCosts = [
      calculateCostAllModes('claude-opus-4', 100, 10, 0, 0),
      calculateCostAllModes('claude-opus-4', 200, 20, 0, 0),
      calculateCostAllModes('claude-opus-4', 300, 30, 0, 0),
    ].reduce((sum, cost) => sum + cost.subscription, 0);
    expect(toolAssistantItems[0].message.estimatedCosts?.subscription).toBeCloseTo(expectedCosts, 12);
  });
});
