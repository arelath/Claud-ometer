'use client';

import { use, useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  Check,
  Clock,
  Coins,
  Copy,
  FileText,
  GitBranch,
  MessageSquare,
  Minimize2,
  Wrench,
} from 'lucide-react';
import { useDataSourceInfo, useSessionDetail, useSessionSummary } from '@/lib/hooks';
import { useCostMode } from '@/lib/cost-mode-context';
import { getContextFileGroups } from '@/lib/context-files';
import type { FilterPreset } from '@/lib/session-transcript';
import type { SessionInfo } from '@/lib/claude-data/types';
import { getSessionDiffSummary } from '@/lib/session-diff';
import { useSessionViewState } from '@/hooks/use-session-view-state';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';
import { formatDisplayPath, splitDisplayPath } from '@/lib/path-utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/agent-badge';
import { getAgentLabel } from '@/lib/agent-data/types';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ArtifactFullscreenViewer } from '@/components/session/artifact-viewer';
import { ContextFilesPanel, ContextWindowMeter } from '@/components/session/context-panel';
import {
  ChangesView,
  SessionViewTabs,
} from '@/components/session/diff-viewer';
import { Minimap } from '@/components/session/minimap';
import { LiveSessionSendBox } from '@/components/session/live-session-send-box';
import { LiveWorkingIndicator } from '@/components/session/live-working-indicator';
import { SessionPill } from '@/components/session/session-pill';
import { ResumeSessionButton } from '@/components/session/resume-session-button';
import {
  SessionRenderContext,
  type SessionRenderContextValue,
} from '@/components/session/session-render-context';
import { AssistantCard, CompactionDivider, SystemGroup, UserMessage } from '@/components/session/transcript';

function FilterPresets({ preset, onChange, counts }: {
  preset: FilterPreset;
  onChange: (p: FilterPreset) => void;
  counts: { narrative: number; tools: number; all: number };
}) {
  const buttons: { key: FilterPreset; label: string }[] = [
    { key: 'narrative', label: 'Narrative' },
    { key: 'tools', label: '+ Tools' },
    { key: 'all', label: 'All events' },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[12px] text-muted-foreground">Show:</span>
      {buttons.map(button => {
        const active = preset === button.key;
        return (
          <button
            key={button.key}
            onClick={() => onChange(button.key)}
            className={`text-[12px] px-2.5 py-1 rounded-full font-medium transition-colors inline-flex items-center gap-1.5 ${
              active
                ? 'border-2 border-blue-500 bg-blue-500/10 text-blue-600 shadow-sm dark:border-blue-400 dark:bg-blue-500/20 dark:text-blue-300'
                : 'border border-border/60 bg-card/70 text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            <span>{button.label}</span>
            <span className={`text-[10px] font-mono px-1 rounded ${active ? 'bg-white/70 text-current dark:bg-white/20' : 'bg-muted/60 text-muted-foreground'}`}>
              {counts[button.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const TRANSCRIPT_ITEM_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '96px',
};

type SessionWithRawPaths = SessionInfo & {
  liveMetadataFilePath?: string;
  liveTranscriptFilePath?: string;
};

function getRawSessionPaths(session: SessionWithRawPaths | null | undefined): string[] {
  if (!session) return [];

  const sourcePaths = session.sourceFilePaths?.length
    ? session.sourceFilePaths
    : [session.sourceFilePath];
  const paths = [
    ...sourcePaths,
    session.liveTranscriptFilePath,
    session.liveMetadataFilePath,
  ];
  const seen = new Set<string>();

  return paths.reduce<string[]>((result, rawPath) => {
    const filePath = rawPath?.trim();
    if (!filePath || seen.has(filePath)) return result;
    seen.add(filePath);
    result.push(filePath);
    return result;
  }, []);
}

function RawSessionPathRow({
  filePath,
  projectRoot,
  copiedPath,
  onCopyPath,
}: {
  filePath: string;
  projectRoot?: string;
  copiedPath: string | null;
  onCopyPath: (filePath: string) => void;
}) {
  const isCopied = copiedPath === filePath;
  const displayPath = formatDisplayPath(filePath, projectRoot);
  const displayPathParts = splitDisplayPath(displayPath);

  return (
    <div className="group flex min-w-0 items-baseline justify-between gap-2 rounded-sm py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex min-w-0 flex-1 items-baseline font-mono text-[11px] text-foreground">
            {displayPathParts.prefix && (
              <span className="min-w-0 truncate text-muted-foreground">{displayPathParts.prefix}</span>
            )}
            <span className="min-w-0 truncate">{displayPathParts.basename}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[300px]">
          <span className="font-mono text-[10px] break-all">{displayPath}</span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Copy raw session file path: ${displayPath}`}
            onClick={() => onCopyPath(filePath)}
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          >
            {isCopied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{isCopied ? 'Copied full path' : 'Copy full path'}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session, isLoading, error } = useSessionDetail(id);
  const { data: summary } = useSessionSummary(id);
  const displaySession: SessionInfo | undefined = session || summary;
  const { data: sourceInfo } = useDataSourceInfo();
  const { pickCost } = useCostMode();
  const [copiedRawSessionPath, setCopiedRawSessionPath] = useState<string | null>(null);
  const messages = useMemo(() => session?.messages || [], [session]);
  const rawSessionPaths = useMemo(() => getRawSessionPaths(session || summary), [session, summary]);
  const handleCopyRawSessionPath = useCallback((filePath: string) => {
    void navigator.clipboard.writeText(filePath).then(() => {
      setCopiedRawSessionPath(filePath);
      window.setTimeout(() => {
        setCopiedRawSessionPath(current => (current === filePath ? null : current));
      }, 1200);
    });
  }, []);
  const hasTranscript = Boolean(session?.messages);
  const isLive = Boolean(session?.isLive);
  const liveRevision = session?.isLive
    ? `${session.liveMetadataRevision || ''}:${session.liveTranscriptRevision || ''}:${messages.length}`
    : undefined;
  const compactionInfo = useMemo(
    () => displaySession?.compaction || { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    [displaySession?.compaction],
  );
  const compactionTimestamps = useMemo(
    () => compactionInfo.compactionTimestamps || [],
    [compactionInfo],
  );
  const diffSummary = useMemo(() => getSessionDiffSummary(messages), [messages]);
  const assistantLabel = displaySession?.agentKind ? getAgentLabel(displaySession.agentKind) : 'Claude';
  const {
    state: {
      artifactViewer,
      copiedContextPath,
      copiedPatchKey,
      copiedVisibleConversation,
      diffMode,
      effectiveSelectedDiffPath,
      groupedMessages,
      mainView,
      minimapSegments,
      minimapViewport,
      preset,
      presetCounts,
      showScrollToBottom,
      toolFilter,
      unseenMessageCount,
    },
    refs: { bottomRef, conversationRef },
    actions: {
      handleCopyContextPath,
      handleCopyPatch,
      handleCopyVisibleConversation,
      handleJumpToDiffMessage,
      handleJumpToMessage,
      handleOpenDiffForPath,
      handlePresetChange,
      hasDiffForPath,
      scrollElementIntoConversation,
      scrollToConversationBottom,
      setArtifactViewer,
      setDiffMode,
      setMainView,
      setSelectedDiffPath,
      setToolFilter,
    },
  } = useSessionViewState({
    sessionId: id,
    messages,
    compactionTimestamps,
    diffSummary,
    isLive,
    liveRevision,
    assistantLabel,
  });

  if ((isLoading && !displaySession) || !displaySession?.id) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <div className="space-y-3 text-center">
          {error ? (
            <p className="text-sm text-muted-foreground">Session not found.</p>
          ) : (
            <>
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Loading session...</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const topTools = Object.entries(displaySession.toolsUsed || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const models = [...new Set(displaySession.models || [])];

  const contextFiles = getContextFileGroups(messages);
  const compaction = compactionInfo;
  const compactionCount = compaction.compactions + compaction.microcompactions;
  const sessionRenderContext: SessionRenderContextValue = {
    projectRoot: displaySession.cwd || undefined,
    agentKind: displaySession.agentKind,
    assistantLabel,
    openArtifact: setArtifactViewer,
  };

  return (
    <SessionRenderContext.Provider value={sessionRenderContext}>
      <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-col overflow-hidden">
        <div className="shrink-0 pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <Link href="/sessions" className="mt-0.5 rounded-lg border border-border p-1.5 hover:bg-accent transition-colors">
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h1 className="min-w-0 truncate text-xl font-bold tracking-tight">{displaySession.projectName}</h1>
                  {displaySession.agentKind && <AgentBadge agentKind={displaySession.agentKind} />}
                  {models.map(model => <Badge key={model} variant="secondary" className="text-xs">{model}</Badge>)}
                  {isLive && (
                    <Badge className="border-green-500/30 bg-green-500/10 text-green-700 hover:bg-green-500/10 dark:text-green-300">
                      Live
                    </Badge>
                  )}
                  {isLive && session?.liveStatus === 'busy' && (
                    <LiveWorkingIndicator
                      activeToolName={session?.liveActiveToolName}
                      busySinceAtMs={session?.liveBusySinceAtMs}
                    />
                  )}
                  {isLive && session?.liveStatus && session.liveStatus !== 'busy' && (
                    <SessionPill
                      value={session.liveStatus}
                      tone={session.liveStatus === 'idle' ? 'good' : 'neutral'}
                    />
                  )}
                  {(!isLive || compactionCount > 0) && (
                    <SessionPill
                      value={compactionCount > 0 ? 'compacted' : 'completed'}
                      tone={compactionCount > 0 ? 'warn' : 'good'}
                    />
                  )}
                  {sourceInfo?.active === 'live' && !isLive && (!displaySession.agentKind || displaySession.agentKind === 'claude') && (
                    <ResumeSessionButton sessionId={displaySession.id} showLabel />
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{(displaySession.nativeId || displaySession.id).slice(0, 8)}</span>
                  {displaySession.gitBranch && (
                    <>
                      <span className="opacity-40">-</span>
                      <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{displaySession.gitBranch}</span>
                    </>
                  )}
                  <span className="opacity-40">-</span>
                  <span>{format(new Date(displaySession.timestamp), 'MMM d, yyyy h:mm a')}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:shrink-0 lg:justify-end">
              <Card className="min-w-[86px] border-primary/30 bg-primary/5 shadow-sm">
                <CardContent className="px-2.5 py-1.5 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Coins className="h-3 w-3 text-primary" />
                    <p className="whitespace-nowrap text-sm font-bold leading-5 text-primary">{formatCost(pickCost(displaySession.estimatedCosts, displaySession.estimatedCost))}</p>
                  </div>
                  <p className="text-[9px] leading-3 text-muted-foreground">Est. Usage</p>
                </CardContent>
              </Card>
            <Card className="min-w-[86px] border-border/50 shadow-sm">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{formatDuration(displaySession.duration)}</p>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Duration</p>
              </CardContent>
            </Card>
            <Card className="min-w-[86px] border-border/50 shadow-sm">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <MessageSquare className="h-3 w-3 text-muted-foreground" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{displaySession.messageCount}</p>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Messages</p>
              </CardContent>
            </Card>
            <Card className="min-w-[86px] border-border/50 shadow-sm">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Wrench className="h-3 w-3 text-muted-foreground" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{displaySession.toolCallCount}</p>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Tool Calls</p>
              </CardContent>
            </Card>
            {diffSummary.fileCount > 0 && (
              <button
                type="button"
                onClick={() => setMainView('changes')}
                className="min-w-[108px] rounded-xl border border-border/50 bg-card text-card-foreground shadow-sm transition-colors hover:bg-muted/30"
              >
                <div className="px-2.5 py-1.5 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <FileText className="h-3 w-3 text-muted-foreground" />
                    <p className="whitespace-nowrap text-sm font-bold leading-5">{diffSummary.fileCount}</p>
                    <span className="font-mono text-[10px] text-green-700 dark:text-green-300">+{diffSummary.addedLines}</span>
                    <span className="font-mono text-[10px] text-red-700 dark:text-red-300">-{diffSummary.removedLines}</span>
                  </div>
                  <p className="text-[9px] leading-3 text-muted-foreground">Changes</p>
                </div>
              </button>
            )}
            <Card className="min-w-[86px] border-border/50 shadow-sm">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Activity className="h-3 w-3 text-muted-foreground" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{formatTokens(displaySession.totalInputTokens + displaySession.totalOutputTokens)}</p>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Tokens</p>
              </CardContent>
            </Card>
            {compactionCount > 0 && (
              <Card className="min-w-[86px] border-amber-300/50 bg-amber-50/30 shadow-sm dark:bg-amber-950/10">
                <CardContent className="px-2.5 py-1.5 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Minimize2 className="h-3 w-3 text-amber-600" />
                    <p className="whitespace-nowrap text-sm font-bold leading-5 text-amber-700 dark:text-amber-400">{compactionCount}</p>
                  </div>
                  <p className="text-[9px] leading-3 text-muted-foreground">Compactions</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_308px]">
          <section className="flex min-h-0 flex-col gap-2">
          <Card className="min-h-0 flex-1 gap-0 overflow-hidden border-border/50 py-0 shadow-sm">
            <CardHeader className="shrink-0 space-y-3 px-4 py-3">
              <SessionViewTabs
                view={mainView}
                onChange={setMainView}
                conversationCount={messages.length}
                diffSummary={diffSummary}
                diffMode={diffMode}
                onDiffModeChange={setDiffMode}
                copiedPatchKey={copiedPatchKey}
                onCopyPatch={handleCopyPatch}
                copiedVisibleConversation={copiedVisibleConversation}
                onCopyVisibleConversation={handleCopyVisibleConversation}
              />
              {mainView === 'conversation' && (
                <FilterPresets preset={preset} onChange={handlePresetChange} counts={presetCounts} />
              )}
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-0">
              {mainView === 'conversation' ? (
                <div className="flex h-full min-h-0 gap-3">
                  <div className="relative min-h-0 flex-1 min-w-0">
                    <div ref={conversationRef} data-testid="conversation-scroll-viewer" className="h-full min-h-0 space-y-2 overflow-y-auto pr-2">
                      {!hasTranscript ? (
                        <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20">
                          <div className="space-y-3 text-center">
                            <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                            <p className="text-sm text-muted-foreground">Loading transcript...</p>
                          </div>
                        </div>
                      ) : groupedMessages.map((group, groupIndex) => {
                        let content: ReactNode = null;
                        if (group.type === 'compaction') {
                          content = <CompactionDivider timestamp={group.timestamp} targetId={group.targetId} />;
                        } else if (group.type === 'user') {
                          content = <UserMessage msg={group.message} index={group.index} />;
                        } else if (group.type === 'assistant') {
                          content = (
                            <AssistantCard
                              msg={group.message}
                              index={group.index}
                              toolPairs={group.toolPairs}
                              toolTimeline={group.toolTimeline}
                            />
                          );
                        } else if (group.type === 'system-group') {
                          content = <SystemGroup messages={group.messages} />;
                        }
                        if (!content) return null;
                        return (
                          <div key={`${group.type}-${groupIndex}`} style={TRANSCRIPT_ITEM_STYLE}>
                            {content}
                          </div>
                        );
                      })}
                      <div ref={bottomRef} data-testid="conversation-bottom-sentinel" className="h-px" />
                    </div>
                    {isLive && showScrollToBottom && (
                      <button
                        type="button"
                        onClick={() => scrollToConversationBottom('smooth')}
                        aria-label="Scroll to latest message"
                        className="absolute bottom-3 right-5 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                        {unseenMessageCount > 0 ? `${unseenMessageCount} new` : 'Latest'}
                      </button>
                    )}
                  </div>

                  {hasTranscript && (
                    <Minimap
                      segments={minimapSegments}
                      viewport={minimapViewport}
                      onJump={(targetId) => {
                        scrollElementIntoConversation(targetId, 'start');
                      }}
                    />
                  )}
                </div>
              ) : (
                <ChangesView
                  summary={diffSummary}
                  selectedPath={effectiveSelectedDiffPath}
                  mode={diffMode}
                  copiedPatchKey={copiedPatchKey}
                  onSelectPath={setSelectedDiffPath}
                  onCopyPatch={handleCopyPatch}
                  onJumpToMessage={handleJumpToDiffMessage}
                  projectRoot={displaySession.cwd || undefined}
                />
              )}
            </CardContent>
          </Card>
          {isLive && session && <LiveSessionSendBox sessionId={session.id} liveStatus={session.liveStatus} />}
          </section>

          <aside className="hidden h-full min-h-0 flex-col gap-2 overflow-hidden xl:flex">
              <ContextWindowMeter session={displaySession} messages={messages} className="shrink-0" />

            <ContextFilesPanel
              contextFiles={contextFiles}
              copiedPath={copiedContextPath}
              onCopyPath={handleCopyContextPath}
              onJumpToMessage={handleJumpToMessage}
              hasDiffForPath={hasDiffForPath}
              onOpenDiff={handleOpenDiffForPath}
              fillHeight
              className="min-h-[150px]"
            />

            <div className="min-h-0 shrink-0 space-y-2 overflow-y-auto pr-1 xl:max-h-[45%]">
            {topTools.length > 0 && (
              <Card className="shrink-0 border-border/50 shadow-sm py-0 gap-0">
                <CardHeader className="px-3 pt-3 pb-2.5">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">Tools Used</CardTitle>
                    {toolFilter && (
                      <button
                        onClick={() => setToolFilter(null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Clear filter
                      </button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 space-y-1.5">
                  {topTools.map(([tool, count]) => {
                    const maxCount = topTools[0][1];
                    const barWidth = maxCount > 0 ? (count / maxCount) * 100 : 0;
                    const isActive = toolFilter === tool;
                    return (
                      <button
                        key={tool}
                        onClick={() => setToolFilter(isActive ? null : tool)}
                        className={`relative flex items-center justify-between py-0.5 w-full text-left rounded-sm transition-colors ${isActive ? 'ring-1 ring-blue-500/50' : 'hover:bg-muted/20'}`}
                      >
                        <div className="absolute inset-0 rounded-sm bg-muted/40" style={{ width: `${barWidth}%` }} />
                        <span className="relative text-xs font-mono truncate max-w-[150px] pl-1.5">{tool}</span>
                        <span className="relative text-[11px] font-mono text-muted-foreground pr-1.5">{count}</span>
                      </button>
                    );
                  })}
                </CardContent>
              </Card>
            )}

            {compactionCount > 0 && (
              <Card className="shrink-0 border-amber-300/50 bg-amber-50/30 dark:bg-amber-950/10 shadow-sm py-0 gap-0">
                <CardHeader className="px-3 pt-3 pb-2.5">
                  <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                    <Minimize2 className="h-3.5 w-3.5" />
                    Context Compaction
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Full Compactions</span>
                    <span className="font-bold">{compaction.compactions}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Micro-compactions</span>
                    <span className="font-bold">{compaction.microcompactions}</span>
                  </div>
                  {compaction.totalTokensSaved > 0 && (
                    <>
                      <Separator />
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Tokens Saved</span>
                        <span className="font-bold text-green-600">{formatTokens(compaction.totalTokensSaved)}</span>
                      </div>
                    </>
                  )}
                  {(compaction.compactionTimestamps || []).length > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-1">
                        <span className="text-[10px] text-muted-foreground font-medium">Timeline</span>
                        {compaction.compactionTimestamps.map((timestamp, index) => (
                          <div key={index} className="text-[10px] text-muted-foreground font-mono">
                            {format(new Date(timestamp), 'h:mm:ss a')}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="shrink-0 border-border/50 shadow-sm py-0 gap-0">
              <CardHeader className="px-3 pt-3 pb-2.5">
                <CardTitle className="text-sm font-semibold">Metadata</CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Provider</span>
                  <span className="font-medium">{displaySession.agentKind || 'claude'}</span>
                </div>
                {displaySession.routeId && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Route ID</span>
                    <span className="font-mono truncate max-w-[160px]">{displaySession.routeId}</span>
                  </div>
                )}
                {displaySession.nativeId && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Native ID</span>
                    <span className="font-mono truncate max-w-[160px]">{displaySession.nativeId}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Version</span>
                  <span className="font-mono">{displaySession.version}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Project</span>
                  <span className="font-medium truncate max-w-[120px]">{displaySession.projectName}</span>
                </div>
                {displaySession.gitBranch && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Branch</span>
                    <span className="font-mono truncate max-w-[120px]">{displaySession.gitBranch}</span>
                  </div>
                )}
                {rawSessionPaths.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {rawSessionPaths.length === 1 ? 'Raw Session File' : 'Raw Session Files'}
                        </span>
                        {rawSessionPaths.length > 1 && (
                          <span className="font-mono text-[10px] text-muted-foreground">{rawSessionPaths.length}</span>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        {rawSessionPaths.map(filePath => (
                          <RawSessionPathRow
                            key={filePath}
                            filePath={filePath}
                            projectRoot={displaySession.cwd || undefined}
                            copiedPath={copiedRawSessionPath}
                            onCopyPath={handleCopyRawSessionPath}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
            </div>
          </aside>
        </div>
      </div>
      <ArtifactFullscreenViewer artifact={artifactViewer} onClose={() => setArtifactViewer(null)} />
    </SessionRenderContext.Provider>
  );
}
