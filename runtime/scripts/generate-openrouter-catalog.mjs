// Public provider metadata only. Authentication is unnecessary for this endpoint.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], 'utf8'))
  : await (await fetch('https://openrouter.ai/api/v1/models')).json();
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const rows = source.data.filter(row =>
  row.supported_parameters?.includes('tools') &&
  row.architecture?.output_modalities?.length === 1 &&
  row.architecture.output_modalities[0] === 'text' &&
  !row.id.endsWith(':batch') && !row.id.startsWith('~') &&
  (!row.expiration_date || row.expiration_date >= '2026-09-29')
).map(row => ({
  model: row.id, label: row.name,
  context: row.context_length,
  ...(row.top_provider?.max_completion_tokens > 0 ? { output: row.top_provider.max_completion_tokens } : {}),
  modalities: row.architecture.input_modalities.filter(value => ['text', 'image', 'audio'].includes(value)),
  parameters: row.supported_parameters,
  efforts: (row.reasoning?.supported_efforts ?? []).filter(value => efforts.has(value)),
  ...(efforts.has(row.reasoning?.default_effort) ? { defaultEffort: row.reasoning.default_effort } : {}),
  pricing: Object.fromEntries(Object.entries(row.pricing).filter(([, value]) => typeof value === 'string')),
  ...(row.pricing.overrides ? {priceOverrides: row.pricing.overrides} : {}),
}));
if (new Set(rows.map(row => row.model)).size !== rows.length) throw new Error('Duplicate provider model IDs');
// The complete provider snapshot is data, loaded only when capability rows are
// requested. Names and admission prices are separate projections of these rows.
// An optional output directory supports offline regeneration checks.
const directory = process.argv[3] ?? fileURLToPath(new URL('../src/llm/registry/', import.meta.url));
const prices = rows.map(({ model, pricing, priceOverrides }) => ({
  model, pricing, ...(priceOverrides === undefined ? {} : { priceOverrides }),
}));
await writeFile(resolve(directory, 'openrouter-models.data.json'), JSON.stringify(rows) + '\n');
await writeFile(resolve(directory, 'openrouter-pricing.data.json'), JSON.stringify(prices) + '\n');
await writeFile(resolve(directory, 'openrouter-model-ids.ts'),
  '/** Generated with openrouter-models.data.json; preserve provider order. */\n' +
  'export const OPENROUTER_MODEL_IDS: readonly string[] = Object.freeze(' +
  JSON.stringify(rows.map(row => row.model), null, 2) + ');\n');
console.log(`Generated ${rows.length} OpenRouter models`);
