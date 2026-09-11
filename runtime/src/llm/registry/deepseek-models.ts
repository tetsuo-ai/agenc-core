/** Native DeepSeek API metadata, verified 2026-09-11.
 * https://api-docs.deepseek.com/quick_start/pricing/
 * https://api-docs.deepseek.com/guides/thinking_mode/
 * The 64k default is AgenC's per-call budget; 384k is the provider ceiling.
 * Managed AgenC and third-party routes have separate contracts.
 */
export const DEEPSEEK_REASONING_LEVELS = ["low", "high", "max"] as const;
export const DEEPSEEK_FLASH_MODEL = "deepseek-flash";
export const DEEPSEEK_MODELS = [
  { model: DEEPSEEK_FLASH_MODEL, label: "DeepSeek V4.1 Flash", vision: true },
  { model: "deepseek-v4-pro", label: "DeepSeek V4 Pro", vision: false },
].map(entry => ({
  ...entry,
  contextWindow: 1_048_576,
  maxOutputTokens: 64_000,
  maxOutputTokensUpperLimit: 384_000,
  efforts: DEEPSEEK_REASONING_LEVELS,
  defaultEffort: "high" as const,
}));

// DeepSeek now serves V4.1 for these retired native Flash names. Keep saved
// sessions readable without presenting aliases as additional selectable models.
export const DEEPSEEK_MODEL_ALIASES = [
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
].map(model => ({ ...DEEPSEEK_MODELS[0]!, model }));

export function isNativeDeepSeekModel(model: string | undefined): boolean {
  return [...DEEPSEEK_MODELS, ...DEEPSEEK_MODEL_ALIASES].some(
    entry => entry.model === model?.trim().toLowerCase(),
  );
}
