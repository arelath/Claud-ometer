import { buildAssistantTurnMetrics } from '@/lib/assistant-turn-metrics';
import type { SessionMessageBlockDisplay, SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';
import { detailMatchesKey } from '@/lib/string-utils';

export type FilterPreset = 'narrative' | 'tools' | 'all';

export type GroupedItem =
  | { type: 'user'; message: SessionMessageDisplay; index: number }
  | { type: 'assistant'; message: SessionMessageDisplay; index: number; toolPairs: ToolPair[]; toolTimeline?: AssistantTimelineItem[] }
  | { type: 'system-group'; messages: { message: SessionMessageDisplay; index: number }[] };

export interface CompactionMarker {
  type: 'compaction';
  timestamp: string;
  index: number;
  targetId: string;
}

export type TranscriptItem = GroupedItem | CompactionMarker;

export interface ToolPair {
  toolUse?: { message: SessionMessageDisplay; index: number };
  toolResult?: { message: SessionMessageDisplay; index: number };
}

export type AssistantTimelineItem =
  | { type: 'tool-pair'; pair: ToolPair }
  | CompactionMarker;

export interface TranscriptTarget {
  type: 'user' | 'assistant' | 'system-group' | 'compaction';
  targetId: string;
}

function findDetail(
  details: SessionToolCallDisplay['details'],
  candidates: string[],
): SessionToolCallDisplay['details'][number] | undefined {
  return details.find(detail => detailMatchesKey(detail.key, candidates));
}

function hasVisibleAssistantContent(message: SessionMessageDisplay): boolean {
  if (message.content.trim()) return true;
  if ((message.toolCalls || []).length > 0) return true;
  return (message.blocks || []).some(block => {
    if (block.type === 'thinking') return Boolean(block.summary || block.content);
    return Boolean(block.summary || block.content || block.details.length > 0);
  });
}

function mergeAssistantRun(run: { message: SessionMessageDisplay; index: number }[]): SessionMessageDisplay | null {
  const visibleMessages = run.filter(({ message }) => hasVisibleAssistantContent(message));
  if (visibleMessages.length === 0) return null;

  const first = run[0].message;
  const lastVisible = visibleMessages[visibleMessages.length - 1].message;
  const assistantMetrics = buildAssistantTurnMetrics(run.map(({ message }) => message));
  const content = visibleMessages
    .map(({ message }) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const toolCalls = visibleMessages.flatMap(({ message }) => message.toolCalls || []);
  const blocks = visibleMessages.flatMap(({ message }) => message.blocks || []);

  return {
    role: 'assistant',
    content,
    timestamp: lastVisible.timestamp || first.timestamp,
    model: lastVisible.model || first.model,
    usage: assistantMetrics.usage,
    estimatedCosts: assistantMetrics.estimatedCosts,
    promptBreakdown: lastVisible.promptBreakdown,
    stopReason: lastVisible.stopReason || first.stopReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
    isMeta: run.some(({ message }) => Boolean(message.isMeta)),
  };
}

function normalizeReasoningKeyPart(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getThinkingBlockKey(block: SessionMessageBlockDisplay): string | null {
  if (block.type !== 'thinking') return null;
  const summary = normalizeReasoningKeyPart(block.summary);
  const content = normalizeReasoningKeyPart(block.content);
  if (!summary && !content) return null;
  return `${summary}\0${content}`;
}

function collapseRepeatedThinkingBlocks(
  message: SessionMessageDisplay,
  seenThinking: Set<string>,
): SessionMessageDisplay {
  const blocks = message.blocks;
  if (!blocks || blocks.length === 0) return message;

  let changed = false;
  const nextBlocks = blocks.filter(block => {
    const key = getThinkingBlockKey(block);
    if (!key) return true;
    if (seenThinking.has(key)) {
      changed = true;
      return false;
    }
    seenThinking.add(key);
    return true;
  });

  if (!changed) return message;
  return {
    ...message,
    blocks: nextBlocks.length > 0 ? nextBlocks : undefined,
  };
}

function collapseRepeatedAssistantReasoning(group: Extract<GroupedItem, { type: 'assistant' }>): Extract<GroupedItem, { type: 'assistant' }> {
  const seenThinking = new Set<string>();
  const message = collapseRepeatedThinkingBlocks(group.message, seenThinking);
  let changed = message !== group.message;

  const toolPairs = group.toolPairs.map(pair => {
    if (!pair.toolUse) return pair;
    const toolUseMessage = collapseRepeatedThinkingBlocks(pair.toolUse.message, seenThinking);
    if (toolUseMessage === pair.toolUse.message) return pair;
    changed = true;
    return {
      ...pair,
      toolUse: {
        ...pair.toolUse,
        message: toolUseMessage,
      },
    };
  });

  if (!changed) return group;
  return {
    ...group,
    message,
    toolPairs,
  };
}

function collapseRepeatedReasoningInToolsView(groups: GroupedItem[]): GroupedItem[] {
  return groups.map(group => (
    group.type === 'assistant' ? collapseRepeatedAssistantReasoning(group) : group
  ));
}

function parseTimestampMs(timestamp?: string): number | null {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function getGroupTimeRange(group: GroupedItem): { start: number; end: number } | null {
  const timestamps: string[] = [];

  if (group.type === 'user') {
    timestamps.push(group.message.timestamp);
  } else if (group.type === 'assistant') {
    timestamps.push(group.message.timestamp);
    for (const pair of group.toolPairs) {
      if (pair.toolUse?.message.timestamp) timestamps.push(pair.toolUse.message.timestamp);
      if (pair.toolResult?.message.timestamp) timestamps.push(pair.toolResult.message.timestamp);
    }
  } else {
    timestamps.push(...group.messages.map(({ message }) => message.timestamp));
  }

  const times = timestamps
    .map(timestamp => parseTimestampMs(timestamp))
    .filter((time): time is number => time != null);

  if (times.length === 0) return null;
  return {
    start: Math.min(...times),
    end: Math.max(...times),
  };
}

function getToolPairTimeRange(pair: ToolPair): { start: number; end: number } | null {
  const times = [
    parseTimestampMs(pair.toolUse?.message.timestamp),
    parseTimestampMs(pair.toolResult?.message.timestamp),
  ].filter((time): time is number => time != null);

  if (times.length === 0) return null;
  return {
    start: Math.min(...times),
    end: Math.max(...times),
  };
}

function buildCompactionMarker(timestamp: string, index: number): CompactionMarker {
  return {
    type: 'compaction',
    timestamp,
    index,
    targetId: `conversation-compaction-${index}`,
  };
}

function insertCompactionsIntoAssistantTimeline(group: Extract<GroupedItem, { type: 'assistant' }>, markers: CompactionMarker[]): Extract<GroupedItem, { type: 'assistant' }> {
  if (markers.length === 0) return group;

  const markerQueue = markers
    .map(marker => ({ marker, time: parseTimestampMs(marker.timestamp) }))
    .filter((item): item is { marker: CompactionMarker; time: number } => item.time != null)
    .sort((left, right) => left.time - right.time);

  if (markerQueue.length === 0) return group;

  const timeline: AssistantTimelineItem[] = [];
  let markerIndex = 0;
  const fallbackGroupStart = getGroupTimeRange(group)?.start ?? Number.NEGATIVE_INFINITY;

  for (const pair of group.toolPairs) {
    const pairRange = getToolPairTimeRange(pair);
    const pairStart = pairRange?.start ?? fallbackGroupStart;
    const pairEnd = pairRange?.end ?? pairStart;

    while (markerIndex < markerQueue.length && markerQueue[markerIndex].time < pairStart) {
      timeline.push(markerQueue[markerIndex].marker);
      markerIndex++;
    }

    timeline.push({ type: 'tool-pair', pair });

    while (markerIndex < markerQueue.length && markerQueue[markerIndex].time <= pairEnd) {
      timeline.push(markerQueue[markerIndex].marker);
      markerIndex++;
    }
  }

  while (markerIndex < markerQueue.length) {
    timeline.push(markerQueue[markerIndex].marker);
    markerIndex++;
  }

  return { ...group, toolTimeline: timeline };
}

export function insertCompactionMarkers(groups: GroupedItem[], timestamps: string[]): TranscriptItem[] {
  const validTimestamps = timestamps
    .map(timestamp => ({ timestamp, time: parseTimestampMs(timestamp) }))
    .filter((item): item is { timestamp: string; time: number } => item.time != null)
    .sort((left, right) => left.time - right.time);

  if (validTimestamps.length === 0) return groups;

  const items: TranscriptItem[] = [];
  let compactionIndex = 0;

  for (const group of groups) {
    const range = getGroupTimeRange(group);
    if (!range) {
      items.push(group);
      continue;
    }

    const groupStart = range.start;
    const groupEnd = range.end;

    while (compactionIndex < validTimestamps.length && validTimestamps[compactionIndex].time < groupStart) {
      items.push(buildCompactionMarker(validTimestamps[compactionIndex].timestamp, compactionIndex));
      compactionIndex++;
    }

    const markersInsideGroup: CompactionMarker[] = [];
    while (compactionIndex < validTimestamps.length && validTimestamps[compactionIndex].time <= groupEnd) {
      markersInsideGroup.push(buildCompactionMarker(validTimestamps[compactionIndex].timestamp, compactionIndex));
      compactionIndex++;
    }

    items.push(group.type === 'assistant'
      ? insertCompactionsIntoAssistantTimeline(group, markersInsideGroup)
      : group);

    if (group.type !== 'assistant') {
      items.push(...markersInsideGroup);
    }
  }

  while (compactionIndex < validTimestamps.length) {
    items.push(buildCompactionMarker(validTimestamps[compactionIndex].timestamp, compactionIndex));
    compactionIndex++;
  }

  return items;
}

export function getToolResultId(message: SessionMessageDisplay): string | undefined {
  for (const block of message.blocks || []) {
    const toolUseId = findDetail(block.details, ['tool_use_id', 'toolUseId'])?.value;
    if (toolUseId) return toolUseId;
  }
  return undefined;
}

function buildSyntheticToolUseMessage(source: SessionMessageDisplay, tool: SessionToolCallDisplay): SessionMessageDisplay {
  return {
    role: 'tool-use',
    content: '',
    timestamp: source.timestamp,
    messageId: source.messageId,
    model: source.model,
    usage: source.usage,
    estimatedCosts: source.estimatedCosts,
    promptBreakdown: source.promptBreakdown,
    stopReason: source.stopReason,
    toolCalls: [tool],
    blocks: (source.blocks || []).filter(block => block.type === 'thinking'),
    isMeta: source.isMeta,
  };
}

function isToolFlowMessage(message: SessionMessageDisplay): boolean {
  return message.role === 'tool-use' || message.role === 'tool-result';
}

function findMatchingToolResult(
  items: { message: SessionMessageDisplay; index: number }[],
  toolId: string | undefined,
  afterIndex: number,
  consumedIndexes: Set<number>,
): { message: SessionMessageDisplay; index: number } | undefined {
  if (!toolId) return undefined;

  for (let itemIndex = afterIndex + 1; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    if (!isToolFlowMessage(item.message)) break;
    if (consumedIndexes.has(itemIndex)) continue;
    if (item.message.role === 'tool-result' && getToolResultId(item.message) === toolId) {
      return item;
    }
  }

  return undefined;
}

function buildEmptyAssistantMessage(
  run: { message: SessionMessageDisplay; index: number }[],
  assistantMetrics: ReturnType<typeof buildAssistantTurnMetrics>,
): SessionMessageDisplay {
  const last = run[run.length - 1].message;
  return {
    role: 'assistant',
    content: '',
    timestamp: last.timestamp,
    model: last.model,
    usage: assistantMetrics.usage,
    estimatedCosts: assistantMetrics.estimatedCosts,
    stopReason: last.stopReason,
    isMeta: run.some(({ message }) => Boolean(message.isMeta)),
  };
}

function consumeStandaloneToolUseRun(
  items: { message: SessionMessageDisplay; index: number }[],
  startIndex: number,
  consumedIndexes: Set<number>,
): { group: Extract<GroupedItem, { type: 'assistant' }>; nextIndex: number } {
  const { index } = items[startIndex];
  const toolUseRun: { message: SessionMessageDisplay; index: number }[] = [];
  const toolPairs: ToolPair[] = [];
  const pairedToolIds = new Set<string>();
  let j = startIndex;

  while (j < items.length) {
    if (consumedIndexes.has(j)) {
      j++;
      continue;
    }

    const item = items[j];
    if (item.message.role === 'tool-result') {
      toolPairs.push({ toolResult: item });
      consumedIndexes.add(j);
      j++;
      continue;
    }

    if (item.message.role !== 'tool-use') break;

    toolUseRun.push(item);
    const tools = item.message.toolCalls || [];
    if (tools.length === 0) {
      toolPairs.push({ toolUse: item });
    } else {
      for (const tool of tools) {
        const pair: ToolPair = {
          toolUse: tools.length === 1
            ? item
            : { message: buildSyntheticToolUseMessage(item.message, tool), index: item.index },
        };
        const matchedResult = findMatchingToolResult(items, tool.id, j, consumedIndexes);
        if (matchedResult) {
          pair.toolResult = matchedResult;
          consumedIndexes.add(items.indexOf(matchedResult));
        }
        toolPairs.push(pair);
        if (tool.id) pairedToolIds.add(tool.id);
      }
    }

    j++;
  }

  const mergedMessage = mergeAssistantRun(toolUseRun);
  if (mergedMessage?.toolCalls && pairedToolIds.size > 0) {
    const unpairedToolCalls = mergedMessage.toolCalls.filter(tool => !pairedToolIds.has(tool.id));
    mergedMessage.toolCalls = unpairedToolCalls.length > 0 ? unpairedToolCalls : undefined;
  }

  const assistantMetrics = buildAssistantTurnMetrics(toolUseRun.map(({ message }) => message));

  return {
    group: {
      type: 'assistant',
      message: mergedMessage || buildEmptyAssistantMessage(toolUseRun, assistantMetrics),
      index,
      toolPairs,
    },
    nextIndex: j,
  };
}

/** Group messages: pair tool-use/tool-result with their parent assistant, collapse consecutive system messages, merge consecutive empty assistant turns. */
export function groupMessages(items: { message: SessionMessageDisplay; index: number }[]): GroupedItem[] {
  const groups: GroupedItem[] = [];
  const consumedIndexes = new Set<number>();
  let i = 0;

  while (i < items.length) {
    if (consumedIndexes.has(i)) {
      i++;
      continue;
    }

    const { message, index } = items[i];

    if (message.role === 'user') {
      groups.push({ type: 'user', message, index });
      i++;
    } else if (message.role === 'assistant') {
      const assistantRun = [{ message, index }];
      let j = i + 1;
      while (j < items.length && items[j].message.role === 'assistant') {
        assistantRun.push(items[j]);
        j++;
      }

      const toolPairs: ToolPair[] = [];
      const mergedMessage = mergeAssistantRun(assistantRun);
      const assistantMetrics = buildAssistantTurnMetrics(assistantRun.map(({ message: runMessage }) => runMessage));
      const pairedInlineToolIds = new Set<string>();

      if (mergedMessage?.toolCalls) {
        for (const tool of mergedMessage.toolCalls) {
          const matchedResult = findMatchingToolResult(items, tool.id, j - 1, consumedIndexes);
          if (!matchedResult) continue;

          const owner = assistantRun.find(({ message: runMessage }) => (
            (runMessage.toolCalls || []).some(runTool => runTool.id === tool.id)
          )) || assistantRun[assistantRun.length - 1];

          toolPairs.push({
            toolUse: {
              message: buildSyntheticToolUseMessage(owner.message, tool),
              index: owner.index,
            },
            toolResult: matchedResult,
          });
          consumedIndexes.add(items.indexOf(matchedResult));
          pairedInlineToolIds.add(tool.id);
        }

        if (pairedInlineToolIds.size > 0) {
          const unpairedToolCalls = mergedMessage.toolCalls.filter(tool => !pairedInlineToolIds.has(tool.id));
          mergedMessage.toolCalls = unpairedToolCalls.length > 0 ? unpairedToolCalls : undefined;
        }
      }

      while (j < items.length) {
        if (consumedIndexes.has(j)) {
          j++;
          continue;
        }

        const next = items[j];
        if (next.message.role === 'tool-use') {
          const pair: ToolPair = { toolUse: next };
          j++;
          const toolId = next.message.toolCalls?.[0]?.id;
          const matchedResult = findMatchingToolResult(items, toolId, j - 1, consumedIndexes);
          if (matchedResult) {
            pair.toolResult = matchedResult;
            consumedIndexes.add(items.indexOf(matchedResult));
          } else if (j < items.length && !consumedIndexes.has(j) && items[j].message.role === 'tool-result') {
            pair.toolResult = items[j];
            consumedIndexes.add(j);
            j++;
          }
          toolPairs.push(pair);
        } else if (next.message.role === 'tool-result') {
          toolPairs.push({ toolResult: next });
          j++;
        } else {
          break;
        }
      }

      if (!mergedMessage && toolPairs.length === 0) {
        i = j;
        continue;
      }

      groups.push({
        type: 'assistant',
        message: mergedMessage || buildEmptyAssistantMessage(assistantRun, assistantMetrics),
        index,
        toolPairs,
      });
      i = j;
    } else if (message.role === 'system' || message.role === 'command') {
      const systemBatch: { message: SessionMessageDisplay; index: number }[] = [{ message, index }];
      let j = i + 1;
      while (j < items.length && (items[j].message.role === 'system' || items[j].message.role === 'command')) {
        systemBatch.push(items[j]);
        j++;
      }
      groups.push({ type: 'system-group', messages: systemBatch });
      i = j;
    } else if (message.role === 'tool-use') {
      const { group, nextIndex } = consumeStandaloneToolUseRun(items, i, consumedIndexes);
      groups.push(group);
      i = nextIndex;
    } else if (message.role === 'tool-result') {
      groups.push({ type: 'assistant', message: { ...message, role: 'assistant', content: '' }, index, toolPairs: [{ toolResult: { message, index } }] });
      i++;
    } else {
      i++;
    }
  }

  return groups;
}

function mergeAdjacentAssistantGroups(groups: GroupedItem[]): GroupedItem[] {
  const mergedGroups: GroupedItem[] = [];
  let assistantRun: Extract<GroupedItem, { type: 'assistant' }>[] = [];

  const flushAssistantRun = () => {
    if (assistantRun.length === 0) return;

    if (assistantRun.length === 1) {
      mergedGroups.push(assistantRun[0]);
      assistantRun = [];
      return;
    }

    const runMessages = assistantRun.map(group => ({
      message: group.message,
      index: group.index,
    }));
    const mergedMessage = mergeAssistantRun(runMessages);
    const assistantMetrics = buildAssistantTurnMetrics(assistantRun.map(group => group.message));
    const toolPairs = assistantRun.flatMap(group => group.toolPairs);
    const firstGroup = assistantRun[0];

    mergedGroups.push({
      type: 'assistant',
      message: mergedMessage || buildEmptyAssistantMessage(runMessages, assistantMetrics),
      index: firstGroup.index,
      toolPairs,
    });
    assistantRun = [];
  };

  for (const group of groups) {
    if (group.type === 'assistant') {
      assistantRun.push(group);
      continue;
    }

    flushAssistantRun();
    mergedGroups.push(group);
  }

  flushAssistantRun();
  return mergedGroups;
}

export function messagePassesPreset(msg: SessionMessageDisplay, preset: FilterPreset): boolean {
  if (preset === 'all') return true;
  if (preset === 'tools') {
    return msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool-use' || msg.role === 'tool-result' || msg.role === 'command';
  }
  return msg.role === 'user' || msg.role === 'assistant';
}

function itemMatchesToolFilter(item: TranscriptItem, toolFilter: string | null): boolean {
  if (!toolFilter) return true;
  if (item.type === 'compaction') return true;
  if (item.type === 'user') return true;
  if (item.type === 'system-group') return false;
  if (item.type === 'assistant') {
    const inlineTools = item.message.toolCalls || [];
    const pairedTools = item.toolPairs.flatMap(pair => pair.toolUse?.message.toolCalls || []);
    return [...inlineTools, ...pairedTools].some(tool => tool.name === toolFilter);
  }
  return true;
}

export function buildTranscriptItems(
  messages: SessionMessageDisplay[],
  preset: FilterPreset,
  compactionTimestamps: string[] = [],
  toolFilter: string | null = null,
): TranscriptItem[] {
  const groupedMessages = groupMessages(
    messages.map((message, index) => ({ message, index })).filter(({ message }) => messagePassesPreset(message, preset)),
  );
  const baseGroups = preset === 'tools'
    ? collapseRepeatedReasoningInToolsView(mergeAdjacentAssistantGroups(groupedMessages))
    : groupedMessages;
  const groups = insertCompactionMarkers(baseGroups, compactionTimestamps);
  return groups.filter(group => itemMatchesToolFilter(group, toolFilter));
}

function getTranscriptItemTargetId(item: TranscriptItem): string | null {
  if (item.type === 'compaction') return item.targetId;
  const index = item.type === 'system-group' ? item.messages[0].index : item.index;
  return `conversation-message-${index}`;
}

export function getMinimapTargets(items: TranscriptItem[]): TranscriptTarget[] {
  const targets: TranscriptTarget[] = [];

  for (const item of items) {
    if (item.type === 'compaction') {
      targets.push({ type: 'compaction', targetId: item.targetId });
      continue;
    }

    const targetId = getTranscriptItemTargetId(item);
    if (targetId) targets.push({ type: item.type, targetId });

    if (item.type === 'assistant') {
      for (const nestedItem of item.toolTimeline || []) {
        if (nestedItem.type === 'compaction') {
          targets.push({ type: 'compaction', targetId: nestedItem.targetId });
        }
      }
    }
  }

  return targets;
}

export interface TranscriptMarkdownOptions {
  assistantLabel?: string;
}

const MARKDOWN_DETAIL_NOISE_KEYS = new Set([
  'type',
  'description',
  'cache_control',
  'sourceToolAssistantUUID',
  'tool_use_id',
  'toolUseId',
  'leafUuid',
  'messageId',
  'uuid',
  'parent_tool_use_id',
]);

function normalizeMarkdownText(value: string | undefined): string {
  return (value || '').replace(/\r\n?/g, '\n').trim();
}

function formatMarkdownTimestamp(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function headingWithTimestamp(level: number, title: string, timestamp: string | undefined): string {
  const stamp = formatMarkdownTimestamp(timestamp);
  return `${'#'.repeat(level)} ${title}${stamp ? ` (${stamp})` : ''}`;
}

function maxBacktickRun(value: string): number {
  return Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
}

function markdownCodeSpan(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '``';
  const fence = '`'.repeat(maxBacktickRun(normalized) + 1);
  const needsPadding = normalized.startsWith('`') || normalized.endsWith('`');
  return `${fence}${needsPadding ? ' ' : ''}${normalized}${needsPadding ? ' ' : ''}${fence}`;
}

function markdownFence(content: string, language = 'text'): string {
  const normalized = content.replace(/\r\n?/g, '\n').replace(/\s+$/g, '');
  const fence = '`'.repeat(Math.max(3, maxBacktickRun(normalized) + 1));
  return `${fence}${language}\n${normalized}\n${fence}`;
}

function shouldIncludeMarkdownDetail(detail: SessionToolCallDisplay['details'][number]): boolean {
  const keyTail = detail.key.split('.').pop() || detail.key;
  const value = normalizeMarkdownText(detail.value);
  if (!value || value === '[]' || value === '""' || value === '{}') return false;
  return !MARKDOWN_DETAIL_NOISE_KEYS.has(keyTail);
}

function appendMarkdownDetails(parts: string[], details: SessionToolCallDisplay['details']): void {
  const visibleDetails = details.filter(shouldIncludeMarkdownDetail);
  if (visibleDetails.length === 0) return;

  parts.push('#### Details');
  for (const detail of visibleDetails) {
    const value = normalizeMarkdownText(detail.value);
    if (value.includes('\n')) {
      parts.push(`- ${detail.label || detail.key}:\n\n${markdownFence(value)}`);
    } else {
      parts.push(`- ${detail.label || detail.key}: ${markdownCodeSpan(value)}`);
    }
  }
}

function appendMarkdownBlocks(parts: string[], blocks: SessionMessageBlockDisplay[] | undefined, type: SessionMessageBlockDisplay['type']): void {
  for (const block of (blocks || []).filter(item => item.type === type)) {
    if (type === 'thinking') {
      const summary = normalizeMarkdownText(block.summary);
      if (summary) parts.push(`> Thinking: ${summary}`);
      continue;
    }

    parts.push(`### ${block.title || 'Event'}`);
    const summary = normalizeMarkdownText(block.summary);
    const content = normalizeMarkdownText(block.content);
    if (summary && summary !== content) parts.push(summary);
    appendMarkdownDetails(parts, block.details);
    if (content) parts.push(markdownFence(content));
  }
}

function appendMarkdownArtifact(parts: string[], tool: SessionToolCallDisplay): void {
  const artifact = tool.artifact;
  if (!artifact) return;

  const title = normalizeMarkdownText(artifact.title) || 'Artifact';
  parts.push(`#### Artifact: ${title}`);

  if (artifact.kind === 'text') {
    const content = normalizeMarkdownText(artifact.content);
    if (content) parts.push(markdownFence(content));
    return;
  }

  if (artifact.kind === 'diff') {
    const oldText = normalizeMarkdownText(artifact.oldText);
    const newText = normalizeMarkdownText(artifact.newText);
    const diffText = [
      '--- old',
      '+++ new',
      oldText ? oldText.split('\n').map(line => `-${line}`).join('\n') : '',
      newText ? newText.split('\n').map(line => `+${line}`).join('\n') : '',
    ].filter(Boolean).join('\n');
    if (diffText) parts.push(markdownFence(diffText, 'diff'));
  }
}

function appendMarkdownToolCall(parts: string[], tool: SessionToolCallDisplay): void {
  const idLabel = tool.id ? ` (${tool.id})` : '';
  parts.push(`### Tool: ${tool.name}${idLabel}`);

  const summary = normalizeMarkdownText(tool.summary);
  if (summary && summary !== tool.name) parts.push(summary);
  appendMarkdownDetails(parts, tool.details);
  appendMarkdownArtifact(parts, tool);
}

function appendMarkdownToolResult(parts: string[], message: SessionMessageDisplay): void {
  const resultId = getToolResultId(message);
  const blocks = message.blocks || [];
  const messageContent = normalizeMarkdownText(message.content);

  if (blocks.length === 0) {
    parts.push(`### Tool Result${resultId ? ` (${resultId})` : ''}`);
    if (messageContent) parts.push(markdownFence(messageContent));
    return;
  }

  for (const block of blocks) {
    const content = normalizeMarkdownText(block.content);
    const summary = normalizeMarkdownText(block.summary);
    parts.push(`### Tool Result: ${block.title || 'Output'}${resultId ? ` (${resultId})` : ''}`);
    if (messageContent && messageContent !== content && messageContent !== summary) {
      parts.push(messageContent);
    }
    if (summary && summary !== content) parts.push(summary);
    appendMarkdownDetails(parts, block.details);
    if (content) parts.push(markdownFence(content));
  }
}

function appendMarkdownToolPair(parts: string[], pair: ToolPair): void {
  if (pair.toolUse) {
    const toolUse = pair.toolUse.message;
    if (toolUse.content.trim()) parts.push(normalizeMarkdownText(toolUse.content));
    for (const tool of toolUse.toolCalls || []) appendMarkdownToolCall(parts, tool);
    appendMarkdownBlocks(parts, toolUse.blocks, 'thinking');
  }

  if (pair.toolResult) appendMarkdownToolResult(parts, pair.toolResult.message);
}

function appendMarkdownAssistant(parts: string[], item: Extract<GroupedItem, { type: 'assistant' }>, assistantLabel: string): void {
  parts.push(headingWithTimestamp(2, assistantLabel, item.message.timestamp));

  const content = normalizeMarkdownText(item.message.content);
  if (content) parts.push(content);

  appendMarkdownBlocks(parts, item.message.blocks, 'thinking');

  for (const tool of item.message.toolCalls || []) appendMarkdownToolCall(parts, tool);
  appendMarkdownBlocks(parts, item.message.blocks, 'event');

  const timeline = item.toolTimeline || item.toolPairs.map(pair => ({ type: 'tool-pair' as const, pair }));
  for (const timelineItem of timeline) {
    if (timelineItem.type === 'compaction') {
      appendMarkdownCompaction(parts, timelineItem);
    } else {
      appendMarkdownToolPair(parts, timelineItem.pair);
    }
  }
}

function appendMarkdownSystemGroup(parts: string[], item: Extract<GroupedItem, { type: 'system-group' }>): void {
  parts.push('## System Events');
  for (const { message } of item.messages) {
    const title = message.role === 'command' ? 'Command' : 'System';
    parts.push(headingWithTimestamp(3, title, message.timestamp));
    const content = normalizeMarkdownText(message.content);
    if (content) {
      parts.push(message.role === 'command' ? markdownFence(content, 'sh') : content);
    }
    appendMarkdownBlocks(parts, message.blocks, 'event');
  }
}

function appendMarkdownCompaction(parts: string[], item: CompactionMarker): void {
  const stamp = formatMarkdownTimestamp(item.timestamp);
  parts.push('---');
  parts.push(`_Context Window Compaction${stamp ? `: ${stamp}` : ''}_`);
}

export function buildTranscriptMarkdown(items: TranscriptItem[], options: TranscriptMarkdownOptions = {}): string {
  const parts: string[] = [];
  const assistantLabel = options.assistantLabel || 'Assistant';

  for (const item of items) {
    if (item.type === 'compaction') {
      appendMarkdownCompaction(parts, item);
    } else if (item.type === 'user') {
      parts.push(headingWithTimestamp(2, 'User', item.message.timestamp));
      const content = normalizeMarkdownText(item.message.content);
      if (content) parts.push(content);
    } else if (item.type === 'assistant') {
      appendMarkdownAssistant(parts, item, assistantLabel);
    } else if (item.type === 'system-group') {
      appendMarkdownSystemGroup(parts, item);
    }
  }

  const markdown = parts.filter(part => part.trim()).join('\n\n');
  return markdown ? `${markdown}\n` : '';
}
