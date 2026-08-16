import type { AgentDataProvider } from './provider';
import { ensureSessionIndexRefresh, getIndexedSessionSummaries } from './indexer';
import type { CachedSessionSummary } from './session-summary';

export async function getProviderSessionSummaries(
  provider: AgentDataProvider,
): Promise<CachedSessionSummary[]> {
  const providers = [provider];
  const indexed = getIndexedSessionSummaries(providers);
  ensureSessionIndexRefresh(providers);
  return indexed;
}
