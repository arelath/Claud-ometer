import type { AgentKind } from './types';
import { isAgentKind } from './types';
import { parseRouteId } from './route-id';
import type { AgentDataProvider } from './provider';
import { getSelectedAgents } from './data-source';
import { claudeProvider } from './providers/claude/provider';
import { codexProvider } from './providers/codex/provider';
import { copilotProvider } from './providers/copilot/provider';
import { cursorProvider } from './providers/cursor/provider';

const providers = new Map<AgentKind, AgentDataProvider>([
  ['claude', claudeProvider],
  ['codex', codexProvider],
  ['copilot', copilotProvider],
  ['cursor', cursorProvider],
]);

export function registerProvider(provider: AgentDataProvider): void {
  providers.set(provider.kind, provider);
}

export function getProvider(kind: AgentKind): AgentDataProvider | null {
  return providers.get(kind) || null;
}

export function getKnownProviders(): AgentDataProvider[] {
  return Array.from(providers.values());
}

export function getActiveProviders(): AgentDataProvider[] {
  return getSelectedAgents()
    .map(kind => providers.get(kind))
    .filter((provider): provider is AgentDataProvider => Boolean(provider));
}

export function getProvidersForFilter(agent: string | null): AgentDataProvider[] {
  if (!agent || agent === 'active') return getActiveProviders();
  if (agent === 'all') return getKnownProviders();
  if (!isAgentKind(agent)) return [];
  const provider = getProvider(agent);
  return provider ? [provider] : [];
}

export function resolveSessionProvider(routeId: string): AgentDataProvider | null {
  const parsed = parseRouteId(routeId);
  if (parsed.agentKind) return getProvider(parsed.agentKind);
  return getProvider('claude');
}
