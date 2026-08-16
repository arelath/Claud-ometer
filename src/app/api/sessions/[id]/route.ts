import { NextResponse } from 'next/server';
import path from 'path';
import { getSessionDetailFromFile } from '@/lib/claude-data/reader';
import { getLiveSessionBySessionId, getLiveTranscriptRevision } from '@/lib/claude-data/live-sessions';
import type { LiveSessionInfo, SessionDetail } from '@/lib/claude-data/types';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { resolveSessionProvider } from '@/lib/agent-data/registry';
import { attachLiveMetadata, buildLiveSessionFallbackDetail } from '@/lib/claude-data/live-session-detail';

export const dynamic = 'force-dynamic';

const LIVE_DETAIL_REPARSE_THROTTLE_MS = 2_500;
const LIVE_DETAIL_CACHE_LIMIT = 12;

interface LiveDetailCacheEntry {
  revision: string;
  parsedAtMs: number;
  detail?: SessionDetail;
  promise?: Promise<SessionDetail>;
}

const liveDetailCache = new Map<string, LiveDetailCacheEntry>();

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
    return getCachedLiveSessionDetail(liveSession);
  }

  const provider = resolveSessionProvider(id);
  const historical = provider ? await provider.getSessionDetail(id) : null;
  if (historical || !liveSession) return historical;

  return buildLiveSessionFallbackDetail(liveSession);
}

async function getCachedLiveSessionDetail(liveSession: LiveSessionInfo): Promise<SessionDetail> {
  const filePath = liveSession.transcriptFilePath!;
  const revision = liveSession.transcriptRevision || getLiveTranscriptRevision(liveSession.sessionId) || 'unknown';
  const now = Date.now();
  const cached = liveDetailCache.get(filePath);

  if (cached?.detail) {
    const parseAgeMs = now - cached.parsedAtMs;
    if (cached.revision === revision || liveSession.status === 'busy' || parseAgeMs < LIVE_DETAIL_REPARSE_THROTTLE_MS) {
      return cached.detail;
    }
  }
  if (cached?.promise) return cached.promise;

  const promise = getSessionDetailFromFile(
    filePath,
    path.basename(path.dirname(filePath)),
    liveSession.projectName,
  );
  liveDetailCache.set(filePath, { revision, parsedAtMs: now, detail: cached?.detail, promise });

  try {
    const detail = await promise;
    const detailWithRevision = { ...detail, liveTranscriptRevision: revision };
    liveDetailCache.set(filePath, { revision, parsedAtMs: Date.now(), detail: detailWithRevision });
    trimLiveDetailCache();
    return detailWithRevision;
  } catch (error) {
    if (cached?.detail) {
      liveDetailCache.set(filePath, cached);
    } else {
      liveDetailCache.delete(filePath);
    }
    throw error;
  }
}

function trimLiveDetailCache(): void {
  if (liveDetailCache.size <= LIVE_DETAIL_CACHE_LIMIT) return;
  const entries = Array.from(liveDetailCache.entries())
    .sort((left, right) => left[1].parsedAtMs - right[1].parsedAtMs);
  for (const [filePath] of entries.slice(0, liveDetailCache.size - LIVE_DETAIL_CACHE_LIMIT)) {
    liveDetailCache.delete(filePath);
  }
}
