/** Generated from https://openrouter.ai/api/v1/models, verified 2026-09-29.
 * Text-output models advertising function tools; batch, routing aliases and
 * media-only models are excluded. Missing output limits and efforts stay unknown.
 * Regenerate: node runtime/scripts/generate-openrouter-catalog.mjs [snapshot.json]
 */
import { readFileSync } from 'node:fs';
import { OPENROUTER_MODEL_IDS } from './openrouter-model-ids.js';
import { frozenLazyArray } from './catalog-array.js';
import type { ReasoningEffort } from '../../session/turn-context.js';
export interface OpenRouterCatalogRow {
  readonly model: string; readonly label: string; readonly context: number;
  readonly output?: number; readonly modalities: readonly ('text' | 'image' | 'audio')[];
  readonly parameters: readonly string[]; readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort?: ReasoningEffort; readonly pricing: Readonly<Record<string, string | undefined>>;
  readonly priceOverrides?: readonly { readonly min_prompt_tokens?: number; readonly utc_start?: number; readonly utc_end?: number; readonly prompt: string; readonly completion: string; readonly input_cache_read?: string; readonly input_cache_write?: string }[];
}
let loadedModels: readonly OpenRouterCatalogRow[] | undefined;

function loadModels(): readonly OpenRouterCatalogRow[] {
  if (loadedModels === undefined) {
    const rows: OpenRouterCatalogRow[] = JSON.parse(
      readFileSync(new URL('./openrouter-models.data.json', import.meta.url), 'utf8'),
    );
    if (rows.length !== OPENROUTER_MODEL_IDS.length ||
        rows.some((row, index) => row.model !== OPENROUTER_MODEL_IDS[index])) {
      throw new Error('OpenRouter catalog data does not match its model index');
    }
    loadedModels = Object.freeze(rows);
  }
  return loadedModels;
}

/** The same frozen array surface; full rows are read only on first access. */
export const OPENROUTER_MODELS: readonly OpenRouterCatalogRow[] = frozenLazyArray(
  OPENROUTER_MODEL_IDS.length,
  index => loadModels()[index]!,
);
