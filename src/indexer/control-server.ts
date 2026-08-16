import net from 'node:net';
import fs from 'node:fs';
import {
  INDEXER_PROTOCOL_VERSION,
  type IndexerRequest,
  type IndexerResponse,
} from '@/lib/agent-data/indexer-protocol';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export interface IndexerControlServer {
  close(): Promise<void>;
}

export async function startIndexerControlServer(
  endpoint: string,
  token: string,
  dispatch: (request: IndexerRequest) => Promise<unknown>,
): Promise<IndexerControlServer> {
  if (process.platform !== 'win32' && fs.existsSync(endpoint)) fs.rmSync(endpoint, { force: true });
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let expectedLength: number | undefined;
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (expectedLength === undefined && buffer.length >= 4) {
        expectedLength = buffer.readUInt32BE(0);
        buffer = buffer.subarray(4);
        if (expectedLength > MAX_FRAME_BYTES) {
          handled = true;
          socket.destroy();
          return;
        }
      }
      if (expectedLength === undefined || buffer.length < expectedLength) return;
      handled = true;
      let request: IndexerRequest;
      try {
        request = JSON.parse(buffer.subarray(0, expectedLength).toString('utf8')) as IndexerRequest;
      } catch {
        socket.destroy();
        return;
      }
      const respond = (response: IndexerResponse) => socket.end(encodeFrame(response));
      if (request.protocolVersion !== INDEXER_PROTOCOL_VERSION || request.token !== token) {
        respond({
          protocolVersion: INDEXER_PROTOCOL_VERSION,
          id: request.id || '',
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid indexer protocol or token.', retryable: false },
        });
        return;
      }
      void dispatch(request).then(result => respond({
        protocolVersion: INDEXER_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result,
      }), error => respond({
        protocolVersion: INDEXER_PROTOCOL_VERSION,
        id: request.id,
        ok: false,
        error: {
          code: 'INDEXER_COMMAND_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
