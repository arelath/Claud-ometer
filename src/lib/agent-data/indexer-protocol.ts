import type { AgentKind } from './types';

export const INDEXER_PROTOCOL_VERSION = 1;
export const INDEXER_ENDPOINT_ENV = 'AGENT_SCOPE_INDEXER_ENDPOINT';
export const INDEXER_TOKEN_ENV = 'AGENT_SCOPE_INDEXER_TOKEN';

export type IndexerCommand = 'health' | 'reconcile' | 'rebuild' | 'pause' | 'resume';

export interface IndexerRequest {
  protocolVersion: number;
  id: string;
  token: string;
  command: IndexerCommand;
  providers?: AgentKind[];
}

export interface IndexerResponse<T = unknown> {
  protocolVersion: number;
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; retryable: boolean };
}

export interface IndexerRunAccepted {
  runId: string;
  state: 'queued';
}
