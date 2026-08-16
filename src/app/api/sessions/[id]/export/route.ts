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

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
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
