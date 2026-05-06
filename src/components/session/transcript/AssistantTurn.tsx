'use client';

import { format } from 'date-fns';
import { Bot, Brain } from 'lucide-react';
import { getModelDisplayName } from '@/config/pricing';
import type { SessionMessageDisplay } from '@/lib/claude-data/types';
import { formatCost, formatTokens } from '@/lib/format';
import { useCostMode } from '@/lib/cost-mode-context';
import { getToolResultId, type AssistantTimelineItem, type ToolPair } from '@/lib/session-transcript';
import { ANTHROPIC_FILE_DETAIL_KEYS } from '@/config/anthropic-schema';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { findDetail } from '../detail-utils';
import { ToolCallInline, ToolResultInline } from './ToolCall';
import { CompactionDivider, ThinkingSummary, BlockCard } from './SystemEvent';

export function AssistantCard({ msg, index, toolPairs, toolTimeline }: {
  msg: SessionMessageDisplay;
  index: number;
  toolPairs: ToolPair[];
  toolTimeline?: AssistantTimelineItem[];
}) {
  const { pickCost } = useCostMode();
  const thinkingBlocks = (msg.blocks || []).filter(block => block.type === 'thinking');
  const eventBlocks = (msg.blocks || []).filter(block => block.type === 'event');

  const modelLabel = msg.model
    ? getModelDisplayName(msg.model)
    : null;

  const turnCost = pickCost(msg.estimatedCosts, 0);
  const nestedTimeline = toolTimeline || toolPairs.map(pair => ({ type: 'tool-pair' as const, pair }));
  const unpairedTools = msg.toolCalls || [];
  const fallbackSummary = (() => {
    if (msg.content) return null;
    const firstThink = thinkingBlocks.find(block => block.summary)?.summary;
    if (firstThink) return firstThink;
    if (unpairedTools.length === 1) {
      const tool = unpairedTools[0];
      const path = findDetail(tool.details, [...ANTHROPIC_FILE_DETAIL_KEYS])?.value;
      const command = findDetail(tool.details, ['command'])?.value;
      const query = findDetail(tool.details, ['query'])?.value;
      const arg = path || command?.split('\n')[0] || query;
      return arg ? `${tool.name} ${arg}` : tool.name;
    }
    if (unpairedTools.length > 1) {
      const names = Array.from(new Set(unpairedTools.map(tool => tool.name))).slice(0, 3).join(', ');
      return `${unpairedTools.length} tool calls - ${names}`;
    }
    return null;
  })();

  return (
    <div id={`conversation-message-${index}`} data-testid="assistant-turn">
      <div className="bg-card border border-border/50 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-[18px] h-[18px] rounded bg-amber-500/10 flex items-center justify-center">
            <Bot className="h-2.5 w-2.5 text-amber-600" />
          </div>
          <span className="text-[11px] font-medium text-foreground">Claude</span>
          {modelLabel && <span className="text-[11px] text-muted-foreground">{modelLabel}</span>}
          {msg.timestamp && !Number.isNaN(new Date(msg.timestamp).getTime()) && (
            <span className="text-[11px] text-muted-foreground">- {format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
          )}
          {msg.usage && (
            <div className="ml-auto flex gap-2.5 text-[11px] text-muted-foreground font-mono">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>down {formatTokens((msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0))}</span>
                </TooltipTrigger>
                <TooltipContent>Input tokens (including cache read)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>up {formatTokens(msg.usage.output_tokens || 0)}</span>
                </TooltipTrigger>
                <TooltipContent>Output tokens</TooltipContent>
              </Tooltip>
              {turnCost > 0.001 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-foreground/70">{formatCost(turnCost)}</span>
                  </TooltipTrigger>
                  <TooltipContent>Estimated cost this turn</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {msg.content && (
          <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
            {msg.content}
          </div>
        )}
        {!msg.content && fallbackSummary && (
          <div className="text-sm leading-relaxed text-foreground/70 italic">
            {fallbackSummary}
          </div>
        )}

        {thinkingBlocks.filter(block => block.summary).map((block, i) => (
          <ThinkingSummary key={`think-${i}`} block={block} />
        ))}

        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mt-2 border-t border-border/30 pt-2 space-y-0">
            {msg.toolCalls.map((tool, i) => <ToolCallInline key={tool.id || i} tool={tool} />)}
          </div>
        )}

        {eventBlocks.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] text-muted-foreground">{eventBlocks.length} event{eventBlocks.length === 1 ? '' : 's'}</summary>
            <div className="space-y-0 mt-1">{eventBlocks.map((block, i) => <BlockCard key={i} block={block} />)}</div>
          </details>
        )}
      </div>

      {nestedTimeline.length > 0 && (
        <div className="ml-4 border-l-2 border-border/50 pl-3 mt-1 space-y-1">
          {nestedTimeline.map((item, i) => {
            if (item.type === 'compaction') {
              return (
                <CompactionDivider
                  key={`nested-compaction-${item.index}-${item.timestamp}`}
                  timestamp={item.timestamp}
                  targetId={item.targetId}
                />
              );
            }

            const { pair } = item;
            const toolUseId = pair.toolUse?.message.toolCalls?.[0]?.id;
            const toolResultId = pair.toolResult ? getToolResultId(pair.toolResult.message) : undefined;

            return (
              <div
                key={i}
                data-testid="tool-io-pair"
                data-tool-use-id={toolUseId}
                data-tool-result-id={toolResultId}
                className="rounded border border-border/30 bg-card/40 overflow-hidden"
              >
                {pair.toolUse && (
                  <div id={`conversation-message-${pair.toolUse.index}`}>
                    {(pair.toolUse.message.toolCalls || []).map((tool, j) => (
                      <ToolCallInline key={tool.id || j} tool={tool} />
                    ))}
                    {(pair.toolUse.message.blocks || []).filter(block => block.type === 'thinking').filter(block => block.summary).map((block, j) => (
                      <div key={`think-${j}`} className="flex items-center gap-1.5 px-3 py-0.5 text-[11px] text-muted-foreground">
                        <Brain className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{block.summary}</span>
                      </div>
                    ))}
                  </div>
                )}
                {pair.toolResult && (
                  <div id={`conversation-message-${pair.toolResult.index}`} className="border-t border-border/30">
                    <ToolResultInline msg={pair.toolResult.message} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
