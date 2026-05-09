import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Codex session discovery', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'codex-session-index');
  const codexDir = path.join(root, '.codex');

  async function loadModule() {
    vi.resetModules();
    process.env.CLAUD_OMETER_CODEX_DIR = codexDir;
    process.env.CLAUD_OMETER_IMPORT_DIR = path.join(root, 'import');
    return import('@/lib/agent-data/providers/codex/session-index');
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_AGENTS;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CODEX_DIR;
    delete process.env.CLAUD_OMETER_IMPORT_DIR;
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
      cwd: 'D:\\dev\\research\\Claud-ometer',
      title: 'Codex fixture support plan',
      createdAt: '2026-05-08T10:16:36.000Z',
      updatedAt: '2026-05-08T10:16:51.000Z',
    });
  });

  it('falls back to the id parsed from the filename and skips malformed lines', async () => {
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
        payload: { id: 'prefix-id', cwd: 'D:/tmp/prefix', timestamp: '2026-05-08T10:16:36.000Z' },
      }),
      JSON.stringify({
        timestamp: '2026-05-08T10:16:37.000Z',
        type: 'turn_context',
        payload: { cwd: 'D:/tmp/prefix', model: 'gpt-5.5' },
      }),
      'x'.repeat(300 * 1024),
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

  it('invalidates discovery when file size changes', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, 'rollout-2026-05-08T10-16-36-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'session_meta', payload: { id: 'one' } }));
    const sessionIndex = await loadModule();

    const first = await sessionIndex.discoverCodexSessionFiles();
    fs.appendFileSync(filePath, `\n${JSON.stringify({ timestamp: '2026-05-08T10:21:00.000Z', type: 'session_meta', payload: { id: 'two' } })}`);
    const second = await sessionIndex.discoverCodexSessionFiles();

    expect(first[0].nativeId).toBe('one');
    expect(second[0].nativeId).toBe('two');
  });

  it('invalidates discovery when only mtime changes', async () => {
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '08');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, 'rollout-2026-05-08T10-16-36-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    const firstLine = JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'session_meta', payload: { id: 'one' } });
    const secondLine = JSON.stringify({ timestamp: '2026-05-08T10:20:00.000Z', type: 'session_meta', payload: { id: 'two' } });
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
});
