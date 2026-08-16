import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();

async function buildEntry(entry, outfile) {
  await build({
    entryPoints: [path.join(rootDir, 'src', 'indexer', entry)],
    outfile: path.join(rootDir, '.next', 'indexer', outfile),
    bundle: true,
    // Keep tiktoken's CommonJS WASM loader intact. Inlining it into this ESM
    // bundle combines __dirname with our top-level await, which Node 24 rejects
    // as ambiguous module syntax.
    external: ['tiktoken/lite'],
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    tsconfig: path.join(rootDir, 'tsconfig.json'),
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
}

await buildEntry('main.ts', 'indexer.mjs');
await buildEntry('summary-worker.ts', 'summary-worker.mjs');

console.log('Built session indexer sidecar.');
