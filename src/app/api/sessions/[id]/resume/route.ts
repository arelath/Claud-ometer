import fs from 'fs';
import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getAppSettings } from '@/lib/claude-data/app-settings';
import { getActiveDataSource } from '@/lib/claude-data/data-source';
import { getLiveSessionBySessionId } from '@/lib/claude-data/live-sessions';
import { startManagedClaudeResume } from '@/lib/claude-data/managed-pty';
import { startMsys2ClaudeResume } from '@/lib/claude-data/msys2-launch';
import { getSessionDetail } from '@/lib/claude-data/reader';
import { isValidResumeSessionId } from '@/lib/claude-data/resume-session';
import { parseRouteId } from '@/lib/agent-data/route-id';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
  const parsed = parseRouteId(id);
  if (parsed.agentKind === 'codex') {
    apiError('Codex resume is not supported yet.', 501);
  }
  const nativeId = parsed.nativeId;

  if (getActiveDataSource() !== 'live') {
    apiError('Resume is only available when viewing live data.', 409);
  }

  if (!isValidResumeSessionId(nativeId)) {
    apiError('Resume requires a valid session GUID.', 400);
  }

  if (getLiveSessionBySessionId(nativeId)) {
    apiError('This session is already live.', 409);
  }

  const session = await getSessionDetail(nativeId);
  if (!session) {
    apiError('Session not found.', 404);
  }

  const cwd = session.cwd?.trim();
  if (!cwd) {
    apiError('Session cwd is not available.', 409);
  }

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    apiError('Session cwd does not exist.', 409);
  }

  const transport = getAppSettings();
  if (transport.resumeTransport === 'msys2-launch') {
    try {
      const managed = startMsys2ClaudeResume(nativeId, cwd);
      return NextResponse.json({ ok: true, mode: 'msys2-launch', managed });
    } catch (error) {
      apiError(error instanceof Error ? error.message : 'MSYS2 launch failed.', 409);
    }
  }

  try {
    const managed = await startManagedClaudeResume(nativeId, cwd);
    return NextResponse.json({ ok: true, mode: 'managed-pty', managed });
  } catch (error) {
    apiError(error instanceof Error ? error.message : 'PTY resume failed.', 409);
  }
}, 'Error resuming session', 'Failed to resume session');
