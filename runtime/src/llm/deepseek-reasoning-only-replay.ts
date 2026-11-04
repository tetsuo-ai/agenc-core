import { getSelectedProviderEnvironment } from "../utils/model/provider-selection.js";
import { isEnvDefinedFalsy } from "../utils/envBoolean.js";
import { isNativeDeepSeekModel } from "./registry/deepseek-models.js";
import type { ProviderReasoningProvenance } from "./types.js";

/** Retain same-route reasoning by default, scoped to the session environment. */
export function deepSeekReasoningOnlyReplayProvenance(
  provider: string,
  model: string,
): ProviderReasoningProvenance | undefined {
  if (provider !== "deepseek" || !isNativeDeepSeekModel(model)) return undefined;
  try {
    return !isEnvDefinedFalsy(getSelectedProviderEnvironment().AGENC_DEEPSEEK_REASONING_ONLY_REPLAY)
      ? { provider, model }
      : undefined;
  } catch {
    return undefined;
  }
}
