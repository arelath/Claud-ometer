/* eslint-disable @typescript-eslint/no-require-imports */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const rootDir = process.cwd();
const exePath = process.argv[2] || path.join(rootDir, 'dist-electron', 'win-unpacked', 'Claud-ometer.exe');
const serverPath = process.argv[3] || path.join(rootDir, 'dist-electron', 'win-unpacked', 'resources', 'next', 'server.js');
const importDir = path.join(rootDir, '.test-artifacts', 'electron-smoke-import');

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} was not found at ${targetPath}`);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to allocate a localhost port.'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function requestUrl(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode || 0);
    });

    request.on('error', reject);
    request.setTimeout(1_000, () => {
      request.destroy(new Error(`Timed out requesting ${url}`));
    });
  });
}

async function waitForServer(url, child, timeoutMs = 30_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`Packaged server exited early with code ${child.exitCode}.`);
    }

    try {
      const statusCode = await requestUrl(url);
      if (statusCode >= 200 && statusCode < 500) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Packaged server did not answer at ${url}.`);
}

async function main() {
  assertExists(exePath, 'Packaged Electron executable');
  assertExists(serverPath, 'Packaged Next server');
  assertExists(path.join(path.dirname(serverPath), 'node_modules', 'next'), 'Packaged Next dependency');

  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(exePath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      CLAUD_OMETER_IMPORT_DIR: importDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer(url, child);
    console.log(`Packaged Next server smoke check passed at ${url}.`);
  } catch (error) {
    console.error(stdout);
    console.error(stderr);
    throw error;
  } finally {
    if (child.exitCode == null) {
      child.kill();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
