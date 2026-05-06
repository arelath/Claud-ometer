import { buildAssistantTurnMetrics } from '@/lib/assistant-turn-metrics';
import type { SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';
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
    ? mergeAdjacentAssistantGroups(groupedMessages)
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
