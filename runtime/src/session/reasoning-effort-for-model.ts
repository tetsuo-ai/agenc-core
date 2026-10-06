/**
 * The reasoning effort a session may hold for a given model.
 *
 * A session runs either at a level its model accepts or at no level, which
 * leaves the model at its own default. A model switch keeps a level the new
 * model accepts and drops any other one, so the new model runs at its default,
 * as a fresh session on it would. Carrying the old level over would either
 * fail every request (Gemini refuses a thinking level the model lacks) or run
 * the new model at a level nobody chose for it.
 *
 * @module
 */

import type { AgenCConfig } from "../config/schema.js";
import { readProviderConfig } from "../config/resolve-provider.js";
import { resolveProviderModelCapabilities } from "../llm/capabilities.js";
import { resolveReasoningEffort } from "../llm/reasoning-effort.js";
import { anthropicSupportsBetweenToolsThinking } from "../utils/model/anthropicThinkingControl.js";
import { resolveBedrockModelIdentity } from "../utils/model/claudeModelId.js";

export interface ReasoningEffortForModel {
  /** The level the session keeps; undefined follows the model default. */
  readonly reasoningEffort: string | undefined;
  /** The level the model does not accept, when one was dropped. */
  readonly dropped?: string;
}

/**
 * Whether `model` accepts `reasoningEffort`. Configured capability overrides
 * apply, and a Bedrock profile id is judged as the Claude model a configured
 * override maps it to, as the Converse adapter reads it. When Core registers
 * the model's levels, only those count. A model that takes effort but whose
 * levels Core does not know keeps the level the user set.
 */
export function reasoningEffortAcceptedByModel(input: {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly config?: AgenCConfig;
}): boolean {
  const model =
    input.provider.trim().toLowerCase() === "amazon-bedrock"
      ? resolveBedrockModelIdentity(input.model, input.config?.modelOverrides)
      : input.model;
  const overrides =
    input.config === undefined
      ? undefined
      : readProviderConfig(input.config, input.provider)?.capability_overrides;
  const capabilities = resolveProviderModelCapabilities({
    provider: input.provider,
    model,
    overrides,
  });
  if (!capabilities.acceptsReasoningEffort) return false;
  // Sonnet 5.5 turns up-front reasoning off with none (between-tools
  // thinking), a mode outside its effort levels.
  if (
    input.reasoningEffort === "none" &&
    capabilities.provider === "anthropic" &&
    anthropicSupportsBetweenToolsThinking(model)
  ) {
    return true;
  }
  const { registered, levels } = resolveReasoningEffort({
    provider: input.provider,
    model,
  });
  return registered || levels.length > 0
    ? levels.includes(input.reasoningEffort)
    : true;
}

/** The effort a session keeps when it runs `model`. */
export function reasoningEffortForModel(input: {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string | undefined;
  readonly config?: AgenCConfig;
}): ReasoningEffortForModel {
  const { reasoningEffort } = input;
  if (reasoningEffort === undefined) return { reasoningEffort: undefined };
  return reasoningEffortAcceptedByModel({ ...input, reasoningEffort })
    ? { reasoningEffort }
    : { reasoningEffort: undefined, dropped: reasoningEffort };
}

/** What the user reads when a model switch drops the session's effort. */
export function droppedReasoningEffortNotice(
  model: string,
  dropped: string,
): string {
  return dropped === "none"
    ? `${model} cannot turn reasoning off, so the session now uses its default effort.`
    : `${model} does not support ${dropped} reasoning effort, so the session now uses its default effort.`;
}
