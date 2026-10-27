/**
 * gpt-oss on a local Ollama server takes a reasoning level in `think`
 * ("low", "medium" or "high"; Ollama's default is "medium") and cannot turn
 * its thinking off: `think: false` still thinks. Probed 2026-10-22 on
 * Ollama's native /api/chat with gpt-oss:20b: low 71, default 307 and high
 * 1,973 characters of thinking for the same question.
 * https://docs.ollama.com/capabilities/thinking
 *
 * Only the library names count (`gpt-oss`, `gpt-oss-safeguard`, any tag,
 * optionally under a namespace). A GGUF imported under another name may not
 * use Ollama's gpt-oss template, so it keeps the model's own default.
 */
export const OLLAMA_GPT_OSS_REASONING_LEVELS = ["low", "medium", "high"] as const;

export type OllamaGptOssThinkLevel = (typeof OLLAMA_GPT_OSS_REASONING_LEVELS)[number];

export function isOllamaGptOssModel(model: string | undefined): boolean {
  return /^(?:[\w.-]+\/)?gpt-oss(?:-safeguard)?(?::[\w.-]+)?$/iu.test(model?.trim() ?? "");
}

/**
 * The `think` level for a session's effort, or undefined to send none (the
 * model's own default). gpt-oss has no level below low or above high.
 */
export function ollamaGptOssThinkLevel(effort: string | undefined): OllamaGptOssThinkLevel | undefined {
  switch (effort) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return undefined;
  }
}
