import { NextResponse } from 'next/server';
import path from 'path';
import { getSessionDetailFromFile } from '@/lib/claude-data/reader';
import { getLiveSessionBySessionId, getLiveTranscriptRevision } from '@/lib/claude-data/live-sessions';
import { zeroCosts } from '@/lib/claude-data/cost-utils';
import type { LiveSessionInfo, SessionDetail } from '@/lib/claude-data/types';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { resolveSessionProvider } from '@/lib/agent-data/registry';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> => {
  const { id } = await params;
  const parsed = parseRouteId(id);
  const nativeId = parsed.nativeId;
  const liveSession = !parsed.agentKind || parsed.agentKind === 'claude'
    ? getLiveSessionBySessionId(nativeId)
    : null;
  const session = await getSessionDetailForRequest(id, liveSession);

  if (!session) {
    apiError('Session not found', 404);
  }

  return NextResponse.json(liveSession ? attachLiveMetadata(session, liveSession) : session);
}, 'Error fetching session', 'Failed to fetch session');

async function getSessionDetailForRequest(id: string, liveSession: LiveSessionInfo | null): Promise<SessionDetail | null> {
  if (liveSession?.transcriptFilePath) {
    return getSessionDetailFromFile(
      liveSession.transcriptFilePath,
      path.basename(path.dirname(liveSession.transcriptFilePath)),
      liveSession.projectName,
    );
  }

  const provider = resolveSessionProvider(id);
  const historical = provider ? await provider.getSessionDetail(id) : null;
  if (historical || !liveSession) return historical;

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

function attachLiveMetadata(session: SessionDetail, liveSession: LiveSessionInfo): SessionDetail {
  const nativeProjectId = session.nativeProjectId || parseRouteId(session.projectId).nativeId;
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
    liveTranscriptRevision: getLiveTranscriptRevision(liveSession.sessionId) || liveSession.transcriptRevision,
    liveMetadataFilePath: liveSession.metadataFilePath,
    liveTranscriptFilePath: liveSession.transcriptFilePath,
  };
}
