import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import {
  getActiveDataSource,
  hasImportedData,
  getImportMeta,
  setDataSource,
} from '@/lib/claude-data/data-source';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    active: getActiveDataSource(),
    hasImportedData: hasImportedData(),
    importMeta: getImportMeta(),
  });
}

export const PUT = withErrorHandler(async (request: Request) => {
  const { source } = await request.json();
  if (source !== 'live' && source !== 'imported') {
    apiError('Invalid source', 400);
  }
  if (source === 'imported' && !hasImportedData()) {
    apiError('No imported data available', 400);
  }
  setDataSource(source);
  return NextResponse.json({ active: source });
}, 'Error switching data source', 'Failed to switch data source');
