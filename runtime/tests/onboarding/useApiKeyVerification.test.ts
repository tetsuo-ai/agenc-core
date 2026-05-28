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
});
