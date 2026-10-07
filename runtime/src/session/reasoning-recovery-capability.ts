import { isNativeDeepSeekModel } from "../llm/registry/deepseek-models.js";

/** Pure capability metadata, also safe to load from durable state readers. */
export function supportsThinkingOffRecovery(provider: string, model: string): boolean {
  return provider === "deepseek" && isNativeDeepSeekModel(model);
}
