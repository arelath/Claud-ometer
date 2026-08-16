import type { ParseSummaryResult, ParseSummaryTask } from '@/lib/agent-data/session-summary-parse-pool';
import type { SessionSummarySource } from '@/lib/agent-data/session-summary';
import type { AgentKind } from '@/lib/agent-data/types';

export type SummaryWorkerRequest =
  | { type: 'run'; id: string; task: ParseSummaryTask }
  | { type: 'discover'; id: string; provider: AgentKind }
  | { type: 'shutdown' };

export type SummaryWorkerResponse =
  | { type: 'result'; id: string; result: ParseSummaryResult; heapUsedBytes: number; rssBytes: number }
  | { type: 'discovered'; id: string; sources: SessionSummarySource[]; heapUsedBytes: number; rssBytes: number }
  | { type: 'error'; id: string; error: string };
