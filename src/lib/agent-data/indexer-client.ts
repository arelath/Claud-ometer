import net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  INDEXER_ENDPOINT_ENV,
  INDEXER_PROTOCOL_VERSION,
  INDEXER_TOKEN_ENV,
  type IndexerCommand,
  type IndexerRequest,
  type IndexerResponse,
} from './indexer-protocol';
import type { AgentKind } from './types';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export class IndexerUnavailableError extends Error {
  constructor(message = 'The session indexer sidecar is unavailable.') {
    super(message);
    this.name = 'IndexerUnavailableError';
  }
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export async function requestIndexerCommand<T = unknown>(
  command: IndexerCommand,
  providers?: AgentKind[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const endpoint = process.env[INDEXER_ENDPOINT_ENV];
  const token = process.env[INDEXER_TOKEN_ENV];
  if (!endpoint || !token) throw new IndexerUnavailableError('Session indexer endpoint is not configured.');

  const request: IndexerRequest = {
    protocolVersion: INDEXER_PROTOCOL_VERSION,
    id: randomUUID(),
    token,
    command,
    providers,
  };

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = Buffer.alloc(0);
    let expectedLength: number | undefined;
    let settled = false;
    const timeout = setTimeout(() => finish(new IndexerUnavailableError(`Session indexer command timed out after ${timeoutMs} ms.`)), timeoutMs);
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };

    socket.once('connect', () => socket.write(encodeFrame(request)));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expectedLength === undefined && buffer.length >= 4) {
        expectedLength = buffer.readUInt32BE(0);
        buffer = buffer.subarray(4);
        if (expectedLength > MAX_FRAME_BYTES) {
          finish(new Error('Session indexer response exceeded the frame limit.'));
          return;
        }
      }
      if (expectedLength === undefined || buffer.length < expectedLength) return;
      try {
        const response = JSON.parse(buffer.subarray(0, expectedLength).toString('utf8')) as IndexerResponse<T>;
        if (response.protocolVersion !== INDEXER_PROTOCOL_VERSION || response.id !== request.id) {
          finish(new Error('Session indexer returned an invalid response.'));
        } else if (!response.ok) {
          finish(new Error(response.error?.message || 'Session indexer command failed.'));
        } else {
          finish(undefined, response.result);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', error => finish(new IndexerUnavailableError(error.message)));
  });
}
