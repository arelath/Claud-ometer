import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeSummaryCheckpoint,
  tryBuildIncrementalClaudeSummary,
} from '@/lib/claude-data/incremental-summary';
import {
  buildSessionSummaryWithCheckpoint,
  CLAUDE_SESSION_SUMMARY_PARSER_VERSION,
} from '@/lib/claude-data/reader';
import type { CachedSessionSummary, SessionSummarySource } from '@/lib/agent-data/session-summary';
import { calculateSummaryCosts, SESSION_SUMMARY_CACHE_VERSION } from '@/lib/agent-data/session-summary';

describe('Claude incremental summary reducer', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'claude-incremental-summary');
  const filePath = path.join(root, 'projects', 'project', 'session.jsonl');

  function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
  }

  function signature(): { size: number; mtimeMs: number } {
    const paths = [filePath];
    const subagents = path.join(path.dirname(filePath), 'session', 'subagents');
    if (fs.existsSync(subagents)) {
      paths.push(...fs.readdirSync(subagents).map(entry => path.join(subagents, entry)));
    }
    return paths.reduce((result, current) => {
      const stat = fs.statSync(current);
      result.size += stat.size;
      result.mtimeMs = Math.max(result.mtimeMs, stat.mtimeMs);
      return result;
    }, { size: 0, mtimeMs: 0 });
  }

  function source(): SessionSummarySource {
    return {
      provider: 'claude',
      parserVersion: CLAUDE_SESSION_SUMMARY_PARSER_VERSION,
      sourceFilePath: filePath,
      sourceSignature: signature(),
      nativeProjectId: 'project',
      projectName: 'Project',
    };
  }

  function summary(sourceValue: SessionSummarySource): CachedSessionSummary {
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      parserVersion: sourceValue.parserVersion,
      provider: 'claude',
      nativeId: 'session',
      routeId: 'claude:session',
      nativeProjectId: 'project',
      projectRouteId: 'claude:project',
      projectName: 'Project',
      sourceFilePath: filePath,
      sourceSignature: sourceValue.sourceSignature,
      createdAt: '2026-05-08T10:00:00.000Z',
      updatedAt: '2026-05-08T10:00:01.000Z',
      cwd: 'D:/repo',
      gitBranch: 'main',
      version: '1',
      model: 'claude-sonnet-4-5',
      models: ['Claude Sonnet 4.5'],
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 0,
      tokenTotals: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
      changeTotals: { addedLines: 0, removedLines: 0, netLineDelta: 0, changedLines: 0, fileCount: 0, editCount: 0 },
      usageEvents: [],
      changeEvents: [],
      toolsUsed: {},
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
      searchTextPreview: 'hello',
    };
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      line({
        type: 'user', uuid: 'u1', timestamp: '2026-05-08T10:00:00.000Z', cwd: 'D:/repo',
        message: { role: 'user', content: 'hello' },
      }),
      line({
        type: 'assistant', uuid: 'a1-record', timestamp: '2026-05-08T10:00:01.000Z',
        message: {
          id: 'a1', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    ].join(''));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads only appended records and emits idempotent event deltas', () => {
    const firstSource = source();
    const checkpoint = buildClaudeSummaryCheckpoint(firstSource);
    const oldOffset = checkpoint.lastCompleteOffset;
    fs.appendFileSync(filePath, [
      line({
        type: 'assistant', uuid: 'a1-record-2', timestamp: '2026-05-08T10:00:02.000Z',
        toolUseResult: [],
        message: {
          id: 'a1', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'done' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
          usage: { input_tokens: 12, output_tokens: 4 }, stop_reason: 'end_turn',
        },
      }),
      line({
        type: 'user', uuid: 'u2', timestamp: '2026-05-08T10:00:03.000Z',
        toolUseResult: 'plain tool output',
        message: { role: 'user', content: 'thanks' },
      }),
    ].join(''));
    const nextSource = source();

    const result = tryBuildIncrementalClaudeSummary(nextSource, summary(firstSource), checkpoint);

    expect(result).not.toBeNull();
    expect(result!.checkpoint.lastCompleteOffset).toBe(nextSource.sourceSignature.size);
    expect(result!.checkpoint.lastCompleteOffset - oldOffset).toBeGreaterThan(0);
    expect(result?.summary).toMatchObject({
      messageCount: 3,
      userMessageCount: 2,
      assistantMessageCount: 1,
      toolCallCount: 1,
      tokenTotals: { input: 12, output: 4 },
      toolsUsed: { Bash: 1 },
    });
    expect(result?.mutations?.usageEvents).toHaveLength(2);
    expect(result?.mutations?.usageEvents[0]).toMatchObject({
      componentKey: 'root',
      recordIdentity: String(oldOffset),
      event: { inputTokens: 2, outputTokens: 2, toolCallCount: 1 },
    });
    expect(result!.mutations!.usageEvents[0].event.estimatedCosts.api).toBeGreaterThan(0);
  });

  it('preserves usage and tool data from array-valued tool-result records in a full build', async () => {
    fs.appendFileSync(filePath, line({
      type: 'assistant', uuid: 'a2-record', timestamp: '2026-05-08T10:00:02.000Z',
      toolUseResult: [],
      message: {
        id: 'a2', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: {} }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }));

    const result = await buildSessionSummaryWithCheckpoint(source());

    expect(result.checkpoint.recordCount).toBe(3);
    expect(result.summary.tokenTotals).toMatchObject({ input: 15, output: 3 });
    expect(result.summary.toolCallCount).toBe(1);
    expect(result.summary.toolsUsed).toMatchObject({ Read: 1 });
    expect(calculateSummaryCosts(result.summary).api).toBeGreaterThan(0);
  });

  it.each([null, true, 42])('accepts JSON scalar tool results while checkpointing: %j', toolUseResult => {
    fs.appendFileSync(filePath, line({
      type: 'user', uuid: 'u2', timestamp: '2026-05-08T10:00:02.000Z',
      toolUseResult,
      message: { role: 'user', content: 'done' },
    }));

    expect(buildClaudeSummaryCheckpoint(source()).recordCount).toBe(3);
  });

  it('keeps strict validation for unrelated named fields', () => {
    fs.appendFileSync(filePath, line({
      type: 42, uuid: 'u2', timestamp: '2026-05-08T10:00:02.000Z',
      toolUseResult: [],
      message: { role: 'user', content: 'done' },
    }));

    expect(() => buildClaudeSummaryCheckpoint(source())).toThrow('expected string');
  });

  it('keeps a partial trailing record behind the committed cursor', () => {
    const firstSource = source();
    const checkpoint = buildClaudeSummaryCheckpoint(firstSource);
    fs.appendFileSync(filePath, '{"type":"user","uuid":"u2"');

    const result = tryBuildIncrementalClaudeSummary(source(), summary(firstSource), checkpoint);

    expect(result).not.toBeNull();
    expect(result?.checkpoint.lastCompleteOffset).toBe(checkpoint.lastCompleteOffset);
    expect(result?.mutations?.usageEvents).toEqual([]);
  });

  it('starts a newly discovered subagent component at offset zero', () => {
    const firstSource = source();
    const checkpoint = buildClaudeSummaryCheckpoint(firstSource);
    const subagentDir = path.join(path.dirname(filePath), 'session', 'subagents');
    const childPath = path.join(subagentDir, 'agent-1.jsonl');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(childPath, line({
      type: 'assistant', uuid: 'child-record', timestamp: '2026-05-08T10:00:02.000Z',
      message: {
        id: 'child-turn', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'child' }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }));

    const result = tryBuildIncrementalClaudeSummary(source(), summary(firstSource), checkpoint);
    const componentState = JSON.parse(result?.checkpoint.componentStateJson || '{}') as {
      components: Array<{ componentKey: string; completeOffset: number }>;
    };

    expect(result?.summary.tokenTotals).toMatchObject({ input: 15, output: 3 });
    expect(result?.summary.assistantMessageCount).toBe(1);
    expect(componentState.components.find(component => component.componentKey !== 'root')?.completeOffset).toBe(fs.statSync(childPath).size);
  });

  it('requires a full rebuild when the committed boundary changes', () => {
    const firstSource = source();
    const checkpoint = buildClaudeSummaryCheckpoint(firstSource);
    const content = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, content.replace('hello', 'hullo'));

    expect(tryBuildIncrementalClaudeSummary(source(), summary(firstSource), checkpoint)).toBeNull();
  });

  it('defers full checkpoint publication for unterminated root or subagent records', () => {
    const rootContent = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, rootContent.trimEnd());
    expect(() => buildClaudeSummaryCheckpoint(source())).toThrow('unterminated JSONL record');

    fs.writeFileSync(filePath, rootContent);
    const subagentDir = path.join(path.dirname(filePath), 'session', 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(path.join(subagentDir, 'agent-partial.jsonl'), JSON.stringify({
      type: 'assistant', uuid: 'child', timestamp: '2026-05-08T10:00:02.000Z',
      message: { id: 'child', role: 'assistant', model: 'claude-sonnet-4-5', content: 'partial' },
    }));
    expect(() => buildClaudeSummaryCheckpoint(source())).toThrow('unterminated JSONL record');
  });

  it('falls back when persisted continuation state is malformed, excessive, or oversized', () => {
    const firstSource = source();
    const checkpoint = buildClaudeSummaryCheckpoint(firstSource);
    fs.appendFileSync(filePath, line({
      type: 'user', uuid: 'u2', timestamp: '2026-05-08T10:00:02.000Z',
      message: { role: 'user', content: 'next' },
    }));
    const nextSource = source();
    const malformed = { ...checkpoint, accumulatorJson: JSON.stringify({ version: 1, lastTimestamp: '', turns: [null] }) };
    const excessive = {
      ...checkpoint,
      accumulatorJson: JSON.stringify({
        version: 1,
        lastTimestamp: '',
        turns: Array.from({ length: 129 }, (_, index) => ({
          key: `turn-${index}`, model: 'test', timestamp: '', topLevel: true, toolCalls: {},
        })),
      }),
    };
    const oversized = {
      ...checkpoint,
      accumulatorJson: JSON.stringify({ version: 1, lastTimestamp: 'x'.repeat(300 * 1024), turns: [] }),
    };

    expect(tryBuildIncrementalClaudeSummary(nextSource, summary(firstSource), malformed)).toBeNull();
    expect(tryBuildIncrementalClaudeSummary(nextSource, summary(firstSource), excessive)).toBeNull();
    expect(tryBuildIncrementalClaudeSummary(nextSource, summary(firstSource), oversized)).toBeNull();
  });

  it('falls back when the persisted root cursor disagrees with the outer checkpoint', () => {
    const firstSource = source();
    const checkpoint = buildClaudeSummaryCheckpoint(firstSource);
    const componentState = JSON.parse(checkpoint.componentStateJson) as {
      version: 1;
      components: Array<{ componentKey: string; completeOffset: number }>;
    };
    componentState.components.find(component => component.componentKey === 'root')!.completeOffset = 0;
    fs.appendFileSync(filePath, line({
      type: 'user', uuid: 'u2', timestamp: '2026-05-08T10:00:02.000Z',
      message: { role: 'user', content: 'next' },
    }));

    expect(tryBuildIncrementalClaudeSummary(source(), summary(firstSource), {
      ...checkpoint,
      componentStateJson: JSON.stringify(componentState),
    })).toBeNull();
  });
});
