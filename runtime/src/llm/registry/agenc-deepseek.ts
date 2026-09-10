/** Exact model in the reviewed AgenC promotion, not a public entitlement. */
export const AGENC_DEEPSEEK_MODEL = "deepseek/deepseek-v4-flash-0731";

// Native levels published for this exact model. Medium is a legacy alias
// for High, not a distinct reasoning level to offer in the selector.
export const AGENC_DEEPSEEK_REASONING_LEVELS = ["low", "high", "max"] as const;
