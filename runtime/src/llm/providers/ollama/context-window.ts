/**
 * The context window Core gives a local Ollama model when the user sets none
 * (`providers.ollama.context_window_tokens`).
 *
 * Ollama picks its own default from the GPU memory it sees (4,096 tokens below
 * 24 GiB), which is too small for agent work, and Core used to admit requests
 * against the model's trained length while Ollama ran at that default, so
 * Ollama silently dropped the oldest messages. Core now sends one `num_ctx` per
 * model, this default capped at the trained length, and admits against the
 * same number. One value per model matters: Ollama reloads a model whenever
 * `num_ctx` changes.
 */
export const OLLAMA_DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;

/** The window Core runs a local model at, from its trained length. */
export function ollamaRuntimeContextWindow(trainedLength: number | undefined): number | undefined {
  if (trainedLength === undefined || !Number.isSafeInteger(trainedLength) || trainedLength < 1) {
    return undefined;
  }
  return Math.min(trainedLength, OLLAMA_DEFAULT_CONTEXT_WINDOW_TOKENS);
}

/**
 * The trained context length from an `/api/show` response. The key is
 * architecture-prefixed (`qwen2.context_length`, `gptoss.context_length`).
 */
export function ollamaTrainedContextLength(showResponse: unknown): number | undefined {
  if (showResponse === null || typeof showResponse !== "object") return undefined;
  const modelInfo = (showResponse as { model_info?: unknown }).model_info;
  if (modelInfo === null || typeof modelInfo !== "object") return undefined;
  for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (!/(?:^|\.)context_length$/u.test(key)) continue;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}
