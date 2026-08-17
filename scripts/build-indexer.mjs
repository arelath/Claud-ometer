import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const rootDir = process.cwd();
const outputDir = path.join(rootDir, '.next', 'indexer');

function buildOptions(overrides = {}) {
  return {
    entryPoints: {
      indexer: path.join(rootDir, 'src', 'indexer', 'main.ts'),
      'summary-worker': path.join(rootDir, 'src', 'indexer', 'summary-worker.ts'),
    },
    outdir: outputDir,
    entryNames: '[name]',
    outExtension: { '.js': '.mjs' },
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
    ...overrides,
  };
}

export async function buildIndexer() {
  await build(buildOptions());
  console.log('Built session indexer sidecar.');
}

export function writeIndexerBuild(result, io = fs) {
  if (result.errors.length > 0 || !result.outputFiles?.length) {
    throw new Error('Cannot deploy an unsuccessful session indexer build.');
  }
  for (const output of result.outputFiles) {
    io.mkdirSync(path.dirname(output.path), { recursive: true });
    io.writeFileSync(output.path, output.contents);
  }
}

export async function watchIndexerBuilds(onBuild) {
  const buildContext = await context(buildOptions({
    write: false,
    plugins: [{
      name: 'agentscope-indexer-deploy',
      setup(pluginBuild) {
        pluginBuild.onEnd(result => onBuild(result));
      },
    }],
  }));
  await buildContext.watch({ delay: 150 });
  return buildContext;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) await buildIndexer();
