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
import { OpenAIProvider } from "./providers/openai/index.js";
import { AnthropicProvider } from "./providers/anthropic/index.js";
import {
  createProvider,
  isFactoryProvider,
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
    expect(isFactoryProvider(provider)).toBe(true);
  });

  test("routes 'openai' to OpenAIProvider", () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const provider = createProvider("openai", {
        model: "gpt-5.4",
      });
      expect(provider).toBeInstanceOf(OpenAIProvider);
      expect(isFactoryProvider(provider)).toBe(true);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  test("routes 'anthropic' to AnthropicProvider", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-test";
    try {
      const provider = createProvider("anthropic", {
        model: "claude-sonnet-4.5",
      });
      expect(provider).toBeInstanceOf(AnthropicProvider);
      expect(isFactoryProvider(provider)).toBe(true);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("'grok' without apiKey throws explanatory error", () => {
    const prevXai = process.env.XAI_API_KEY;
    const prevGrok = process.env.GROK_API_KEY;
    const prevAgenc = process.env.AGENC_XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.AGENC_XAI_API_KEY;
    try {
      expect(() =>
        createProvider("grok", { model: "grok-4-fast" }),
      ).toThrow(/XAI_API_KEY|apiKey/i);
    } finally {
      if (prevXai !== undefined) process.env.XAI_API_KEY = prevXai;
      if (prevGrok !== undefined) process.env.GROK_API_KEY = prevGrok;
      if (prevAgenc !== undefined) process.env.AGENC_XAI_API_KEY = prevAgenc;
    }
  });

  test("'grok' without model throws explanatory error", () => {
    expect(() =>
      createProvider("grok", { apiKey: "test-key" }),
    ).toThrow(/AGENC_MODEL|model/i);
  });

  test.each([
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
