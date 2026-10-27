import { getSelectedProviderEnvironment } from "../utils/model/provider-selection.js";
import { isEnvTruthy } from "../utils/envBoolean.js";
import { isNativeDeepSeekModel } from "./registry/deepseek-models.js";
import type { ProviderReasoningProvenance } from "./types.js";

/** Experimental retention, scoped to the environment captured for this session. */
export function deepSeekReasoningOnlyReplayProvenance(
  provider: string,
  model: string,
): ProviderReasoningProvenance | undefined {
  if (provider !== "deepseek" || !isNativeDeepSeekModel(model)) return undefined;
  try {
    return isEnvTruthy(getSelectedProviderEnvironment().AGENC_DEEPSEEK_REASONING_ONLY_REPLAY)
      ? { provider, model }
      : undefined;
  } catch {
    return undefined;
  }
}
