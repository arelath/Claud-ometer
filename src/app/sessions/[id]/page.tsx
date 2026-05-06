'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import {
  Activity,
  ArrowLeft,
  Clock,
  Coins,
  FileText,
  GitBranch,
  MessageSquare,
  Minimize2,
  Wrench,
} from 'lucide-react';
import { useSessionDetail } from '@/lib/hooks';
import { useCostMode } from '@/lib/cost-mode-context';
import { getContextFileGroups } from '@/lib/context-files';
import type { FilterPreset } from '@/lib/session-transcript';
import { getSessionDiffSummary } from '@/lib/session-diff';
import { useSessionViewState } from '@/hooks/use-session-view-state';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArtifactFullscreenViewer } from '@/components/session/artifact-viewer';
import { ContextFilesPanel, ContextWindowMeter } from '@/components/session/context-panel';
import {
  ChangesView,
  SessionViewTabs,
} from '@/components/session/diff-viewer';
import { Minimap } from '@/components/session/minimap';
import { SessionPill } from '@/components/session/session-pill';
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

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session, isLoading, error } = useSessionDetail(id);
  const { pickCost } = useCostMode();
  const messages = useMemo(() => session?.messages || [], [session]);
  const compactionInfo = useMemo(
    () => session?.compaction || { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    [session?.compaction],
  );
  const compactionTimestamps = useMemo(
    () => compactionInfo.compactionTimestamps || [],
    [compactionInfo],
  );
  const diffSummary = useMemo(() => getSessionDiffSummary(messages), [messages]);
  const {
    state: {
      artifactViewer,
      copiedContextPath,
      copiedPatchKey,
      diffMode,
      effectiveSelectedDiffPath,
      groupedMessages,
      mainView,
      minimapSegments,
      minimapViewport,
      preset,
      presetCounts,
      toolFilter,
    },
    refs: { conversationRef },
    actions: {
      handleCopyContextPath,
      handleCopyPatch,
      handleJumpToDiffMessage,
      handleJumpToMessage,
      handleOpenDiffForPath,
      handlePresetChange,
      hasDiffForPath,
      scrollElementIntoConversation,
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
  });

  if (isLoading || !session || !session.id) {
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

  const topTools = Object.entries(session.toolsUsed || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const models = [...new Set(session.models || [])];

  const contextFiles = getContextFileGroups(messages);
  const compaction = compactionInfo;
  const compactionCount = compaction.compactions + compaction.microcompactions;
  const sessionRenderContext: SessionRenderContextValue = {
    projectRoot: session.cwd || undefined,
    openArtifact: setArtifactViewer,
  };

  return (
    <SessionRenderContext.Provider value={sessionRenderContext}>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Link href="/sessions" className="mt-0.5 rounded-lg border border-border p-1.5 hover:bg-accent transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="min-w-0 truncate text-xl font-bold tracking-tight">{session.projectName}</h1>
                {models.map(model => <Badge key={model} variant="secondary" className="text-xs">{model}</Badge>)}
                <SessionPill
                  value={compactionCount > 0 ? 'compacted' : 'completed'}
                  tone={compactionCount > 0 ? 'warn' : 'good'}
                />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{session.id.slice(0, 8)}</span>
                {session.gitBranch && (
                  <>
                    <span className="opacity-40">-</span>
                    <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{session.gitBranch}</span>
                  </>
                )}
                <span className="opacity-40">-</span>
                <span>{format(new Date(session.timestamp), 'MMM d, yyyy h:mm a')}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:shrink-0 lg:justify-end">
            <Card className="min-w-[86px] border-primary/30 bg-primary/5 shadow-sm">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Coins className="h-3 w-3 text-primary" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5 text-primary">{formatCost(pickCost(session.estimatedCosts, session.estimatedCost))}</p>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Est. Usage</p>
              </CardContent>
            </Card>
            <Card className="min-w-[86px] border-border/50 shadow-sm">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{formatDuration(session.duration)}</p>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Duration</p>
              </CardContent>
            </Card>
            <Card className="min-w-[86px] border-border/50 shadow-sm">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <MessageSquare className="h-3 w-3 text-muted-foreground" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{session.messageCount}</p>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Messages</p>
              </CardContent>
            </Card>
            <Card className="min-w-[86px] border-border/50 shadow-sm">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Wrench className="h-3 w-3 text-muted-foreground" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{session.toolCallCount}</p>
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
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{formatTokens(session.totalInputTokens + session.totalOutputTokens)}</p>
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

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_308px] gap-3">
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="space-y-3 pb-3">
              <SessionViewTabs
                view={mainView}
                onChange={setMainView}
                conversationCount={messages.length}
                diffSummary={diffSummary}
                diffMode={diffMode}
                onDiffModeChange={setDiffMode}
                copiedPatchKey={copiedPatchKey}
                onCopyPatch={handleCopyPatch}
              />
              {mainView === 'conversation' && (
                <FilterPresets preset={preset} onChange={handlePresetChange} counts={presetCounts} />
              )}
            </CardHeader>
            <CardContent className="pt-0">
              {mainView === 'conversation' ? (
                <div className="flex gap-3">
                  <div ref={conversationRef} data-testid="conversation-scroll-viewer" className="flex-1 min-w-0 max-h-[78vh] overflow-y-auto pr-2 space-y-2">
                    {groupedMessages.map((group, groupIndex) => {
                      if (group.type === 'compaction') {
                        return <CompactionDivider key={`c-${group.index}-${group.timestamp}`} timestamp={group.timestamp} targetId={group.targetId} />;
                      }
                      if (group.type === 'user') {
                        return <UserMessage key={`u-${groupIndex}`} msg={group.message} index={group.index} />;
                      }
                      if (group.type === 'assistant') {
                        return (
                          <AssistantCard
                            key={`a-${groupIndex}`}
                            msg={group.message}
                            index={group.index}
                            toolPairs={group.toolPairs}
                            toolTimeline={group.toolTimeline}
                          />
                        );
                      }
                      if (group.type === 'system-group') {
                        return <SystemGroup key={`s-${groupIndex}`} messages={group.messages} />;
                      }
                      return null;
                    })}
                  </div>

                  <Minimap
                    segments={minimapSegments}
                    viewport={minimapViewport}
                    onJump={(targetId) => {
                      scrollElementIntoConversation(targetId, 'start');
                    }}
                  />
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
                  projectRoot={session.cwd || undefined}
                />
              )}
            </CardContent>
          </Card>

          <div className="space-y-2">
            <ContextWindowMeter session={session} messages={messages} />

            <ContextFilesPanel
              contextFiles={contextFiles}
              copiedPath={copiedContextPath}
              onCopyPath={handleCopyContextPath}
              onJumpToMessage={handleJumpToMessage}
              hasDiffForPath={hasDiffForPath}
              onOpenDiff={handleOpenDiffForPath}
            />

            {topTools.length > 0 && (
              <Card className="border-border/50 shadow-sm py-0 gap-0">
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
              <Card className="border-amber-300/50 bg-amber-50/30 dark:bg-amber-950/10 shadow-sm py-0 gap-0">
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

            <Card className="border-border/50 shadow-sm py-0 gap-0">
              <CardHeader className="px-3 pt-3 pb-2.5">
                <CardTitle className="text-sm font-semibold">Metadata</CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Version</span>
                  <span className="font-mono">{session.version}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Project</span>
                  <span className="font-medium truncate max-w-[120px]">{session.projectName}</span>
                </div>
                {session.gitBranch && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Branch</span>
                    <span className="font-mono truncate max-w-[120px]">{session.gitBranch}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
      <ArtifactFullscreenViewer artifact={artifactViewer} onClose={() => setArtifactViewer(null)} />
    </SessionRenderContext.Provider>
  );
}
