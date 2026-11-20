/**
 * The OpenAI model a ChatGPT sign-in starts on: OpenAI's default, GPT-6.2
 * Astra, when the account lists it, and otherwise the best model the account
 * lists.
 *
 * A ChatGPT plan does not offer every model. On 2026-11-20 a ChatGPT account
 * signed in to Codex on the owner's PC listed only gpt-6-luna and the
 * gpt-5.6 models. The account's list is the ChatGPT backend's
 * (providers/openai/chatgpt-account-models.ts).
 *
 * @module
 */

import { retiredBundledModel } from "./model-retirement.js";
import {
  OPENAI_DEFAULT_MODEL,
  OPENAI_REASONING_MODELS,
} from "./openai-reasoning-models.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "./provider-info.js";

/**
 * Best first: the default, the reasoning rows in their default order
 * (strongest tier first, newer generation first), then the rest of Core's
 * OpenAI list in its own order.
 */
function openAiModelsBestFirst(): readonly string[] {
  return [...new Set([
    OPENAI_DEFAULT_MODEL,
    ...OPENAI_REASONING_MODELS.map((row) => row.model),
    ...BUILT_IN_PROVIDER_MODEL_CATALOG.openai,
  ])];
}

/**
 * The default for a ChatGPT account that lists `listed`: GPT-6.2 Astra when
 * it is listed, else the listed model Core ranks best. Only a model in Core's
 * OpenAI list is chosen (selection refuses any other), and never one the
 * bundled catalog says OpenAI has retired on `now`. Undefined when the
 * account lists none of them: the caller keeps the provider default.
 */
export function chatGptDefaultModel(
  listed: readonly string[],
  now: Date = new Date(),
): string | undefined {
  const available = new Set(listed.map((model) => model.trim()));
  return openAiModelsBestFirst().find(
    (model) => available.has(model) && retiredBundledModel("openai", model, now) === undefined,
  );
}
