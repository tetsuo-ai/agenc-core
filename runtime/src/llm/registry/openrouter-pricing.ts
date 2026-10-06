import { readFileSync } from 'node:fs';
import type { OpenRouterCatalogRow } from './openrouter-models.js';

// Admission needs every rate, including unselected providers, to preserve the
// conservative ceiling. Keep that small projection separate from capabilities.
export const OPENROUTER_PRICING: readonly Pick<
  OpenRouterCatalogRow, 'model' | 'pricing' | 'priceOverrides'
>[] = Object.freeze(JSON.parse(
  readFileSync(new URL('./openrouter-pricing.data.json', import.meta.url), 'utf8'),
));
