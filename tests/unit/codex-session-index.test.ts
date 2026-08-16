import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Codex session discovery', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'codex-session-index');
  const codexDir = path.join(root, '.codex');

  async function loadModule() {
    vi.resetModules();
    process.env.AGENT_SCOPE_CODEX_DIR = codexDir;
    process.env.AGENT_SCOPE_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/codex/session-index');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_AGENTS;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CODEX_DIR;
    delete process.env.AGENT_SCOPE_IMPORT_DIR;
  });

  it('returns an empty list when the Codex directory is missing', async () => {
    const sessionIndex = await loadModule();

    await expect(sessionIndex.discoverCodexSessionFiles()).resolves.toEqual([]);
  });

  it('recursively discovers rollout JSONL files and extracts metadata', async () => {
    const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'codex');
    fs.cpSync(fixtureRoot, codexDir, { recursive: true });
    const sessionIndex = await loadModule();

    const sessions = await sessionIndex.discoverCodexSessionFiles();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      nativeId: '00000000-0000-0000-0000-000000000001',
      cwd: 'D:\\dev\\research\\AgentScope',
      title: 'Codex fixture support plan',
      createdAt: '2026-05-08T10:16:36.000Z',
      updatedAt: '2026-05-08T10:16:51.000Z',
    });
  });

  it('skips files whose first line is not Codex session metadata', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-2026-05-08T10-16-36-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl'),
      [
        '{not json',
        JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'turn_context', payload: { cwd: 'D:/tmp/fallback' } }),
      ].join('\n'),
    );
    const sessionIndex = await loadModule();

    await expect(sessionIndex.discoverCodexSessionFiles()).resolves.toEqual([]);
  });

  it('falls back to the id parsed from the filename after valid Codex metadata', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-2026-05-08T10-16-36-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-05-08T10:19:00.000Z', type: 'session_meta', payload: { originator: 'codex_cli' } }),
        JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'turn_context', payload: { cwd: 'D:/tmp/fallback' } }),
      ].join('\n'),
    );
    const sessionIndex = await loadModule();

    await expect(sessionIndex.discoverCodexSessionFiles()).resolves.toMatchObject([{
      nativeId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      cwd: 'D:/tmp/fallback',
    }]);
  });

  it('uses bounded prefix metadata for large Codex transcript files', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, 'rollout-2026-05-08T10-16-36-cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl');
    const mtime = new Date('2026-05-08T11:00:00.000Z');
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-05-08T10:16:36.000Z',
        type: 'session_meta',
        payload: { id: 'prefix-id', originator: 'codex_cli', cwd: 'D:/tmp/prefix', timestamp: '2026-05-08T10:16:36.000Z' },
      }),
      JSON.stringify({
        timestamp: '2026-05-08T10:16:37.000Z',
        type: 'turn_context',
        payload: { cwd: 'D:/tmp/prefix', model: 'gpt-5.5' },
      }),
      'x'.repeat(1100 * 1024),
      JSON.stringify({
        timestamp: '2026-05-08T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'trailing-id', cwd: 'D:/tmp/trailing' },
      }),
    ].join('\n'));
    fs.utimesSync(filePath, mtime, mtime);
    const sessionIndex = await loadModule();

    const sessions = await sessionIndex.discoverCodexSessionFiles();

    expect(sessions[0]).toMatchObject({
      nativeId: 'prefix-id',
      cwd: 'D:/tmp/prefix',
      model: 'gpt-5.5',
      updatedAt: mtime.toISOString(),
    });
  });

  it('only discovers rollout JSONL files under dated session directories', async () => {
    const validDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    const looseDir = path.join(codexDir, 'sessions', 'misc');
    fs.mkdirSync(validDir, { recursive: true });
    fs.mkdirSync(looseDir, { recursive: true });
    const validLine = JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'session_meta', payload: { id: 'valid', originator: 'codex_cli' } });
    fs.writeFileSync(path.join(validDir, 'rollout-2026-05-08T10-16-36-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), validLine);
    fs.writeFileSync(path.join(validDir, 'notes.jsonl'), validLine);
    fs.writeFileSync(path.join(looseDir, 'rollout-loose.jsonl'), validLine);
    const sessionIndex = await loadModule();

    const sessions = await sessionIndex.discoverCodexSessionFiles();

    expect(sessions.map(session => path.basename(session.filePath))).toEqual([
      'rollout-2026-05-08T10-16-36-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
    ]);
  });

  it('invalidates discovery when file size changes without adopting inherited session metadata', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, 'rollout-2026-05-08T10-16-36-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'session_meta', payload: { id: 'one', originator: 'codex_cli' } }));
    const sessionIndex = await loadModule();

    const first = await sessionIndex.discoverCodexSessionFiles();
    fs.appendFileSync(filePath, `\n${JSON.stringify({ timestamp: '2026-05-08T10:21:00.000Z', type: 'session_meta', payload: { id: 'two', originator: 'codex_cli' } })}`);
    const second = await sessionIndex.discoverCodexSessionFiles();

    expect(first[0].nativeId).toBe('one');
    expect(second[0]).toMatchObject({
      nativeId: 'one',
      updatedAt: '2026-05-08T10:21:00.000Z',
    });
  });

  it('invalidates discovery when only mtime changes', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, 'rollout-2026-05-08T10-16-36-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    const firstLine = JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'session_meta', payload: { id: 'one', originator: 'codex_cli' } });
    const secondLine = JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'session_meta', payload: { id: 'two', originator: 'codex_cli' } });
    expect(secondLine.length).toBe(firstLine.length);
    fs.writeFileSync(filePath, firstLine);
    const sessionIndex = await loadModule();

    const first = await sessionIndex.discoverCodexSessionFiles();
    fs.writeFileSync(filePath, secondLine);
    fs.utimesSync(filePath, new Date('2026-05-08T10:22:00.000Z'), new Date('2026-05-08T10:22:00.000Z'));
    const second = await sessionIndex.discoverCodexSessionFiles();

    expect(first[0].nativeId).toBe('one');
    expect(second[0].nativeId).toBe('two');
  });

  it('groups explicit subagents under their root while preserving generic forks and orphans', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '10');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const writeSession = (id: string, payload: Record<string, unknown>) => {
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-05-10T10-00-00-${id}.jsonl`),
        JSON.stringify({
          timestamp: '2026-05-10T10:00:00.000Z',
          type: 'session_meta',
          payload: { id, originator: 'codex_cli', cwd: 'D:/repo', ...payload },
        }),
      );
    };
    writeSession('root', {});
    writeSession('child', { parent_thread_id: 'root', session_id: 'root', agent_path: '/root/search', agent_role: 'code_searcher' });
    writeSession('nested', { parent_thread_id: 'child', session_id: 'child', agent_path: '/root/search/review', agent_role: 'code_reviewer' });
    writeSession('role-only', { session_id: 'root', agent_role: 'worker' });
    writeSession('nickname-only', { session_id: 'root', agent_nickname: 'Hooke' });
    writeSession('fork', { forked_from_id: 'root' });
    writeSession('orphan', { parent_thread_id: 'missing', agent_path: '/root/orphan', agent_role: 'worker' });
    const sessionIndex = await loadModule();

    const logical = await sessionIndex.discoverCodexLogicalSessions();
    const root = logical.find(session => session.root.nativeId === 'root');

    expect(logical.map(session => session.root.nativeId).sort()).toEqual(['fork', 'orphan', 'root']);
    expect(root?.members.map(member => ({ id: member.fileInfo.nativeId, depth: member.depth }))).toEqual([
      { id: 'root', depth: 0 },
      { id: 'child', depth: 1 },
      { id: 'nickname-only', depth: 1 },
      { id: 'role-only', depth: 1 },
      { id: 'nested', depth: 2 },
    ]);
    expect(root?.sourceSignature.size).toBeGreaterThan(0);
    expect(root?.signatureKey).toContain('child');
  });
});
