import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexEnvelope } from '@/lib/agent-data/providers/codex/schema';

describe('Codex stats', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'codex-stats');
  const codexDir = path.join(root, '.codex');

  async function loadReader() {
    vi.resetModules();
    process.env.AGENT_SCOPE_CODEX_DIR = codexDir;
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/codex/reader');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex'), codexDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CODEX_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
  });

  it('uses final cumulative token counts and builds activity/model totals', async () => {
    const reader = await loadReader();

    const stats = await reader.getDashboardStats();

    expect(stats.totalSessions).toBe(1);
    expect(stats.totalMessages).toBe(3);
    expect(stats.totalTokens).toBe(168);
    expect(stats.dailyActivity).toEqual([{
      date: '2026-05-08',
      messageCount: 3,
      sessionCount: 1,
      toolCallCount: 2,
    }]);
    expect(stats.changeTotals).toEqual({
      addedLines: 1,
      removedLines: 1,
      netLineDelta: 0,
      changedLines: 2,
      fileCount: 1,
      editCount: 1,
    });
    expect(stats.dailyChangeActivity).toEqual([{
      date: '2026-05-08',
      addedLines: 1,
      removedLines: 1,
      netLineDelta: 0,
      changedLines: 2,
      fileCount: 1,
      editCount: 1,
      sessionCount: 1,
    }]);
    expect(stats.modelUsage['gpt-5.5']).toMatchObject({
      inputTokens: 125,
      outputTokens: 18,
      cacheReadInputTokens: 25,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 5,
    });
    expect(stats.estimatedCosts.api).toBeGreaterThan(0);
  });

  it('accepts legacy direct token_count totals and estimates missing token_count', async () => {
    const { parseCodexRecords } = await import('@/lib/agent-data/providers/codex/transcript-parser');
    const { buildCodexDashboardStats } = await import('@/lib/agent-data/providers/codex/stats');
    const baseRecords: CodexEnvelope[] = [
      { timestamp: '2026-05-08T10:00:00.000Z', type: 'session_meta', payload: { id: 'direct', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'D:/repo' } },
      { timestamp: '2026-05-08T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    ];
    const direct = parseCodexRecords('D:/repo/direct.jsonl', [
      ...baseRecords,
      {
        timestamp: '2026-05-08T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          kind: 'token_count',
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 3,
            reasoning_output_tokens: 1,
          },
        },
      },
    ]);
    const missing = parseCodexRecords('D:/repo/missing.jsonl', baseRecords.map((record, index) => ({
      ...record,
      payload: record.type === 'session_meta' ? { id: 'missing', cwd: 'D:/repo' } : record.payload,
      timestamp: `2026-05-08T10:01:0${index}.000Z`,
    })));

    expect(direct.info.totalInputTokens).toBe(8);
    expect(direct.info.totalOutputTokens).toBe(3);
    expect(direct.info.totalCacheReadTokens).toBe(2);
    expect(missing.info.totalInputTokens).toBe(0);
    expect(missing.info.totalOutputTokens).toBe(1);
    expect(buildCodexDashboardStats([direct, missing]).totalTokens).toBe(14);
  });
});
