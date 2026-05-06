/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.cwd();
const nextDir = path.join(rootDir, '.next');
const standaloneDir = path.join(nextDir, 'standalone');
const publicDir = path.join(rootDir, 'public');
const staticDir = path.join(nextDir, 'static');

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} was not found at ${targetPath}. Run next build with output: "standalone" first.`);
  }
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

assertExists(standaloneDir, 'Next standalone output');
assertExists(path.join(standaloneDir, 'server.js'), 'Next standalone server');
assertExists(staticDir, 'Next static assets');

copyDirectory(publicDir, path.join(standaloneDir, 'public'));
copyDirectory(staticDir, path.join(standaloneDir, '.next', 'static'));

console.log('Prepared .next/standalone for Electron packaging.');
