export type AgentKind = 'claude' | 'codex';

export interface AgentIdentity {
  agentKind: AgentKind;
  nativeId: string;
  routeId: string;
}

export const AGENT_KINDS: AgentKind[] = ['claude', 'codex'];

export function isAgentKind(value: unknown): value is AgentKind {
  return value === 'claude' || value === 'codex';
}

export function getAgentLabel(agentKind: AgentKind): string {
  return agentKind === 'claude' ? 'Claude' : 'Codex';
}
