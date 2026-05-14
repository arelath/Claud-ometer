export type AgentKind = 'claude' | 'codex' | 'copilot' | 'cursor';

export interface AgentIdentity {
  agentKind: AgentKind;
  nativeId: string;
  routeId: string;
}

export const AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'copilot', 'cursor'];

export function isAgentKind(value: unknown): value is AgentKind {
  return value === 'claude' || value === 'codex' || value === 'copilot' || value === 'cursor';
}

export function getAgentLabel(agentKind: AgentKind): string {
  if (agentKind === 'claude') return 'Claude';
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'copilot') return 'Copilot';
  return 'Cursor';
}
