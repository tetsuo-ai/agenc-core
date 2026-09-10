/** Exact model in the reviewed AgenC promotion, not a public entitlement. */
export const AGENC_DEEPSEEK_MODEL = "deepseek/deepseek-v4-flash-0731";

// AgenC's endpoint review permits one explicit reasoning level. Other
// OpenRouter routes for this model can have different capabilities.
export const AGENC_DEEPSEEK_REASONING_LEVELS = ["medium"] as const;
