/**
 * OpenAI-compatible context/output token limits.
 *
 * Adapted from OpenClaude's openaiContextWindows table, with AgenC-native
 * callers and environment names. Unknown compatible models use a 128k context
 * fallback and 32k/64k output defaults so local compatible endpoints do not
 * silently fall back to tiny legacy completion budgets.
 *
 * @module
 */

export const OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000;
export const CAPPED_DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
export const ESCALATED_MAX_OUTPUT_TOKENS = 64_000;

const OPENAI_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  "github:copilot": 128_000,
  "github:copilot:claude-sonnet-4": 216_000,
  "github:copilot:claude-haiku-4": 200_000,
  "github:copilot:claude-haiku-4.5": 144_000,
  "github:copilot:claude-sonnet-4.5": 200_000,
  "github:copilot:claude-sonnet-4.6": 200_000,
  "github:copilot:claude-opus-4": 200_000,
  "github:copilot:claude-opus-4.6": 200_000,
  "github:copilot:gpt-3.5-turbo": 16_384,
  "github:copilot:gpt-4": 32_768,
  "github:copilot:gpt-4-0125-preview": 128_000,
  "github:copilot:gpt-4-o-preview": 128_000,
  "github:copilot:gpt-4.1": 128_000,
  "github:copilot:gpt-4o": 128_000,
  "github:copilot:gpt-4o-mini": 128_000,
  "github:copilot:gpt-5-mini": 264_000,
  "github:copilot:gpt-5.1": 264_000,
  "github:copilot:gpt-5.2": 400_000,
  "github:copilot:gpt-5.2-codex": 400_000,
  "github:copilot:gpt-5.3-codex": 400_000,
  "github:copilot:gpt-5.4": 400_000,
  "github:copilot:gpt-5.4-mini": 400_000,
  "github:copilot:gemini-2.5-pro": 128_000,
  "github:copilot:gemini-3-flash-preview": 128_000,
  "github:copilot:gemini-3.1-pro-preview": 200_000,
  "github:copilot:grok-code-fast-1": 256_000,
  "github_copilot/claude-sonnet-4.6": 200_000,
  "github_copilot/claude-opus-4.6": 200_000,
  "github_copilot/claude-haiku-4.5": 144_000,
  "github_copilot/gpt-4.1": 128_000,
  "github_copilot/gpt-4o": 128_000,
  "github_copilot/gpt-5-mini": 264_000,
  "github_copilot/gpt-5.4": 400_000,
  "github_copilot/gpt-5.4-mini": 400_000,
  "github_copilot/gemini-2.5-pro": 128_000,
  "github_copilot/gemini-3-flash": 128_000,
  "github_copilot/grok-code-fast-1": 256_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o1-preview": 128_000,
  "o1-pro": 200_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,
  "llama-3.3-70b-versatile": 128_000,
  "llama-3.1-8b-instant": 128_000,
  "mixtral-8x7b-32768": 32_768,
  "mistral-large-latest": 256_000,
  "mistral-small-latest": 256_000,
  "devstral-latest": 256_000,
  "ministral-3b-latest": 256_000,
  "google/gemini-2.0-flash": 1_048_576,
  "google/gemini-2.5-pro": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-3.1-pro": 1_048_576,
  "gemini-3.1-flash-lite-preview": 1_048_576,
  "llama3.3:70b": 128_000,
  "llama3.1:8b": 128_000,
  "llama3.2:3b": 128_000,
  "qwen2.5-coder:32b": 32_768,
  "qwen2.5-coder:7b": 32_768,
  "deepseek-coder-v2:16b": 163_840,
  "deepseek-r1:14b": 65_536,
  "mistral:7b": 32_768,
  "phi4:14b": 16_384,
  "gemma2:27b": 8_192,
  "codellama:13b": 16_384,
  "llama3.2:1b": 128_000,
  "qwen3:8b": 128_000,
  "codestral": 32_768,
  "qwen3.6-plus": 1_000_000,
  "qwen3.5-plus": 1_000_000,
  "qwen3-coder-plus": 1_000_000,
  "qwen3-coder-next": 262_144,
  "qwen3-max": 262_144,
  "qwen3-max-2026-01-23": 262_144,
  "kimi-k2.5": 262_144,
  "glm-5": 202_752,
  "glm-4.7": 202_752,
});

const OPENAI_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  "github:copilot": 16_384,
  "github:copilot:claude-sonnet-4": 16_000,
  "github:copilot:claude-haiku-4": 64_000,
  "github:copilot:claude-haiku-4.5": 32_768,
  "github:copilot:claude-sonnet-4.5": 32_000,
  "github:copilot:claude-sonnet-4.6": 32_000,
  "github:copilot:claude-opus-4": 32_000,
  "github:copilot:claude-opus-4.6": 32_000,
  "github:copilot:gpt-3.5-turbo": 4_096,
  "github:copilot:gpt-4": 4_096,
  "github:copilot:gpt-4-0125-preview": 4_096,
  "github:copilot:gpt-4-o-preview": 4_096,
  "github:copilot:gpt-4.1": 16_384,
  "github:copilot:gpt-4o": 4_096,
  "github:copilot:gpt-4o-mini": 4_096,
  "github:copilot:gpt-5-mini": 64_000,
  "github:copilot:gpt-5.1": 64_000,
  "github:copilot:gpt-5.2": 128_000,
  "github:copilot:gpt-5.2-codex": 128_000,
  "github:copilot:gpt-5.3-codex": 128_000,
  "github:copilot:gpt-5.4": 128_000,
  "github:copilot:gpt-5.4-mini": 128_000,
  "github:copilot:gemini-2.5-pro": 64_000,
  "github:copilot:gemini-3-flash-preview": 64_000,
  "github:copilot:gemini-3.1-pro-preview": 64_000,
  "github:copilot:grok-code-fast-1": 64_000,
  "github_copilot/claude-sonnet-4.6": 32_000,
  "github_copilot/claude-opus-4.6": 32_000,
  "github_copilot/claude-haiku-4.5": 32_768,
  "github_copilot/gpt-4.1": 16_384,
  "github_copilot/gpt-4o": 4_096,
  "github_copilot/gpt-5-mini": 64_000,
  "github_copilot/gpt-5.4": 128_000,
  "github_copilot/gpt-5.4-mini": 128_000,
  "github_copilot/gemini-2.5-pro": 64_000,
  "github_copilot/gemini-3-flash": 64_000,
  "github_copilot/grok-code-fast-1": 64_000,
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
  "gpt-5.4-nano": 128_000,
  "gpt-5": 128_000,
  "gpt-4o": 16_384,
  "gpt-4o-mini": 16_384,
  "gpt-4.1": 32_768,
  "gpt-4.1-mini": 32_768,
  "gpt-4.1-nano": 32_768,
  "gpt-4-turbo": 4_096,
  "gpt-4": 4_096,
  "o1": 100_000,
  "o1-mini": 65_536,
  "o1-preview": 32_768,
  "o1-pro": 100_000,
  "o3": 100_000,
  "o3-mini": 100_000,
  "o4-mini": 100_000,
  "deepseek-chat": 8_192,
  "deepseek-reasoner": 32_768,
  "llama-3.3-70b-versatile": 32_768,
  "llama-3.1-8b-instant": 8_192,
  "mixtral-8x7b-32768": 32_768,
  "mistral-large-latest": 32_768,
  "mistral-small-latest": 32_768,
  "google/gemini-2.0-flash": 8_192,
  "google/gemini-2.5-pro": 65_536,
  "gemini-2.0-flash": 8_192,
  "gemini-2.5-pro": 65_536,
  "gemini-2.5-flash": 65_536,
  "gemini-3.1-pro": 65_536,
  "gemini-3.1-flash-lite-preview": 65_536,
  "llama3.3:70b": 4_096,
  "llama3.1:8b": 4_096,
  "llama3.2:3b": 4_096,
  "qwen2.5-coder:32b": 8_192,
  "qwen2.5-coder:7b": 8_192,
  "deepseek-coder-v2:16b": 8_192,
  "deepseek-r1:14b": 8_192,
  "mistral:7b": 4_096,
  "phi4:14b": 4_096,
  "gemma2:27b": 4_096,
  "codellama:13b": 4_096,
  "llama3.2:1b": 4_096,
  "qwen3:8b": 8_192,
  "codestral": 8_192,
  "qwen3.6-plus": 65_536,
  "qwen3.5-plus": 65_536,
  "qwen3-coder-plus": 65_536,
  "qwen3-coder-next": 65_536,
  "qwen3-max": 32_768,
  "qwen3-max-2026-01-23": 32_768,
  "kimi-k2.5": 32_768,
  "glm-5": 16_384,
  "glm-4.7": 16_384,
});

function lookupByKey<T>(
  table: Readonly<Record<string, T>>,
  model: string,
): T | undefined {
  if (table[model] !== undefined) return table[model];
  const sortedKeys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (model.startsWith(key)) return table[key];
  }
  return undefined;
}

function lookupByModel<T>(params: {
  readonly table: Readonly<Record<string, T>>;
  readonly model: string;
  readonly providerQualifier?: string;
}): T | undefined {
  const model = params.model.trim();
  const qualifier = params.providerQualifier?.trim();
  if (qualifier && qualifier !== model) {
    const qualified = `${qualifier}:${model}`;
    const qualifiedResult = lookupByKey(params.table, qualified);
    if (qualifiedResult !== undefined) return qualifiedResult;
  }
  return lookupByKey(params.table, model);
}

export function getOpenAICompatibleContextWindow(
  model: string,
  providerQualifier?: string,
): number | undefined {
  return lookupByModel({
    table: OPENAI_CONTEXT_WINDOWS,
    model,
    providerQualifier,
  });
}

export function getOpenAICompatibleMaxOutputTokens(
  model: string,
  providerQualifier?: string,
): number | undefined {
  return lookupByModel({
    table: OPENAI_MAX_OUTPUT_TOKENS,
    model,
    providerQualifier,
  });
}

export function boundedOutputTokens(
  requested: number,
  upperLimit: number,
): number {
  return Math.min(Math.floor(requested), Math.floor(upperLimit));
}
