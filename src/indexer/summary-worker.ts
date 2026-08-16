import { runParseSummaryTask, resetProviderSummaryResources } from '@/lib/agent-data/session-summary-task-runner';
import { getProvider } from '@/lib/agent-data/registry';
import type { SummaryWorkerRequest, SummaryWorkerResponse } from './summary-worker-protocol';

function send(message: SummaryWorkerResponse): void {
  if (process.send) process.send(message);
}

process.on('message', async (message: SummaryWorkerRequest) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shutdown') {
    process.disconnect();
    process.exit(0);
  }

  const providerKind = message.type === 'run' ? message.task.provider : message.provider;
  try {
    if (message.type === 'discover') {
      const provider = getProvider(message.provider);
      if (!provider?.discoverSessionSources) throw new Error(`Provider ${message.provider} does not support discovery`);
      const sources = await provider.discoverSessionSources();
      const memory = process.memoryUsage();
      send({
        type: 'discovered',
        id: message.id,
        sources,
        heapUsedBytes: memory.heapUsed,
        rssBytes: memory.rss,
      });
      return;
    }

    const result = await runParseSummaryTask(message.task);
    const memory = process.memoryUsage();
    send({
      type: 'result',
      id: message.id,
      result,
      heapUsedBytes: memory.heapUsed,
      rssBytes: memory.rss,
    });
  } catch (error) {
    send({
      type: 'error',
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    resetProviderSummaryResources(providerKind);
  }
});
