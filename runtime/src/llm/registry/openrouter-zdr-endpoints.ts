/**
 * OpenRouter's public list of zero-data-retention (ZDR) endpoints.
 *
 * AgenC sends `provider.zdr = true` on every OpenRouter request unless
 * `[providers.openrouter] zero_data_retention = false`. OpenRouter then routes
 * only to endpoints on this list and refuses a model that has none. The TUI
 * reads the list (no key needed) so the model picker and the status line can
 * tell which models still work under zero retention before a request fails.
 * https://openrouter.ai/docs/guides/features/zdr
 *
 * @module
 */

import { asRecord } from "../../utils/record.js";

export const OPENROUTER_ZDR_ENDPOINTS_URL = "https://openrouter.ai/api/v1/endpoints/zdr";

/**
 * Variant suffixes that only change how OpenRouter sorts the base model's
 * endpoints, so the base model's ZDR endpoints answer for them. `:free` and
 * `:online` are not here: free endpoints are listed on their own, and web
 * search plugins are outside ZDR.
 */
const SORTING_VARIANTS: ReadonlySet<string> = new Set(["nitro", "floor", "exacto"]);

let recorded: ReadonlySet<string> | undefined;

/**
 * Record the list's model ids. Returns false and keeps the previous list when
 * the body is not the list (an error page, an empty answer).
 */
export function recordOpenRouterZdrEndpoints(body: unknown): boolean {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return false;
  const models = new Set<string>();
  for (const entry of data) {
    const id = asRecord(entry)?.model_id;
    if (typeof id === "string" && id.trim().length > 0) models.add(id.trim());
  }
  if (models.size === 0) return false;
  recorded = models;
  return true;
}

/**
 * Router and alias ids (`openrouter/auto`, `~z-ai/glm-latest`) choose a model
 * per request. The list names concrete models only, so it cannot answer for
 * them; OpenRouter still applies the ZDR filter when it routes.
 */
export function isOpenRouterRouterModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return id.startsWith("~") || id.startsWith("openrouter/");
}

/**
 * Whether OpenRouter lists a ZDR endpoint for this model. `undefined` when the
 * list has not been read yet or the id is a router the list cannot answer for.
 */
export function openRouterModelHasZdrEndpoint(model: string): boolean | undefined {
  if (recorded === undefined || isOpenRouterRouterModel(model)) return undefined;
  const id = model.trim();
  if (recorded.has(id)) return true;
  const colon = id.lastIndexOf(":");
  if (colon > 0 && SORTING_VARIANTS.has(id.slice(colon + 1).toLowerCase())) {
    return recorded.has(id.slice(0, colon));
  }
  return false;
}

/** Whether the list has been read in this process. */
export function openRouterZdrEndpointsKnown(): boolean {
  return recorded !== undefined;
}

export function resetOpenRouterZdrEndpointsForTesting(): void {
  recorded = undefined;
}
