import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getAppSettings } from '@/lib/claude-data/app-settings';
import { getActiveDataSource } from '@/lib/claude-data/data-source';
import { getLiveSessionById } from '@/lib/claude-data/live-sessions';
import { sendTextToManagedClaudeSession } from '@/lib/claude-data/managed-pty';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { getAgentLabel } from '@/lib/agent-data/types';

export const dynamic = 'force-dynamic';

const MAX_INPUT_LENGTH = 50_000;

export const POST = withErrorHandler(async (
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
  const parsed = parseRouteId(id);
  if (parsed.agentKind && parsed.agentKind !== 'claude') {
    apiError(`${getAgentLabel(parsed.agentKind)} live input is not supported yet.`, 501);
  }
  const nativeId = parsed.nativeId;

  if (getActiveDataSource() !== 'live') {
    apiError('Sending input is only available when viewing live data.', 409);
  }

  const session = getLiveSessionById(nativeId);
  if (!session) apiError('Live session not found.', 404);
  if (session.status === 'busy') apiError('Claude is busy in this session.', 409);

  const body = await request.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) apiError('Message text is required.', 400);
  if (text.length > MAX_INPUT_LENGTH) apiError(`Message text must be ${MAX_INPUT_LENGTH} characters or fewer.`, 413);

  const transport = getAppSettings();
  if (transport.resumeTransport === 'msys2-launch') {
    apiError('MSYS2 launch mode uses the opened Claude window for input.', 409);
  }

  const managed = sendTextToManagedClaudeSession(session.sessionId, text);
  if (managed) {
    return NextResponse.json({ ok: true, target: 'managed-pty', managed });
  }

  apiError('No managed PTY session was found for this live session.', 409);
}, 'Error sending input to live session', 'Failed to send input to live session');
