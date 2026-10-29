/**
 * Model rows a provider publishes with its live model list: Venice's and
 * abliteration.ai's `GET /models`, Ollama Cloud's `GET /api/tags` and
 * `POST /api/show`, OpenRouter's public `GET /models`, and the Gemini chat
 * models Google lists that Core's bundled registry does not know yet
 * (gemini-live-models.ts). Discovery records them here and the
 * registered-catalog resolver reads them before the bundled snapshot, so a
 * model's capability flags (tools, thinking, image input), effort levels and
 * limits come from the provider's current list, including for models the
 * bundled snapshot does not know yet. The bundled rows stay the offline
 * fallback.
 *
 * One process holds one view: the daemon records what its sessions
 * discovered, the TUI records what its menus and `/effort` read.
 *
 * @module
 */

import type { RegisteredModelCatalogEntry } from "./model-catalog.js";

/** Providers whose live list may replace the bundled catalog rows. */
export const PUBLISHED_CATALOG_PROVIDERS: ReadonlySet<string> = new Set([
  "venice",
  "ollama-cloud",
  "openrouter",
  "abliteration",
  "gemini",
]);

const published = new Map<string, Map<string, RegisteredModelCatalogEntry>>();
/** provider -> model -> when its per-model detail lookup last answered. */
const detailed = new Map<string, Map<string, number>>();
let revision = 0;

function key(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Record one provider's published rows. `replace` (a complete list) drops
 * rows the provider no longer lists; without it the rows are merged, as a
 * per-model detail lookup (`/api/show`) adds to an earlier list.
 */
export function recordPublishedModelCatalog(
  provider: string,
  entries: readonly RegisteredModelCatalogEntry[],
  options: { readonly replace?: boolean } = {},
): void {
  if (!PUBLISHED_CATALOG_PROVIDERS.has(provider)) return;
  const current = options.replace === true
    ? new Map<string, RegisteredModelCatalogEntry>()
    : new Map(published.get(provider) ?? []);
  for (const entry of entries) current.set(key(entry.model), entry);
  published.set(provider, current);
  // A complete list may come from a lookup that did not carry another
  // lookup's per-model details, so their marks no longer hold.
  if (options.replace === true) detailed.delete(provider);
  revision += 1;
}

/**
 * Mark that the provider's per-model detail lookup (Ollama Cloud's
 * `/api/show`) answered for `model` at `at` and its row is recorded. Pass the
 * time the endpoint answered, not when a cache returned the answer. Call it
 * after recordPublishedModelCatalog.
 */
export function recordPublishedModelDetail(provider: string, model: string, at: number = Date.now()): void {
  if (!PUBLISHED_CATALOG_PROVIDERS.has(provider)) return;
  const rows = detailed.get(provider) ?? new Map<string, number>();
  rows.set(key(model), at);
  detailed.set(provider, rows);
}

/** When the endpoint answered the per-model detail behind `model`'s published row. */
export function publishedModelDetailRecordedAt(provider: string, model: string): number | undefined {
  return detailed.get(provider)?.get(key(model));
}

/** The provider's published row for one model, if its live list has one. */
export function publishedModelCatalogEntry(
  provider: string,
  model: string,
): RegisteredModelCatalogEntry | undefined {
  return published.get(provider)?.get(key(model));
}

/** Every published row of one provider, in the provider's list order. */
export function publishedModelCatalogEntries(
  provider: string,
): readonly RegisteredModelCatalogEntry[] | undefined {
  const rows = published.get(provider);
  return rows === undefined ? undefined : Object.freeze([...rows.values()]);
}

/** Changes whenever a list is recorded; caches keyed on catalog data use it. */
export function publishedModelCatalogRevision(): number {
  return revision;
}

/** Test seam: forget every recorded list. */
export function clearPublishedModelCatalogs(): void {
  published.clear();
  detailed.clear();
  revision += 1;
}

/** Forget one provider when its live catalog is unavailable. */
export function clearPublishedModelCatalog(provider: string): void {
  published.delete(provider);
  detailed.delete(provider);
  revision += 1;
}
