import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT,
  getOpenAICompatibleContextWindow,
  getOpenAICompatibleMaxOutputTokens,
  OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW,
} from "./openai-compatible-token-limits.js";

describe("compatible-provider token tables", () => {
  test("resolves known exact context and output limits", () => {
    expect(getOpenAICompatibleContextWindow("gpt-4o")).toBe(128_000);
    expect(getOpenAICompatibleMaxOutputTokens("gpt-4o")).toBe(16_384);
  });

  test("resolves Groq Llama and Mixtral context/output limits", () => {
    expect(getOpenAICompatibleContextWindow("llama-3.3-70b-versatile")).toBe(
      128_000,
    );
    expect(getOpenAICompatibleMaxOutputTokens("llama-3.3-70b-versatile")).toBe(
      32_768,
    );
    expect(getOpenAICompatibleContextWindow("llama-3.1-8b-instant")).toBe(
      128_000,
    );
    expect(getOpenAICompatibleMaxOutputTokens("llama-3.1-8b-instant")).toBe(
      8_192,
    );
    expect(getOpenAICompatibleContextWindow("mixtral-8x7b-32768")).toBe(
      32_768,
    );
    expect(getOpenAICompatibleMaxOutputTokens("mixtral-8x7b-32768")).toBe(
      32_768,
    );
  });

  test("uses longest-prefix matching for dated variants", () => {
    expect(getOpenAICompatibleContextWindow("qwen3-max-2026-01-23")).toBe(
      262_144,
    );
    expect(getOpenAICompatibleMaxOutputTokens("qwen3-max-2026-01-23")).toBe(
      32_768,
    );
    expect(getOpenAICompatibleContextWindow("gpt-4-turbo-preview")).toBe(
      128_000,
    );
    expect(getOpenAICompatibleMaxOutputTokens("gpt-4-turbo-preview")).toBe(
      4_096,
    );
  });

  test("exports compatible-provider fallback defaults", () => {
    expect(OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW).toBe(128_000);
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(32_000);
    expect(DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT).toBe(64_000);
  });
});
