// Public provider metadata only. Authentication is unnecessary for this endpoint.
import { readFile, writeFile } from 'node:fs/promises';
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
const output = `/** Generated from https://openrouter.ai/api/v1/models, verified 2026-09-29.
 * Text-output models advertising function tools; batch, routing aliases and
 * media-only models are excluded. Missing output limits and efforts stay unknown.
 * Regenerate: node runtime/scripts/generate-openrouter-catalog.mjs [snapshot.json]
 */
import type { ReasoningEffort } from '../../session/turn-context.js';
export interface OpenRouterCatalogRow {
  readonly model: string; readonly label: string; readonly context: number;
  readonly output?: number; readonly modalities: readonly ('text' | 'image' | 'audio')[];
  readonly parameters: readonly string[]; readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort?: ReasoningEffort; readonly pricing: Readonly<Record<string, string | undefined>>;
  readonly priceOverrides?: readonly { readonly min_prompt_tokens?: number; readonly utc_start?: number; readonly utc_end?: number; readonly prompt: string; readonly completion: string; readonly input_cache_read?: string; readonly input_cache_write?: string }[];
}
export const OPENROUTER_MODELS: readonly OpenRouterCatalogRow[] = Object.freeze([\n${rows.map(row => '  '+JSON.stringify(row)+',').join('\n')}\n]);\n`;
await writeFile(new URL('../src/llm/registry/openrouter-models.ts', import.meta.url), output);
console.log(`Generated ${rows.length} OpenRouter models`);
