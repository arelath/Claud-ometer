'use client';

import type { SessionSubagentDisplay } from '@/lib/claude-data/types';
import { Badge } from '@/components/ui/badge';

export function SubagentIndicator({ subagent }: { subagent?: SessionSubagentDisplay }) {
  if (!subagent) return null;
  const name = subagent.nickname || subagent.path?.split('/').filter(Boolean).at(-1) || subagent.id.slice(0, 8);
  const description = [subagent.role, subagent.path, subagent.depth > 1 ? `depth ${subagent.depth}` : '']
    .filter(Boolean)
    .join(' · ');
  const accessible = [`Subagent ${name}`, subagent.role, subagent.path, subagent.depth > 1 ? `depth ${subagent.depth}` : '']
    .filter(Boolean)
    .join(', ');

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" aria-label={accessible} title={description || accessible}>
      <Badge variant="outline" className="border-violet-400/50 bg-violet-500/10 px-1.5 py-0 text-[10px] text-violet-700 dark:text-violet-300">
        Subagent: {name}
      </Badge>
      {subagent.role && <span className="truncate text-[10px] text-violet-700/80 dark:text-violet-300/80">{subagent.role}</span>}
    </span>
  );
}
