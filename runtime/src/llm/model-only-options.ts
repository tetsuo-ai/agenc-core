import type { LLMChatOptions } from "./types.js";

type ModelOnlyChatOptions = Omit<
  LLMChatOptions,
  "toolRouting" | "parallelToolCalls"
>;

/**
 * Build a model-only provider call contract.
 *
 * Model-only helper prompts must never advertise the runtime tool catalog.
 * Keep this centralized so helper/model-only call sites do not regress to the
 * provider's full-catalog fallback behavior.
 */
export function buildModelOnlyChatOptions(
  options?: ModelOnlyChatOptions,
): LLMChatOptions {
  return {
    ...(options ?? {}),
    toolRouting: { allowedToolNames: [] },
    parallelToolCalls: false,
  };
}
