import {
  OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW,
  getOpenAICompatibleContextWindow,
} from "../../../llm/openai-compatible-token-limits.js";

/**
 * Model-string → context-window lookup, used as a last-resort fallback
 * when neither the live `CompactContext.options.contextWindowTokens`
 * nor the `AGENC_AUTO_COMPACT_WINDOW` env override is available.
 *
 * Three layers:
 *   1. Family-literal shortcuts for haiku/sonnet/opus (→ 200k) — kept
 *      for backward compatibility with callers that pass a known
 *      family id directly.
 *   2. The shared {@link getOpenAICompatibleContextWindow} table —
 *      covers qwen, llama, gemma, mistral, deepseek, gpt-*, gemini,
 *      glm, kimi, etc. with explicit per-model windows.
 *   3. {@link OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW} (128k) for
 *      truly unknown models. The previous fallback (32k) was a stale
 *      haiku-era default that quietly shrank the window of every
 *      provider whose model id didn't match haiku/sonnet/opus; 128k
 *      matches the openai-compat table's documented unknown-model
 *      assumption.
 */
export function lookupContextWindowForModel(model: string | undefined): number {
  if (model === undefined || model.trim().length === 0) {
    return OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW;
  }
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return 200_000;
  if (normalized.includes("sonnet")) return 200_000;
  if (normalized.includes("opus")) return 200_000;
  const tableHit = getOpenAICompatibleContextWindow(model);
  if (tableHit !== undefined) return tableHit;
  return OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW;
}

export function positiveInteger(value: string | undefined): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

export function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
