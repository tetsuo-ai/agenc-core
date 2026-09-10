/**
 * A model whose whole context window is smaller than the default output
 * reservation.
 *
 * Every hosted model core catalogues has a window of 128k or more, so the two
 * numbers that decide admission — the output reservation and the conservative
 * token estimate — were only ever exercised where a wide margin hid them. A
 * local runtime has neither. Measured against a real ollama 32k model, the
 * reservation alone was 32,000 against a 31,129-token window and the estimate
 * was 42,214 tokens for a prompt the model's own tokenizer counted at 15,055.
 * Either number alone denies `context_window_exceeded` before the model is
 * called, so no local model could answer at all.
 *
 * These pin both numbers, and pin that nothing catalogued moved.
 */
import { describe, expect, test } from "vitest";

import {
  MAX_OUTPUT_TOKENS_WINDOW_FRACTION,
  fitOutputTokensToContextWindow,
} from "../../src/llm/model-metadata.js";
import { conservativeBytesPerToken } from "../../src/llm/token-accounting.js";

/** The window a real `ollama` 32k model presented to admission. */
const LOCAL_WINDOW = 31_129;
/** The default an uncatalogued model takes from `getModelMaxOutputTokens`. */
const DEFAULT_OUTPUT = 32_000;

describe("an output reservation shares the window with the prompt", () => {
  test("never claims a window it would leave no room in", () => {
    const fitted = fitOutputTokensToContextWindow(DEFAULT_OUTPUT, LOCAL_WINDOW);
    expect(fitted).toBeLessThan(LOCAL_WINDOW);
    expect(fitted).toBe(Math.floor(LOCAL_WINDOW * MAX_OUTPUT_TOKENS_WINDOW_FRACTION));
  });

  test("leaves at least as much room for the prompt as for the answer", () => {
    // The measured prompt was 15,055 tokens. It has to fit beside the
    // reservation or the turn is denied before the model is called.
    const fitted = fitOutputTokensToContextWindow(DEFAULT_OUTPUT, LOCAL_WINDOW);
    expect(LOCAL_WINDOW - fitted).toBeGreaterThanOrEqual(15_055);
  });

  test("leaves every catalogued hosted window untouched", () => {
    // The clamp binds only when the reservation is more than half the window,
    // which for the 32,000 default means windows under 64k. Nothing hosted is
    // anywhere near that, so this must be a no-op for all of them.
    for (const window of [128_000, 200_000, 400_000, 500_000, 1_000_000]) {
      expect(fitOutputTokensToContextWindow(DEFAULT_OUTPUT, window)).toBe(DEFAULT_OUTPUT);
      expect(fitOutputTokensToContextWindow(64_000, window)).toBe(64_000);
    }
  });

  test("holds a reservation that already fits", () => {
    // Exactly half is not too much; only more than half is.
    expect(fitOutputTokensToContextWindow(4_096, 8_192)).toBe(4_096);
  });

  test("passes through when the window is unknown", () => {
    // No window is not a small window. Inventing a clamp from nothing would
    // silently shrink every answer on an endpoint that reports no limit.
    expect(fitOutputTokensToContextWindow(DEFAULT_OUTPUT, undefined)).toBe(DEFAULT_OUTPUT);
    expect(fitOutputTokensToContextWindow(DEFAULT_OUTPUT, 0)).toBe(DEFAULT_OUTPUT);
    expect(fitOutputTokensToContextWindow(DEFAULT_OUTPUT, Number.NaN)).toBe(DEFAULT_OUTPUT);
  });

  test("never returns zero, which downstream reads as unset", () => {
    expect(fitOutputTokensToContextWindow(DEFAULT_OUTPUT, 1)).toBe(1);
  });
});

describe("the conservative token estimate", () => {
  test("prefers the tokenizer core already catalogues for the endpoint", () => {
    // 3.8 is core's own figure for ollama in token-estimation.ts. The
    // accounting path used to ignore it and hardcode 2, which is the whole
    // 2.8x over-estimate: measured, the endpoint runs at 4.99 bytes/token,
    // so 3.8 is still an upper bound and 2 was never a reachable one.
    expect(conservativeBytesPerToken("ollama", "qwen2.5-coder:7b")).toBe(3.8);
    // The model's own family wins over the runtime serving it, which is what
    // we want: `deepseek-r1:7b` on ollama is tokenized as deepseek, not as
    // whatever ollama happens to serve most often.
    expect(conservativeBytesPerToken("ollama", "deepseek-r1:7b")).toBe(3.5);
    // And the runtime answers for a model it has no entry for at all.
    expect(conservativeBytesPerToken("ollama", "some-local-build:7b")).toBe(3.8);
  });

  test("stays an upper bound on what the endpoint really does", () => {
    // The measured prompt: 75,075 bytes, 15,055 real tokens. The estimate has
    // to be at or above the truth, or admission lets through a turn the
    // provider will refuse.
    const estimate = 75_075 / conservativeBytesPerToken("ollama", "qwen2.5-coder:7b");
    expect(estimate).toBeGreaterThanOrEqual(15_055);
  });

  test("brings a 32k window back within reach", () => {
    // The point of the change. At 2 bytes/token the prompt alone was 37,537
    // tokens against a 31,129 window, so no reservation policy could have
    // rescued it.
    const atFloor = 75_075 / 2;
    const catalogued = 75_075 / conservativeBytesPerToken("ollama", "qwen2.5-coder:7b");
    expect(atFloor).toBeGreaterThan(LOCAL_WINDOW);
    expect(catalogued).toBeLessThan(LOCAL_WINDOW);
  });

  test("holds the floor for an endpoint it knows nothing about", () => {
    // An unmatched endpoint tells us nothing, and the catalogue's own default
    // is a guess rather than a bound. 2 stays for those.
    expect(conservativeBytesPerToken("some-unknown-vendor", "mystery-model")).toBe(2);
    expect(conservativeBytesPerToken(undefined, undefined)).toBe(2);
  });

  test("never drops below the floor", () => {
    for (const provider of ["ollama", "grok", "anthropic", "google", "lmstudio", "groq"]) {
      expect(conservativeBytesPerToken(provider, "")).toBeGreaterThanOrEqual(2);
    }
  });
});
