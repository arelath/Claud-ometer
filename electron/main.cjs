/* eslint-disable @typescript-eslint/no-require-imports */

const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');

const APP_ID = 'com.agentscope.app';
const DEV_SERVER_URL = process.env.ELECTRON_START_URL;

let mainWindow;
let nextServerProcess;
let indexerProcess;
let nextServerUrl;
let isQuitting = false;
let indexerEndpoint;
let indexerToken;
let indexerRestartTimer;
let indexerRestartDelayMs = 1000;

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

function getNextServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'next', 'server.js');
  }

  return path.join(app.getAppPath(), '.next', 'standalone', 'server.js');
}

function getIndexerPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'next', 'indexer', 'indexer.mjs');
  return path.join(app.getAppPath(), '.next', 'standalone', 'indexer', 'indexer.mjs');
}

function appendServerLog(streamName, chunk) {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, 'next-server.log'),
    `[${new Date().toISOString()}] [${streamName}] ${chunk.toString()}`,
  );
}

function appendIndexerLog(streamName, chunk) {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, 'session-indexer.log'),
    `[${new Date().toISOString()}] [${streamName}] ${chunk.toString()}`,
  );
}

function childEnvironment() {
  const importDir = path.join(app.getPath('userData'), 'dashboard-data');
  const settingsDir = path.join(app.getPath('userData'), 'settings');
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    AGENT_SCOPE_IMPORT_DIR: importDir,
    AGENT_SCOPE_SETTINGS_DIR: settingsDir,
    AGENT_SCOPE_ELECTRON_RESOURCES_DIR: process.resourcesPath,
    AGENT_SCOPE_INDEXER_ENDPOINT: indexerEndpoint,
    AGENT_SCOPE_INDEXER_TOKEN: indexerToken,
  };
}

function waitForIndexer(timeoutMs = 15_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const socket = net.createConnection(indexerEndpoint);
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', error => {
        if (Date.now() - startedAt > timeoutMs) reject(error);
        else setTimeout(check, 100);
      });
    };
    check();
  });
}

async function startIndexer() {
  const indexerPath = getIndexerPath();
  if (!fs.existsSync(indexerPath)) {
    throw new Error(`Session indexer was not found at ${indexerPath}. Run npm run electron:prepare first.`);
  }
  if (!indexerEndpoint) {
    const nonce = crypto.randomBytes(12).toString('hex');
    indexerEndpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\agentscope-indexer-${process.pid}-${nonce}`
      : path.join(os.tmpdir(), `agentscope-indexer-${process.pid}-${nonce}.sock`);
    indexerToken = crypto.randomBytes(32).toString('hex');
  }
  const child = spawn(process.execPath, ['--max-old-space-size=512', indexerPath], {
    cwd: path.dirname(indexerPath),
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  indexerProcess = child;
  child.stdout.on('data', chunk => appendIndexerLog('stdout', chunk));
  child.stderr.on('data', chunk => appendIndexerLog('stderr', chunk));
  child.on('exit', (code, signal) => {
    appendIndexerLog('exit', `Session indexer exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}\n`);
    if (indexerProcess === child) indexerProcess = undefined;
    if (!isQuitting) scheduleIndexerRestart();
  });
  await waitForIndexer();
  indexerRestartDelayMs = 1000;
}

function scheduleIndexerRestart() {
  if (isQuitting || indexerRestartTimer || indexerProcess) return;
  const delay = indexerRestartDelayMs;
  indexerRestartDelayMs = Math.min(indexerRestartDelayMs * 2, 30_000);
  indexerRestartTimer = setTimeout(async () => {
    indexerRestartTimer = undefined;
    try {
      await startIndexer();
    } catch (error) {
      appendIndexerLog('restart', `${error instanceof Error ? error.message : String(error)}\n`);
      if (indexerRestartDelayMs >= 30_000 && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox('AgentScope indexer unavailable', 'The session indexer stopped and could not be restarted yet. Existing indexed data remains available while recovery continues.');
      }
      scheduleIndexerRestart();
    }
  }, delay);
}

function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on('error', (error) => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(error);
          return;
        }
        setTimeout(check, 250);
      });

      request.setTimeout(2_000, () => {
        request.destroy(new Error('Timed out waiting for Next server.'));
      });
    };

    check();
  });
}

async function startNextServer() {
  if (DEV_SERVER_URL) return DEV_SERVER_URL;

  const serverPath = getNextServerPath();
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Next standalone server was not found at ${serverPath}. Run npm run electron:prepare first.`);
  }

  const port = await getFreePort();
  const serverDir = path.dirname(serverPath);
  const url = `http://127.0.0.1:${port}`;
  nextServerProcess = spawn(process.execPath, [serverPath], {
    cwd: serverDir,
    env: {
      ...childEnvironment(),
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  nextServerProcess.stdout.on('data', (chunk) => appendServerLog('stdout', chunk));
  nextServerProcess.stderr.on('data', (chunk) => appendServerLog('stderr', chunk));
  nextServerProcess.on('exit', (code, signal) => {
    appendServerLog('exit', `Next server exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}\n`);
    nextServerProcess = undefined;

    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('AgentScope server stopped', 'The local Next.js server stopped unexpectedly. Please restart the app.');
      mainWindow.close();
    }
  });

  await waitForServer(url);
  return url;
}

function stopNextServer() {
  if (!nextServerProcess || nextServerProcess.killed) return;
  nextServerProcess.kill();
  nextServerProcess = undefined;
}

function stopIndexer() {
  if (indexerRestartTimer) clearTimeout(indexerRestartTimer);
  indexerRestartTimer = undefined;
  if (!indexerProcess || indexerProcess.killed) return;
  const child = indexerProcess;
  indexerProcess = undefined;
  child.kill();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'AgentScope',
    backgroundColor: '#f1eadf',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(nextServerUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isConsoleWindowUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1120,
          height: 780,
          minWidth: 480,
          minHeight: 320,
          title: 'PTY Console',
          backgroundColor: '#000000',
          frame: false,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (childWindow) => {
    childWindow.setMenuBarVisibility(false);
    childWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

function isConsoleWindowUrl(url) {
  try {
    if (!nextServerUrl) return false;
    const serverUrl = new URL(nextServerUrl);
    const targetUrl = new URL(url);
    return targetUrl.origin === serverUrl.origin
      && /^\/sessions\/[^/]+\/console\/?$/.test(targetUrl.pathname);
  } catch {
    return false;
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.setAppUserModelId(APP_ID);

app.whenReady().then(async () => {
  try {
    if (!DEV_SERVER_URL) await startIndexer();
    nextServerUrl = await startNextServer();
    createMainWindow();
  } catch (error) {
    dialog.showErrorBox(
      'Unable to start AgentScope',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopNextServer();
  stopIndexer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && nextServerUrl) {
    createMainWindow();
  }
});
