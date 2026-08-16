import { describe, expect, it } from 'vitest';
import {
  buildTranscriptItems,
  buildTranscriptMarkdown,
  getMinimapTargets,
  getToolResultId,
  groupMessages,
  insertCompactionMarkers,
  messagePassesPreset,
} from '@/lib/session-transcript';
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

function reasoning(index: number, summary = 'Reasoning summary', content = ''): SessionMessageDisplay {
  return {
    role: 'assistant',
    content: '',
    timestamp: `2026-05-03T10:00:${String(index).padStart(2, '0')}.000Z`,
    messageId: `reasoning-${index}`,
    model: 'gpt-5.5',
    blocks: [{
      type: 'thinking',
      title: 'Reasoning',
      summary,
      content,
      details: [],
    }],
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

  it('collapses repeated Codex reasoning summaries in the + Tools view', () => {
    const read = toolCall('shell_command', 'codex-shell-1', { command: 'npm test' });
    const messages: SessionMessageDisplay[] = [
      {
        role: 'user',
        content: 'Run the test suite.',
        timestamp: '2026-05-03T10:00:00.000Z',
      },
      reasoning(1),
      toolUse(2, read),
      toolResult(3, 'codex-shell-1', 'PASS'),
      reasoning(4),
      reasoning(5),
      reasoning(6, 'Need one final check.'),
    ];

    const toolAssistantItems = buildTranscriptItems(messages, 'tools').filter(item => item.type === 'assistant');
    expect(toolAssistantItems).toHaveLength(1);
    expect((toolAssistantItems[0].message.blocks || [])
      .filter(block => block.type === 'thinking')
      .map(block => block.summary)).toEqual([
      'Reasoning summary',
      'Need one final check.',
    ]);

    const allReasoningSummaries = buildTranscriptItems(messages, 'all')
      .filter(item => item.type === 'assistant')
      .flatMap(item => item.message.blocks || [])
      .filter(block => block.type === 'thinking' && block.summary === 'Reasoning summary');
    expect(allReasoningSummaries).toHaveLength(3);
  });

  it('handles standalone tool results, empty assistant runs, compaction placement, and minimap targets', () => {
    const hiddenAssistant: SessionMessageDisplay = {
      role: 'assistant',
      content: '',
      timestamp: 'not-a-date',
      blocks: [{ type: 'thinking', title: 'Thinking', summary: '', details: [] }],
    };
    const result = toolResult(1, 'tool-missing-parent', 'ORPHAN_RESULT');
    const system: SessionMessageDisplay = {
      role: 'command',
      content: 'npm test',
      timestamp: '2026-05-03T10:00:02.000Z',
    };
    const user: SessionMessageDisplay = {
      role: 'user',
      content: 'Continue.',
      timestamp: '2026-05-03T10:00:03.000Z',
    };

    expect(getToolResultId(result)).toBe('tool-missing-parent');
    expect(getToolResultId({ ...result, blocks: [] })).toBeUndefined();

    const groups = groupMessages([
      { message: hiddenAssistant, index: 0 },
      { message: result, index: 1 },
      { message: system, index: 2 },
      { message: user, index: 3 },
    ]);

    expect(groups[0]).toMatchObject({ type: 'assistant', index: 0 });
    expect(groups[1]).toMatchObject({ type: 'system-group' });
    expect(groups[2]).toMatchObject({ type: 'user', index: 3 });

    const withCompactions = insertCompactionMarkers(groups, [
      'invalid-date',
      '2026-05-03T10:00:01.000Z',
      '2026-05-03T10:00:02.500Z',
      '2026-05-03T10:00:04.000Z',
    ]);

    expect(withCompactions.filter(item => item.type === 'compaction')).toHaveLength(2);
    expect(getMinimapTargets(withCompactions).map(target => target.targetId)).toEqual(expect.arrayContaining([
      'conversation-message-0',
      'conversation-message-2',
      'conversation-message-3',
      'conversation-compaction-0',
      'conversation-compaction-1',
      'conversation-compaction-2',
    ]));
  });

  it('filters transcript items by preset and tool name without dropping user context', () => {
    const read = toolCall('Read', 'read-filter-1', { file_path: 'src/one.ts' });
    const edit = toolCall('Edit', 'edit-filter-2', { file_path: 'src/two.ts' });
    const messages: SessionMessageDisplay[] = [
      { role: 'user', content: 'Use tools.', timestamp: '2026-05-03T10:00:00.000Z' },
      assistantWithTool(1, read),
      toolResult(2, 'read-filter-1', 'READ_OUTPUT'),
      assistantWithTool(3, edit),
      toolResult(4, 'edit-filter-2', 'EDIT_OUTPUT'),
      { role: 'system', content: 'hidden when filtering', timestamp: '2026-05-03T10:00:05.000Z' },
    ];

    expect(messagePassesPreset(messages[5], 'narrative')).toBe(false);
    expect(messagePassesPreset(messages[5], 'tools')).toBe(false);
    expect(messagePassesPreset(messages[5], 'all')).toBe(true);

    const readItems = buildTranscriptItems(messages, 'tools', [], 'Read');

    expect(readItems.some(item => item.type === 'user')).toBe(true);
    const assistantItems = readItems.filter(item => item.type === 'assistant');
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0].toolPairs[0].toolUse?.message.toolCalls?.[0]?.name).toBe('Read');
  });

  it('serializes the currently visible transcript items as markdown', () => {
    const read = toolCall('Read', 'read-markdown-1', { file_path: 'src/one.ts' });
    const messages: SessionMessageDisplay[] = [
      { role: 'user', content: 'Use a tool.', timestamp: '2026-05-03T10:00:00.000Z' },
      toolUse(1, read),
      toolResult(2, 'read-markdown-1', 'READ_MARKDOWN_OUTPUT'),
      { role: 'system', content: 'hidden until all events', timestamp: '2026-05-03T10:00:03.000Z' },
    ];

    const narrativeMarkdown = buildTranscriptMarkdown(buildTranscriptItems(messages, 'narrative'), { assistantLabel: 'Claude' });
    expect(narrativeMarkdown).toContain('## User (2026-05-03T10:00:00.000Z)');
    expect(narrativeMarkdown).toContain('Use a tool.');
    expect(narrativeMarkdown).not.toContain('### Tool: Read');
    expect(narrativeMarkdown).not.toContain('READ_MARKDOWN_OUTPUT');

    const toolsMarkdown = buildTranscriptMarkdown(buildTranscriptItems(messages, 'tools'), { assistantLabel: 'Claude' });
    expect(toolsMarkdown).toContain('## Claude (2026-05-03T10:00:01.000Z)');
    expect(toolsMarkdown).toContain('### Tool: Read (read-markdown-1)');
    expect(toolsMarkdown).toContain('- file_path: `src/one.ts`');
    expect(toolsMarkdown).toContain('### Tool Result: Text (read-markdown-1)');
    expect(toolsMarkdown).toContain("```text\nREAD_MARKDOWN_OUTPUT\n```");
    expect(toolsMarkdown).not.toContain('hidden until all events');

    const allMarkdown = buildTranscriptMarkdown(buildTranscriptItems(messages, 'all'), { assistantLabel: 'Claude' });
    expect(allMarkdown).toContain('## System Events');
    expect(allMarkdown).toContain('hidden until all events');
  });

  it('keeps subagent turns and tool results isolated from the parent transcript', () => {
    const child = {
      id: 'child-session',
      parentId: 'parent-session',
      nickname: 'Faraday',
      role: 'code_searcher',
      path: '/root/subagent_metadata',
      depth: 1,
    };
    const rootTool = toolCall('Read', 'shared-tool-id', { file_path: 'src/root.ts' });
    const childTool = toolCall('Read', 'shared-tool-id', { file_path: 'src/child.ts' });
    const messages: SessionMessageDisplay[] = [
      { role: 'user', content: 'Inspect the repository.', timestamp: '2026-05-03T10:00:00.000Z' },
      assistantWithTool(1, rootTool, 'Parent starts reading.'),
      {
        role: 'user',
        content: 'Find the subagent metadata fields.',
        timestamp: '2026-05-03T10:00:02.000Z',
        subagent: child,
      },
      {
        ...assistantWithTool(3, childTool, 'Child starts reading.'),
        subagent: child,
      },
      {
        ...toolResult(4, 'shared-tool-id', 'CHILD_RESULT'),
        subagent: child,
      },
      { role: 'assistant', content: 'Parent conclusion.', timestamp: '2026-05-03T10:00:05.000Z' },
    ];

    const items = buildTranscriptItems(messages, 'tools');
    const assistantItems = items.filter(item => item.type === 'assistant');

    expect(assistantItems).toHaveLength(3);
    expect(assistantItems[0].message.content).toBe('Parent starts reading.');
    expect(assistantItems[0].toolPairs[0]?.toolResult).toBeUndefined();
    expect(assistantItems[1].message.subagent).toEqual(child);
    expect(assistantItems[1].toolPairs[0]?.toolResult?.message.content).toBe('');
    expect(assistantItems[1].toolPairs[0]?.toolResult?.message.blocks?.[0]?.content).toBe('CHILD_RESULT');
    expect(assistantItems[2].message.content).toBe('Parent conclusion.');

    const markdown = buildTranscriptMarkdown(items, { assistantLabel: 'Codex' });
    expect(markdown).toContain('> Subagent: Faraday · code_searcher · /root/subagent_metadata');
    expect(markdown).toContain('Find the subagent metadata fields.');
    expect(markdown).toContain('Child starts reading.');
    expect(markdown).toContain('CHILD_RESULT');
  });

  it('keeps child compactions attributed and outside a root assistant timeline', () => {
    const child = {
      id: 'child-session',
      parentId: 'parent-session',
      nickname: 'Faraday',
      role: 'code_searcher',
      path: '/root/subagent_metadata',
      depth: 1,
    };
    const read = toolCall('Read', 'root-read', { file_path: 'src/root.ts' });
    const result = toolResult(5, 'root-read', 'ROOT_RESULT');
    const messages: SessionMessageDisplay[] = [
      { role: 'assistant', content: 'Root tool run.', timestamp: '2026-05-03T10:00:01.000Z' },
      toolUse(2, read),
      {
        role: 'system',
        content: 'Context compacted',
        timestamp: '2026-05-03T10:00:03.000Z',
        isMeta: true,
        subagent: child,
      },
      result,
    ];

    const items = buildTranscriptItems(messages, 'tools', ['2026-05-03T10:00:03.000Z']);
    const assistant = items.find(item => item.type === 'assistant');
    const compaction = items.find(item => item.type === 'compaction');

    expect(items.map(item => item.type)).toEqual(['assistant', 'compaction', 'assistant']);
    expect(assistant?.type === 'assistant' ? assistant.toolTimeline : []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'compaction' }),
    ]));
    expect(assistant?.type === 'assistant' ? assistant.toolPairs[0]?.toolResult : undefined).toBeUndefined();
    expect(items[2].type === 'assistant' ? items[2].toolPairs[0]?.toolResult?.message.blocks?.[0]?.content : undefined)
      .toBe('ROOT_RESULT');
    expect(compaction).toMatchObject({ type: 'compaction', subagent: child });
    const markdown = buildTranscriptMarkdown(items, { assistantLabel: 'Codex' });
    expect(markdown).toContain('> Subagent: Faraday · code_searcher · /root/subagent_metadata');
    expect(markdown.indexOf('Context Window Compaction')).toBeLessThan(markdown.indexOf('ROOT_RESULT'));
  });
});
