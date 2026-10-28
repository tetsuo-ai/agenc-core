import { describe, expect, test } from "vitest";

import {
  OLLAMA_DEFAULT_CONTEXT_WINDOW_TOKENS,
  ollamaRuntimeContextWindow,
  ollamaTrainedContextLength,
} from "./context-window.js";

describe("ollamaRuntimeContextWindow", () => {
  test("uses the trained length when it is at or below the default", () => {
    expect(ollamaRuntimeContextWindow(8_192)).toBe(8_192);
    expect(ollamaRuntimeContextWindow(OLLAMA_DEFAULT_CONTEXT_WINDOW_TOKENS))
      .toBe(OLLAMA_DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  test("caps a longer trained length so Core admits against the num_ctx it sends", () => {
    // gpt-oss:20b reports 131,072. Sending nothing lets Ollama pick 4,096 and
    // drop the oldest messages while Core still plans against the trained size.
    expect(ollamaRuntimeContextWindow(131_072)).toBe(OLLAMA_DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(ollamaRuntimeContextWindow(262_144)).toBe(OLLAMA_DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  test.each([
    undefined,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ] as const)("refuses a trained length that is not a positive safe integer: %s", (trained) => {
    expect(ollamaRuntimeContextWindow(trained)).toBeUndefined();
  });
});

describe("ollamaTrainedContextLength", () => {
  test("reads an architecture-prefixed context_length and a bare key", () => {
    expect(ollamaTrainedContextLength({
      model_info: { "general.architecture": "qwen2", "qwen2.context_length": 32_768 },
    })).toBe(32_768);
    expect(ollamaTrainedContextLength({ model_info: { context_length: 8_192 } })).toBe(8_192);
  });

  test("skips lookalike keys and an invalid first match, then takes the next", () => {
    expect(ollamaTrainedContextLength({
      model_info: {
        foo_context_length: 99,
        max_context_length: 128,
        context_length_tokens: 256,
        "qwen2.context_length.extra": 512,
        "qwen2.context_length": 0,
        "gptoss.context_length": 131_072,
      },
    })).toBe(131_072);
  });

  test.each([
    null,
    undefined,
    "show",
    [],
    {},
    { model_info: null },
    { model_info: "qwen2.context_length" },
    { model_info: { "qwen2.context_length": "32768" } },
    { model_info: { "qwen2.context_length": 1.5 } },
  ] as const)("returns undefined for an unusable /api/show body: %s", (body) => {
    expect(ollamaTrainedContextLength(body)).toBeUndefined();
  });
});
