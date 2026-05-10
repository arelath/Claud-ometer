import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexFixtureSessionId, seedImportedData, toolPairFixtureSessionId } from '../shared/seed-imported-data';

describe('agent search', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'agent-search');
  const importDir = path.join(root, 'import');

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    seedImportedData(importDir);
    process.env.CLAUD_OMETER_IMPORT_DIR = importDir;
    process.env.CLAUD_OMETER_AGENTS = 'claude,codex';
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
    delete process.env.CLAUD_OMETER_AGENTS;
    vi.resetModules();
  });

  it('searches Codex text, Claude text, tool text, and merged provider results', async () => {
    const { POST: rebuildCache } = await import('@/app/api/cache/route');
    const { GET } = await import('@/app/api/sessions/route');
    await rebuildCache();

    const codexOnly = await (await GET(new Request('http://localhost/api/sessions?q=fixture%20user%20text&agent=codex'))).json();
    expect(codexOnly).toHaveLength(1);
    expect(codexOnly[0].id).toBe(`codex:${codexFixtureSessionId}`);

    const claudeOnly = await (await GET(new Request('http://localhost/api/sessions?q=Context%20Builder&agent=claude'))).json();
    expect(claudeOnly.map((session: { id: string }) => session.id)).toContain(toolPairFixtureSessionId);

    const toolMatch = await (await GET(new Request('http://localhost/api/sessions?q=npm%20run%20test%3Aunit&agent=codex'))).json();
    expect(toolMatch[0].id).toBe(`codex:${codexFixtureSessionId}`);

    const combined = await (await GET(new Request('http://localhost/api/sessions?q=Context%20Builder&agent=all&limit=5'))).json();
    expect(combined.map((session: { id: string }) => session.id)).toEqual(expect.arrayContaining([
      `codex:${codexFixtureSessionId}`,
      toolPairFixtureSessionId,
    ]));
    expect(combined.length).toBeLessThanOrEqual(5);
  });
});
