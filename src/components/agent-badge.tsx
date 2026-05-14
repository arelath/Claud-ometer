'use client';

import type { AgentKind } from '@/lib/agent-data/types';
import { getAgentLabel } from '@/lib/agent-data/types';
import { Badge } from '@/components/ui/badge';

export function AgentBadge({ agentKind, className = '' }: { agentKind?: AgentKind; className?: string }) {
  const label = agentKind ? getAgentLabel(agentKind) : 'Unknown';
  const classes = agentKind === 'codex'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : agentKind === 'copilot'
      ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    : agentKind === 'cursor'
      ? 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
    : agentKind === 'claude'
      ? 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300'
      : 'border-border bg-muted text-muted-foreground';

  return (
    <Badge
      variant="outline"
      aria-label={`${label} agent`}
      className={`${classes} ${className}`}
    >
      {label}
    </Badge>
  );
}
