import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getAppSettings, parseResumeTransport, setAppSettings } from '@/lib/claude-data/app-settings';
import { getMsys2LaunchAvailability } from '@/lib/claude-data/msys2-launch';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (): Promise<Response> => {
  return NextResponse.json({
    ...getAppSettings(),
    msys2Launch: getMsys2LaunchAvailability(),
  });
}, 'Error fetching live mode settings', 'Failed to fetch live mode settings');

export const PUT = withErrorHandler(async (request: Request): Promise<Response> => {
  const body = await request.json().catch(() => null);
  const resumeTransport = parseResumeTransport(body?.resumeTransport);
  if (!resumeTransport) {
    apiError('Invalid resume transport', 400);
  }

  return NextResponse.json({
    ...setAppSettings({ resumeTransport }),
    msys2Launch: getMsys2LaunchAvailability(),
  });
}, 'Error updating live mode settings', 'Failed to update live mode settings');
