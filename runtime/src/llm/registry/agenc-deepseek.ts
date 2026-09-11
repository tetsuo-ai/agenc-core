/** Exact route identities, never a public entitlement or an automatic migration. */
export const AGENC_DEEPSEEK_MODEL = "deepseek/deepseek-v4-flash-0731";
export const AGENC_DEEPSEEK_V41_MODEL = "deepseek/deepseek-v4.1-flash";
export const AGENC_DEEPSEEK_MODELS = [
  { model: AGENC_DEEPSEEK_MODEL, label: "DeepSeek V4 Flash 0731" },
  { model: AGENC_DEEPSEEK_V41_MODEL, label: "DeepSeek V4.1 Flash" },
] as const;

export function isAgenCDeepSeekModel(model: string | undefined): boolean {
  return AGENC_DEEPSEEK_MODELS.some(entry => entry.model === model);
}

// Native levels published for this exact model. Medium is a legacy alias
// for High, not a distinct reasoning level to offer in the selector.
export const AGENC_DEEPSEEK_REASONING_LEVELS = ["low", "high", "max"] as const;
