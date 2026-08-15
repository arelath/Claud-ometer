import type { AgentDataProvider } from './provider';
import { ensureSessionIndexRefresh, getIndexedSessionSummaries } from './indexer';
import { getCachedSessionSummaries } from './session-summary-store';
import type { CachedSessionSummary } from './session-summary';

export async function getProviderSessionSummaries(
  provider: AgentDataProvider,
): Promise<CachedSessionSummary[]> {
  const providers = [provider];
  const indexed = getIndexedSessionSummaries(providers);
  if (indexed.length > 0) {
    ensureSessionIndexRefresh(providers);
    return indexed;
  }

  return getCachedSessionSummaries(providers);
}
