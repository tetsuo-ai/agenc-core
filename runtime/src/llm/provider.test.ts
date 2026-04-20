/**
 * Tests for the provider factory (T10 Fix-E integration point 4).
 *
 * The factory is the single entrypoint for provider construction so
 * T13's multi-provider work slots in without touching `bin/agenc.ts`
 * or other call sites. Today only Grok is wired; every other
 * `ProviderName` throws `ProviderNotImplementedError`.
 */

import { describe, expect, test } from "vitest";
import { GrokProvider } from "./grok/index.js";
import {
  createProvider,
  ProviderNotImplementedError,
  resolveProviderNameFromEnv,
} from "./provider.js";

describe("createProvider", () => {
  test("routes 'grok' to GrokProvider", () => {
    const provider = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-4-fast",
    });
    expect(provider).toBeInstanceOf(GrokProvider);
  });

  test("'grok' without apiKey throws explanatory error", () => {
    expect(() =>
      createProvider("grok", { model: "grok-4-fast" }),
    ).toThrow(/XAI_API_KEY|apiKey/i);
  });

  test("'grok' without model throws explanatory error", () => {
    expect(() =>
      createProvider("grok", { apiKey: "test-key" }),
    ).toThrow(/AGENC_MODEL|model/i);
  });

  test.each([
    "openai",
    "anthropic",
    "ollama",
    "lmstudio",
    "openrouter",
    "groq",
    "deepseek",
    "gemini",
  ] as const)(
    "'%s' throws ProviderNotImplementedError (T13 gap)",
    (name) => {
      expect(() =>
        createProvider(name, { apiKey: "x", model: "y" }),
      ).toThrow(ProviderNotImplementedError);
    },
  );

  test("unknown provider string bypassing the type system throws", () => {
    expect(() =>
      // Runtime-only test: simulate a stringly-typed caller that
      // the TS compiler would normally catch.
      createProvider("bogus" as unknown as "grok", {
        apiKey: "x",
        model: "y",
      }),
    ).toThrow(/unknown provider/i);
  });
});

describe("resolveProviderNameFromEnv", () => {
  test("defaults to 'grok' when AGENC_PROVIDER unset", () => {
    const prev = process.env.AGENC_PROVIDER;
    delete process.env.AGENC_PROVIDER;
    try {
      expect(resolveProviderNameFromEnv()).toBe("grok");
    } finally {
      if (prev !== undefined) process.env.AGENC_PROVIDER = prev;
    }
  });

  test("lowercases and trims AGENC_PROVIDER", () => {
    const prev = process.env.AGENC_PROVIDER;
    process.env.AGENC_PROVIDER = "  OpenAI  ";
    try {
      expect(resolveProviderNameFromEnv()).toBe("openai");
    } finally {
      if (prev !== undefined) process.env.AGENC_PROVIDER = prev;
      else delete process.env.AGENC_PROVIDER;
    }
  });

  test("rejects unknown provider names", () => {
    const prev = process.env.AGENC_PROVIDER;
    process.env.AGENC_PROVIDER = "bogus";
    try {
      expect(() => resolveProviderNameFromEnv()).toThrow(
        /not a known provider/i,
      );
    } finally {
      if (prev !== undefined) process.env.AGENC_PROVIDER = prev;
      else delete process.env.AGENC_PROVIDER;
    }
  });
});
