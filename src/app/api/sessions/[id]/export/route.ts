import { NextResponse } from 'next/server';
import path from 'path';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { parseRouteId } from '@/lib/agent-data/route-id';
import {
  getStandardizedSessionDetail,
  standardizedSessionFileName,
} from '@/lib/agent-data/standardized-export';
import { attachLiveMetadata, buildLiveSessionFallbackDetail } from '@/lib/claude-data/live-session-detail';
import { getLiveSessionBySessionId } from '@/lib/claude-data/live-sessions';
import { getSessionDetailWithDescendantsFromFile } from '@/lib/claude-data/reader';

export const dynamic = 'force-dynamic';

function decodeSessionRouteId(id: string): string {
  try {
    const decodedId = decodeURIComponent(id);
    if (/[\\/\u0000-\u001F\u007F]/.test(decodedId)) {
      apiError('Invalid session id', 400);
    }
    return decodedId;
  } catch {
    apiError('Invalid session id', 400);
  }
}

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id: encodedId } = await params;
  const id = decodeSessionRouteId(encodedId);
  const parsed = parseRouteId(id);
  const liveSession = !parsed.agentKind || parsed.agentKind === 'claude'
    ? getLiveSessionBySessionId(parsed.nativeId)
    : null;
  let detail = liveSession?.transcriptFilePath
    ? await getSessionDetailWithDescendantsFromFile(
        liveSession.transcriptFilePath,
        path.basename(path.dirname(liveSession.transcriptFilePath)),
        liveSession.projectName,
      )
    : await getStandardizedSessionDetail(id);
  if (!detail && liveSession) detail = buildLiveSessionFallbackDetail(liveSession);
  if (detail && liveSession) {
    detail = attachLiveMetadata(detail, liveSession);
  }
  if (!detail) apiError('Session not found', 404);

  const body = Buffer.from(JSON.stringify(detail, null, 2));
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${standardizedSessionFileName(detail)}"`,
      'Content-Length': body.length.toString(),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}, 'Session export error', 'Failed to export session');
