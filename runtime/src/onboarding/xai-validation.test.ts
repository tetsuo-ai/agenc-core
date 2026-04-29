import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GROK_MODEL } from "../gateway/llm-provider-manager.js";
import { validateXaiApiKey } from "./xai-validation.js";

describe("xAI onboarding validation", () => {
  it("normalizes known Grok models from the xAI models response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "grok-4-fast-reasoning" }, { id: "unknown-model" }],
      }),
    })) as unknown as typeof fetch;

    const result = await validateXaiApiKey({
      apiKey: "xai-test-key",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.availableModels).toContain("grok-4-1-fast-reasoning");
    expect(result.availableModels).not.toContain("unknown-model");
  });

  it("falls back to the default model when no known chat models are returned", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "unknown-model" }],
      }),
    })) as unknown as typeof fetch;

    const result = await validateXaiApiKey({
      apiKey: "xai-test-key",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.availableModels).toEqual([DEFAULT_GROK_MODEL]);
  });

  it("returns a clear auth error when xAI rejects the API key", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
    })) as unknown as typeof fetch;

    const result = await validateXaiApiKey({
      apiKey: "bad-key",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("rejected");
  });
});
