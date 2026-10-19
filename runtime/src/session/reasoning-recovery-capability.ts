import { isNativeDeepSeekModel } from "../llm/registry/deepseek-models.js";

/** Pure capability metadata, also safe to load from durable state readers. */
export function supportsThinkingOffRecovery(provider: string, model: string): boolean {
  return provider === "deepseek" && isNativeDeepSeekModel(model);
}

/**
 * Native DeepSeek reads a standalone user-role message after a tool result as a
 * new request. With `runtime_context_in_tool_results` the wire carries runtime
 * context inside that tool result instead, as the managed route already does.
 */
export function supportsToolResultRuntimeContext(provider: string, model: string): boolean {
  return provider === "deepseek" && isNativeDeepSeekModel(model);
}
