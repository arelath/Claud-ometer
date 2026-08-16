import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { zeroCosts } from './cost-utils';
import { getLiveTranscriptRevision } from './live-sessions';
import type { LiveSessionInfo, SessionDetail } from './types';

export function buildLiveSessionFallbackDetail(liveSession: LiveSessionInfo): SessionDetail {
  return {
    id: liveSession.sessionId,
    projectId: liveSession.projectName,
    projectName: liveSession.projectName,
    timestamp: liveSession.startedAt,
    duration: Math.max(0, Date.now() - new Date(liveSession.startedAt).getTime()),
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    estimatedCost: 0,
    estimatedCosts: zeroCosts(),
    model: 'unknown',
    models: [],
    gitBranch: '',
    cwd: liveSession.cwd,
    version: liveSession.version || '',
    toolsUsed: {},
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
    messages: [],
  };
}

export function attachLiveMetadata(session: SessionDetail, liveSession: LiveSessionInfo): SessionDetail {
  const nativeProjectId = session.nativeProjectId || parseRouteId(session.projectId).nativeId;
  const sourceFilePaths = [
    ...(session.sourceFilePaths?.length ? session.sourceFilePaths : [session.sourceFilePath]),
    liveSession.transcriptFilePath,
    liveSession.metadataFilePath,
  ].filter((filePath): filePath is string => Boolean(filePath));

  return {
    ...session,
    agentKind: 'claude',
    nativeId: liveSession.sessionId,
    routeId: makeRouteId('claude', liveSession.sessionId),
    nativeProjectId,
    projectRouteId: qualifyProjectId('claude', nativeProjectId),
    isLive: true,
    liveStatus: liveSession.status,
    liveStatusReason: liveSession.statusReason,
    liveBusySinceAt: liveSession.busySinceAt,
    liveBusySinceAtMs: liveSession.busySinceAtMs,
    liveActiveToolName: liveSession.activeToolName,
    liveCachePaused: liveSession.cachePaused,
    liveMetadataRevision: liveSession.revision,
    liveTranscriptRevision: session.liveTranscriptRevision || getLiveTranscriptRevision(liveSession.sessionId) || liveSession.transcriptRevision,
    liveMetadataFilePath: liveSession.metadataFilePath,
    liveTranscriptFilePath: liveSession.transcriptFilePath,
    sourceFilePaths: Array.from(new Set(sourceFilePaths)),
  };
}
