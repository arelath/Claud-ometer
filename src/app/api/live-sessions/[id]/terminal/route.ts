import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import {
  getManagedClaudeSession,
  resizeManagedClaudeSession,
  sendTextToManagedClaudeSession,
  writeDataToManagedClaudeSession,
} from '@/lib/claude-data/managed-pty';
import { parseRouteId } from '@/lib/agent-data/route-id';

export const dynamic = 'force-dynamic';

const MAX_TERMINAL_INPUT_LENGTH = 50_000;

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
  const parsed = parseRouteId(id);
  if (parsed.agentKind === 'codex') {
    apiError('Codex terminal output is not supported yet.', 501);
  }
  const ptySession = getManagedClaudeSession(parsed.nativeId);
  if (ptySession) return NextResponse.json({ ...ptySession, transport: 'managed-pty' });
  return NextResponse.json(null);
}, 'Error fetching managed terminal output', 'Failed to fetch managed terminal output');

export const POST = withErrorHandler(async (
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
  const parsed = parseRouteId(id);
  if (parsed.agentKind === 'codex') {
    apiError('Codex terminal input is not supported yet.', 501);
  }
  const nativeId = parsed.nativeId;
  const body = await request.json().catch(() => null);
  const data = typeof body?.data === 'string' ? body.data : undefined;
  const text = typeof body?.text === 'string' ? body.text.trim() : undefined;
  const cols = typeof body?.cols === 'number' && Number.isFinite(body.cols) ? body.cols : undefined;
  const rows = typeof body?.rows === 'number' && Number.isFinite(body.rows) ? body.rows : undefined;

  if (cols != null || rows != null) {
    if (cols == null || rows == null) apiError('Terminal resize requires both cols and rows.', 400);
    const managed = resizeManagedClaudeSession(nativeId, cols, rows);
    if (!managed) apiError('No running managed PTY session was found.', 409);

    return NextResponse.json({ ok: true, managed: { ...managed, transport: 'managed-pty' } });
  }

  if (data == null && !text) apiError('Terminal input is required.', 400);
  if ((data?.length || text?.length || 0) > MAX_TERMINAL_INPUT_LENGTH) {
    apiError(`Terminal input must be ${MAX_TERMINAL_INPUT_LENGTH} characters or fewer.`, 413);
  }

  const managed = data != null
    ? writeDataToManagedClaudeSession(nativeId, data)
    : sendTextToManagedClaudeSession(nativeId, text || '');
  if (!managed) apiError('No running managed PTY session was found.', 409);

  return NextResponse.json({ ok: true, managed: { ...managed, transport: 'managed-pty' } });
}, 'Error sending managed terminal input', 'Failed to send managed terminal input');
