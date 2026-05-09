import type { AgentKind } from './types';
import { isAgentKind } from './types';

export interface ParsedRouteId {
  agentKind?: AgentKind;
  nativeId: string;
}

export function makeRouteId(agentKind: AgentKind, nativeId: string): string {
  return `${agentKind}:${nativeId}`;
}

export function parseRouteId(routeId: string): ParsedRouteId {
  const separatorIndex = routeId.indexOf(':');
  if (separatorIndex <= 0) return { nativeId: routeId };

  const prefix = routeId.slice(0, separatorIndex);
  const nativeId = routeId.slice(separatorIndex + 1);
  if (!isAgentKind(prefix)) return { nativeId: routeId };

  return { agentKind: prefix, nativeId };
}

export function qualifyProjectId(agentKind: AgentKind, nativeProjectId: string): string {
  return makeRouteId(agentKind, nativeProjectId);
}
