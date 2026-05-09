/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, '.next', 'standalone', 'node_modules');
  const destination = path.join(context.appOutDir, 'resources', 'next', 'node_modules');

  if (!fs.existsSync(source)) {
    throw new Error(`Next standalone node_modules not found at ${source}`);
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });

  const preferredMsys2Source = path.join(context.packager.projectDir, 'vendor', 'msys2');
  const legacyMsys2Source = path.join(context.packager.projectDir, 'vender', 'msys2');
  const msys2Source = fs.existsSync(preferredMsys2Source) ? preferredMsys2Source : legacyMsys2Source;
  const msys2Destination = path.join(context.appOutDir, 'resources', 'msys2');
  if (fs.existsSync(msys2Source)) {
    fs.rmSync(msys2Destination, { recursive: true, force: true });
    fs.cpSync(msys2Source, msys2Destination, { recursive: true });
  }
};
