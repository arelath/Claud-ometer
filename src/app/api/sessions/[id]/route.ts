import { NextResponse } from 'next/server';
import path from 'path';
import { getSessionDetail, getSessionDetailFromFile } from '@/lib/claude-data/reader';
import { getLiveSessionBySessionId, getLiveTranscriptRevision } from '@/lib/claude-data/live-sessions';
import { zeroCosts } from '@/lib/claude-data/cost-utils';
import type { LiveSessionInfo, SessionDetail } from '@/lib/claude-data/types';
import { apiError, withErrorHandler } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> => {
  const { id } = await params;
  const liveSession = getLiveSessionBySessionId(id);
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

  const historical = await getSessionDetail(id);
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
  return {
    ...session,
    isLive: true,
    liveStatus: liveSession.status,
    liveStatusReason: liveSession.statusReason,
    liveMetadataRevision: liveSession.revision,
    liveTranscriptRevision: getLiveTranscriptRevision(liveSession.sessionId) || liveSession.transcriptRevision,
    liveMetadataFilePath: liveSession.metadataFilePath,
    liveTranscriptFilePath: liveSession.transcriptFilePath,
  };
}
