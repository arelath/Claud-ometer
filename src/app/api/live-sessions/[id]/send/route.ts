import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getActiveDataSource } from '@/lib/claude-data/data-source';
import { getLiveSessionById } from '@/lib/claude-data/live-sessions';
import { sendTextToManagedClaudeSession } from '@/lib/claude-data/managed-pty';
import { sendTextToTmuxLiveSession } from '@/lib/claude-data/tmux-live-input';

export const dynamic = 'force-dynamic';

const MAX_INPUT_LENGTH = 50_000;

export const POST = withErrorHandler(async (
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;

  if (getActiveDataSource() !== 'live') {
    apiError('Sending input is only available when viewing live data.', 409);
  }

  const session = getLiveSessionById(id);
  if (!session) apiError('Live session not found.', 404);
  if (session.status === 'busy') apiError('Claude is busy in this session.', 409);

  const body = await request.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) apiError('Message text is required.', 400);
  if (text.length > MAX_INPUT_LENGTH) apiError(`Message text must be ${MAX_INPUT_LENGTH} characters or fewer.`, 413);

  try {
    const managed = sendTextToManagedClaudeSession(session.sessionId, text);
    if (managed) {
      return NextResponse.json({ ok: true, target: 'managed-pty', managed });
    }

    const target = await sendTextToTmuxLiveSession(session, text);
    return NextResponse.json({ ok: true, target, mode: 'tmux' });
  } catch (error) {
    apiError(error instanceof Error ? error.message : 'Failed to send input to the live session.', 409);
  }
}, 'Error sending input to live session', 'Failed to send input to live session');
