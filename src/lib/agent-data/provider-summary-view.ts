import type { AgentDataProvider } from './provider';
import { getIndexedSessionSummaries } from './indexer';
import type { CachedSessionSummary } from './session-summary';

export async function getProviderSessionSummaries(
  provider: AgentDataProvider,
): Promise<CachedSessionSummary[]> {
  const providers = [provider];
  return getIndexedSessionSummaries(providers);
}
