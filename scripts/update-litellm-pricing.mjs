import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OUT_PATH = path.join(__dirname, '..', 'src', 'config', 'litellm-pricing.generated.json');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          fetchJson(response.headers.location).then(resolve, reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to fetch ${url}: HTTP ${response.statusCode}`));
          response.resume();
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function toPerMillion(value) {
  return Number((Number(value) * 1_000_000).toFixed(8));
}

function hasNumericPrice(entry, key) {
  return typeof entry[key] === 'number' && Number.isFinite(entry[key]);
}

const registry = await fetchJson(SOURCE_URL);
const models = {};

for (const [model, entry] of Object.entries(registry)) {
  if (
    !shouldIncludeModel(model, entry) ||
    !hasNumericPrice(entry, 'input_cost_per_token') ||
    !hasNumericPrice(entry, 'output_cost_per_token')
  ) {
    continue;
  }

  models[model] = {
    provider: entry.litellm_provider,
    inputPerMillion: toPerMillion(entry.input_cost_per_token),
    outputPerMillion: toPerMillion(entry.output_cost_per_token),
    cacheWritePerMillion: hasNumericPrice(entry, 'cache_creation_input_token_cost')
      ? toPerMillion(entry.cache_creation_input_token_cost)
      : 0,
    cacheReadPerMillion: hasNumericPrice(entry, 'cache_read_input_token_cost')
      ? toPerMillion(entry.cache_read_input_token_cost)
      : 0,
  };
}

const output = {
  source: SOURCE_URL,
  updatedAt: new Date().toISOString(),
  models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b))),
};

fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${Object.keys(output.models).length} LiteLLM pricing entries to ${OUT_PATH}`);

function shouldIncludeModel(model, entry) {
  if (entry.litellm_provider === 'anthropic') {
    return model.startsWith('claude-');
  }

  if (entry.litellm_provider !== 'openai') {
    return false;
  }

  if (model.includes('/')) return false;
  if (model.startsWith('ft:')) return false;
  if (
    model.includes('audio') ||
    model.includes('image') ||
    model.includes('realtime') ||
    model.includes('search') ||
    model.includes('transcribe') ||
    model.includes('tts')
  ) {
    return false;
  }

  return (
    model.startsWith('gpt-') ||
    /^o\d/.test(model) ||
    model.startsWith('o1-') ||
    model.startsWith('o3-') ||
    model.startsWith('o4-')
  );
}
