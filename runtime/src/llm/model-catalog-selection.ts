import { publishedModelCatalogEntries, publishedModelCatalogEntry } from "./registry/published-model-catalog.js";
import { looksLikeGeminiChatModelId } from "./registry/gemini-live-models.js";
import { resolveRegisteredModelCatalogEntry } from "./registry/model-catalog.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
  providerLocalModelIdFromCatalog,
  type BuiltInProviderSlug,
} from "./registry/provider-info.js";
import { listRegisteredModelCatalogEntries } from "./registry/model-catalog.js";
import { retiredBundledModel } from "./registry/model-retirement.js";
import { hasDynamicProviderModelCatalog } from "./model-metadata.js";

function editDistance(input: string, candidate: string): number {
  let previous = Array.from({ length: candidate.length + 1 }, (_, i) => i);
  for (let i = 1; i <= input.length; i++) {
    const row = [i];
    for (let j = 1; j <= candidate.length; j++) {
      row[j] = Math.min(
        row[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (input[i - 1] === candidate[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[candidate.length]!;
}

/**
 * A Gemini chat model Core does not register yet. Google's live model list
 * decides: a model it lists is accepted. Until this process has read that
 * list (selection runs before a session's first lookup), an id shaped like a
 * Gemini chat model id is accepted and the session's lookup or Google's own
 * answer to the first request settles it; anything else still gets the
 * did-you-mean error.
 */
function acceptsLiveGeminiModel(model: string): boolean {
  if (publishedModelCatalogEntry("gemini", model) !== undefined) return true;
  return publishedModelCatalogEntries("gemini") === undefined && looksLikeGeminiChatModelId(model);
}

/**
 * What to tell someone whose model the bundled catalog says the provider has
 * retired: the model, the date, and what to do. Undefined while the model is
 * not retired, and whenever the provider's live list in this process has it.
 * `now` is the clock the date is read against.
 */
export function retiredModelNotice(
  provider: BuiltInProviderSlug,
  model: string,
  now: Date = new Date(),
): string | undefined {
  const retired = retiredBundledModel(provider, model, now);
  if (retired === undefined) return undefined;
  const name = BUILT_IN_PROVIDER_DEFINITIONS[provider].name;
  return `${name} retired '${retired.model}' on ${retired.retiredOn}. Pick another model.`;
}

/** Refuse a model the bundled catalog says the provider has retired. */
export function assertModelNotRetired(
  provider: BuiltInProviderSlug,
  model: string,
  now: Date = new Date(),
): void {
  const notice = retiredModelNotice(provider, model, now);
  if (notice !== undefined) throw new Error(notice);
}

/** Validate resolved intent before an interactive switch or startup mutates state. */
export function assertModelCatalogSelection(
  config: AgenCConfig,
  provider: BuiltInProviderSlug,
  model: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: Date = new Date(),
): void {
  // Before any rule below accepts an id: a provider with its own list, an
  // operator mapping, or OpenRouter's vendor/model shape would otherwise let
  // a retired bundled model through unverified.
  assertModelNotRetired(provider, model, now);
  if (provider === "openrouter") {
    const live = publishedModelCatalogEntries(provider);
    if (live?.some(entry => entry.model === model)) return;
    if (live !== undefined) throw new Error(`OpenRouter does not list model '${model}' in its current catalog.`);
    const bundled = BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter.includes(model);
    if (bundled || /^~?[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:+-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:+-]*)*$/u.test(model)) return;
    throw new Error(`Invalid OpenRouter model id '${model}'. Use a vendor/model id.`);
  }
  if (hasDynamicProviderModelCatalog(config, provider, env)) return;
  // Explicit operator mappings can name private deployments and Bedrock
  // inference profiles. They are user-defined routes, not spelling guesses.
  if (Object.values(config.modelOverrides ?? {}).includes(model)) return;
  const models = BUILT_IN_PROVIDER_MODEL_CATALOG[provider].map(
    (entry) => providerLocalModelIdFromCatalog(provider, entry),
  );
  if (models.includes(model) || listRegisteredModelCatalogEntries(provider).some(
    (entry) => entry.model === model,
  )) return;
  if (provider === "gemini" && acceptsLiveGeminiModel(model)) return;

  let closest: string | undefined;
  let distance = Infinity;
  for (const candidate of models) {
    const score = editDistance(model.toLowerCase(), candidate.toLowerCase());
    if (score < distance) {
      closest = candidate;
      distance = score;
    }
  }
  throw new Error(
    `unknown model '${model}' for provider '${provider}'.` +
    (closest === undefined ? "" : ` did you mean '${closest}'?`),
  );
}

/** Plain notes shared by CLI and interactive selection. */
export function openRouterSelectionNotice(model: string): string | undefined {
  const live = publishedModelCatalogEntries("openrouter");
  const known = live?.some(entry => entry.model === model) ?? BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter.includes(model);
  if (!known) return `OpenRouter catalog unavailable; accepting unverified model "${model}".`;
  if (resolveRegisteredModelCatalogEntry({ provider: "openrouter", model })?.supportsToolUse === false) {
    return "Agent tools will not work with this model.";
  }
  return undefined;
}
