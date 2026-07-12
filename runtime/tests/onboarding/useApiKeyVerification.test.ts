import { describe, expect, test, vi } from "vitest";

import { defaultConfig } from "../config/schema.js";
import { verifyApiKey } from "./useApiKeyVerification.js";

describe("verifyApiKey", () => {
  test("reports missing and malformed keys before network verification", async () => {
    await expect(
      verifyApiKey({
        provider: "grok",
        apiKey: "",
        config: defaultConfig(),
      }),
    ).resolves.toMatchObject({ status: "missing" });

    await expect(
      verifyApiKey({
        provider: "grok",
        apiKey: "xai key",
        config: defaultConfig(),
      }),
    ).resolves.toMatchObject({ status: "invalid" });
  });

  test("verifies remote provider keys with provider-specific headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      verifyApiKey({
        provider: "grok",
        apiKey: "xai-test-key",
        config: defaultConfig(),
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "valid" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.x.ai/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer xai-test-key" },
      }),
    );
  });

  test("uses x-api-key headers for provider verification", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    await expect(
      verifyApiKey({
        provider: "anthropic",
        apiKey: "anthropic-test-key",
        config: defaultConfig(),
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "valid" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": "anthropic-test-key",
        },
      }),
    );
  });

  test("verifies compatible BYOK keys against the configured endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    await expect(
      verifyApiKey({
        provider: "openai-compatible",
        apiKey: "compatible-test-key",
        config: defaultConfig(),
        env: { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:8000/v1" },
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "valid" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer compatible-test-key" },
      }),
    );
  });

  test("distinguishes rejected keys from provider verification errors", async () => {
    await expect(
      verifyApiKey({
        provider: "grok",
        apiKey: "xai-invalid-key",
        config: defaultConfig(),
        fetchImpl: async () => new Response("unauthorized", { status: 401 }),
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      error: "Provider rejected this API key.",
    });

    await expect(
      verifyApiKey({
        provider: "grok",
        apiKey: "xai-error-key",
        config: defaultConfig(),
        fetchImpl: async () => new Response("server error", { status: 500 }),
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: "Provider verification failed with HTTP 500.",
    });
  });

  test("treats HTTP 400 as a rejected key for providers that reject with 400", async () => {
    // x.ai and Gemini's OpenAI-compat surface return 400 for bad keys
    // (verified live), so 400 must read as "key rejected" there…
    for (const provider of ["grok", "gemini"] as const) {
      await expect(
        verifyApiKey({
          provider,
          apiKey: "wrong-but-well-formed-key",
          config: defaultConfig(),
          fetchImpl: async () => new Response("bad key", { status: 400 }),
        }),
      ).resolves.toMatchObject({
        status: "invalid",
        error: "Provider rejected this API key.",
      });
    }

    // …but stays a generic verification error for providers that use
    // 400 for malformed requests (OpenAI et al reject keys with 401).
    await expect(
      verifyApiKey({
        provider: "openai",
        apiKey: "sk-wrong-key",
        config: defaultConfig(),
        fetchImpl: async () => new Response("bad request", { status: 400 }),
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: "Provider verification failed with HTTP 400.",
    });
  });

  test("verifies OpenRouter keys against the authenticated key endpoint", async () => {
    // OpenRouter's models endpoint is public — it returns 200 for ANY
    // Authorization header (verified live), so verification must hit the
    // key-info endpoint instead of blessing garbage keys.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    );

    await expect(
      verifyApiKey({
        provider: "openrouter",
        apiKey: "sk-or-test-key",
        config: defaultConfig(),
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "valid" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/auth/key",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-or-test-key" },
      }),
    );

    await expect(
      verifyApiKey({
        provider: "openrouter",
        apiKey: "sk-or-wrong-key",
        config: defaultConfig(),
        fetchImpl: async () => new Response("unauthorized", { status: 401 }),
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      error: "Provider rejected this API key.",
    });
  });

  test("gives the one-time check a realistic timeout default", async () => {
    // Live probes measured 0.8–1.6s per provider on a healthy connection;
    // the previous 1.5s default aborted OpenRouter checks on GOOD keys.
    const { DEFAULT_PROVIDER_VERIFY_TIMEOUT_MS } = await import(
      "./useApiKeyVerification.js"
    );
    expect(DEFAULT_PROVIDER_VERIFY_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
