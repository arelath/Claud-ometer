#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.AGENT_SCOPE_BASE_URL || DEFAULT_BASE_URL,
    runs: 1,
    method: 'POST',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url' && argv[index + 1]) {
      options.baseUrl = argv[index + 1];
      index += 1;
    } else if (arg === '--runs' && argv[index + 1]) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) options.runs = parsed;
      index += 1;
    } else if (arg === '--status') {
      options.method = 'GET';
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/session-index-baseline.mjs [options]

Options:
  --base-url <url>  AgentScope base URL. Default: ${DEFAULT_BASE_URL}
  --runs <n>        Number of rebuild/status requests. Default: 1
  --status          Read cache status instead of forcing rebuilds
  --help            Show this help
`);
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(0)}ms`;
}

function sumRecordValues(record) {
  return Object.values(record || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function summarizeStatus(status, elapsedMs) {
  const metrics = status.refreshMetrics || {};
  return {
    requestMs: elapsedMs,
    status: status.status,
    rebuilt: status.rebuilt,
    summaries: status.summaryCount,
    sources: metrics.sourceCount ?? status.sourceCount,
    valid: metrics.validCount ?? status.validCount,
    recent: metrics.recentCount,
    fullBuild: metrics.fullBuildCount,
    incrementalBuild: metrics.incrementalBuildCount,
    failedBuild: metrics.failedBuildCount,
    discoveryMs: sumRecordValues(metrics.discoveryMsByProvider),
    parseMs: sumRecordValues(metrics.parseMsByProvider),
    commitMs: metrics.commitMs,
    rowsWritten: metrics.sqliteRowsWritten,
    workerMode: metrics.workerMode,
    workerPoolSize: metrics.workerPoolSize,
    completedAt: metrics.completedAt,
    error: metrics.error || status.refreshError,
  };
}

function printSummary(summary) {
  console.log([
    `request=${formatMs(summary.requestMs)}`,
    `status=${summary.status || 'unknown'}`,
    summary.rebuilt == null ? null : `rebuilt=${summary.rebuilt}`,
    `summaries=${summary.summaries ?? 'n/a'}`,
    `sources=${summary.sources ?? 'n/a'}`,
    summary.valid == null ? null : `valid=${summary.valid}`,
    summary.recent == null ? null : `recent=${summary.recent}`,
    summary.fullBuild == null ? null : `full=${summary.fullBuild}`,
    summary.incrementalBuild == null ? null : `incremental=${summary.incrementalBuild}`,
    summary.failedBuild == null ? null : `failed=${summary.failedBuild}`,
    `discovery=${formatMs(summary.discoveryMs)}`,
    `parse=${formatMs(summary.parseMs)}`,
    `commit=${formatMs(summary.commitMs)}`,
    summary.rowsWritten == null ? null : `rows=${summary.rowsWritten}`,
    summary.workerMode ? `worker=${summary.workerMode}/${summary.workerPoolSize || 0}` : null,
    summary.error ? `error=${summary.error}` : null,
  ].filter(Boolean).join(' '));
}

async function requestJson(url, method) {
  const started = Date.now();
  const response = await fetch(url, { method });
  const body = await response.text();
  const elapsedMs = Date.now() - started;
  if (!response.ok) {
    throw new Error(`${method} ${url} failed with ${response.status}: ${body.slice(0, 500)}`);
  }
  return { elapsedMs, json: JSON.parse(body) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = new URL('/api/cache', options.baseUrl);
  if (options.method === 'GET') url.searchParams.set('quick', '1');

  console.log(`${options.method} ${url.toString()} (${options.runs} run${options.runs === 1 ? '' : 's'})`);
  for (let run = 1; run <= options.runs; run += 1) {
    const { elapsedMs, json } = await requestJson(url.toString(), options.method);
    process.stdout.write(`run=${run} `);
    printSummary(summarizeStatus(json, elapsedMs));
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
