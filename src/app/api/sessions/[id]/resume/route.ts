import fs from 'fs';
import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getActiveDataSource } from '@/lib/claude-data/data-source';
import { getLiveSessionBySessionId } from '@/lib/claude-data/live-sessions';
import { startManagedClaudeResume } from '@/lib/claude-data/managed-pty';
import { getSessionDetail } from '@/lib/claude-data/reader';
import { isValidResumeSessionId } from '@/lib/claude-data/resume-session';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;

  if (getActiveDataSource() !== 'live') {
    apiError('Resume is only available when viewing live data.', 409);
  }

  if (!isValidResumeSessionId(id)) {
    apiError('Resume requires a valid session GUID.', 400);
  }

  if (getLiveSessionBySessionId(id)) {
    apiError('This session is already live.', 409);
  }

  const session = await getSessionDetail(id);
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

  const managed = await startManagedClaudeResume(id, cwd);
  return NextResponse.json({ ok: true, mode: 'managed-pty', managed });
}, 'Error resuming session', 'Failed to resume session');
