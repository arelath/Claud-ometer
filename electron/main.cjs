/* eslint-disable @typescript-eslint/no-require-imports */

const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_ID = 'com.claudometer.app';
const DEV_SERVER_URL = process.env.ELECTRON_START_URL;

let mainWindow;
let nextServerProcess;
let nextServerUrl;
let isQuitting = false;

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

function appendServerLog(streamName, chunk) {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, 'next-server.log'),
    `[${new Date().toISOString()}] [${streamName}] ${chunk.toString()}`,
  );
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
  const importDir = path.join(app.getPath('userData'), 'dashboard-data');

  nextServerProcess = spawn(process.execPath, [serverPath], {
    cwd: serverDir,
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

  nextServerProcess.stdout.on('data', (chunk) => appendServerLog('stdout', chunk));
  nextServerProcess.stderr.on('data', (chunk) => appendServerLog('stderr', chunk));
  nextServerProcess.on('exit', (code, signal) => {
    appendServerLog('exit', `Next server exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}\n`);
    nextServerProcess = undefined;

    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('Claud-ometer server stopped', 'The local Next.js server stopped unexpectedly. Please restart the app.');
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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'Claud-ometer',
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
    shell.openExternal(url);
    return { action: 'deny' };
  });
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
    nextServerUrl = await startNextServer();
    createMainWindow();
  } catch (error) {
    dialog.showErrorBox(
      'Unable to start Claud-ometer',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopNextServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && nextServerUrl) {
    createMainWindow();
  }
});
