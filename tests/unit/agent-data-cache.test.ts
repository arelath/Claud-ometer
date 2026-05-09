import { describe, expect, it } from 'vitest';
import { AgentDataCache } from '@/lib/agent-data/cache';

describe('agent data cache', () => {
  it('reuses values for the same provider, file, scope, and signature', () => {
    const cache = new AgentDataCache<string>();
    const key = { provider: 'codex', filePath: 'one.jsonl', scope: 'list', signature: { mtimeMs: 1, size: 2 } };

    cache.set(key, 'cached');

    expect(cache.get(key)).toBe('cached');
  });

  it('invalidates when mtime or size changes', () => {
    const cache = new AgentDataCache<string>();
    const key = { provider: 'codex', filePath: 'one.jsonl', signature: { mtimeMs: 1, size: 2 } };
    cache.set(key, 'cached');

    expect(cache.get({ ...key, signature: { mtimeMs: 2, size: 2 } })).toBeUndefined();
    expect(cache.get({ ...key, signature: { mtimeMs: 1, size: 3 } })).toBeUndefined();
  });

  it('keeps providers in separate cache keys', () => {
    const cache = new AgentDataCache<string>();
    const signature = { mtimeMs: 1, size: 2 };
    cache.set({ provider: 'claude', filePath: 'same.jsonl', signature }, 'claude');
    cache.set({ provider: 'codex', filePath: 'same.jsonl', signature }, 'codex');

    expect(cache.get({ provider: 'claude', filePath: 'same.jsonl', signature })).toBe('claude');
    expect(cache.get({ provider: 'codex', filePath: 'same.jsonl', signature })).toBe('codex');
  });
});
