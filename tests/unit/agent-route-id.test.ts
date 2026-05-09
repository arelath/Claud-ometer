import { describe, expect, it } from 'vitest';
import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';

describe('agent route ids', () => {
  it('builds qualified Claude ids', () => {
    expect(makeRouteId('claude', 'abc')).toBe('claude:abc');
    expect(parseRouteId('claude:abc')).toEqual({ agentKind: 'claude', nativeId: 'abc' });
  });

  it('builds qualified Codex ids', () => {
    expect(makeRouteId('codex', 'abc')).toBe('codex:abc');
    expect(parseRouteId('codex:abc')).toEqual({ agentKind: 'codex', nativeId: 'abc' });
  });

  it('accepts legacy unqualified ids', () => {
    expect(parseRouteId('legacy-session-id')).toEqual({ nativeId: 'legacy-session-id' });
  });

  it('preserves colons after the provider separator', () => {
    expect(parseRouteId('codex:rollout:with:colons')).toEqual({
      agentKind: 'codex',
      nativeId: 'rollout:with:colons',
    });
  });

  it('treats unknown prefixes as legacy native ids', () => {
    expect(parseRouteId('unknown:abc')).toEqual({ nativeId: 'unknown:abc' });
  });

  it('qualifies project ids to avoid provider collisions', () => {
    expect(qualifyProjectId('claude', 'D-dev-Claudometer')).toBe('claude:D-dev-Claudometer');
    expect(qualifyProjectId('codex', 'D-dev-Claudometer')).toBe('codex:D-dev-Claudometer');
  });
});
