/** Native DeepSeek API metadata, verified 2026-09-10.
 * https://api-docs.deepseek.com/quick_start/pricing/
 * https://api-docs.deepseek.com/guides/thinking_mode/
 * The 64k default is AgenC's per-call budget; 384k is the provider ceiling.
 * Managed AgenC and third-party routes have separate contracts.
 */
export const DEEPSEEK_REASONING_LEVELS = ["low", "high", "max"] as const;
export const DEEPSEEK_MODELS = [
  { model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
].map(entry => ({
  ...entry,
  contextWindow: 1_048_576,
  maxOutputTokens: 64_000,
  maxOutputTokensUpperLimit: 384_000,
  efforts: DEEPSEEK_REASONING_LEVELS,
  defaultEffort: "high" as const,
  vision: false as const,
}));

export function isNativeDeepSeekModel(model: string | undefined): boolean {
  return DEEPSEEK_MODELS.some(entry => entry.model === model?.trim().toLowerCase());
}
