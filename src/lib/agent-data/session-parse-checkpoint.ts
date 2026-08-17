import type { AgentKind } from './types';

export interface SourceParseCheckpoint {
  sourceKey: string;
  provider: AgentKind;
  parserVersion: string;
  checkpointVersion: number;
  sourceFilePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  lastCompleteOffset: number;
  recordCount: number;
  componentStateJson: string;
  accumulatorJson: string;
  updatedAt: string;
}

export interface IncrementalSessionSummarySupport {
  checkpointVersion: number;
  supportsPartialPromotion?: boolean;
  buildRecentAsFull?: boolean;
}

export type IncrementalSessionSummarySupportByProvider = Partial<Record<AgentKind, IncrementalSessionSummarySupport>>;
