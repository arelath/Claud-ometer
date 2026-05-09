import type { APIRequestContext, Page } from '@playwright/test';
import path from 'path';
import { codexFixtureSessionId, fixtureSessionIds, seedImportedData } from '../shared/seed-imported-data';

export const codexRouteId = `codex:${codexFixtureSessionId}`;
export const claudeRouteId = fixtureSessionIds[0];

export async function selectImportedAgents(request: APIRequestContext, agents: Array<'claude' | 'codex'>): Promise<void> {
  const response = await request.put('/api/data-source', {
    data: { source: 'imported', agents },
  });
  if (!response.ok()) {
    throw new Error(`Failed to select ${agents.join(', ')} imported data: ${response.status()} ${await response.text()}`);
  }
}

export async function resetToClaude(page: Page): Promise<void> {
  await selectImportedAgents(page.request, ['claude']);
}

export async function resetToAllAgents(page: Page): Promise<void> {
  await selectImportedAgents(page.request, ['claude', 'codex']);
}

export function restoreImportedFixtureData(): void {
  seedImportedData(path.join(process.cwd(), '.test-artifacts', 'e2e-import'));
}
