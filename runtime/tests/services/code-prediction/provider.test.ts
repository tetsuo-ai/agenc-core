import { describe, expect, it } from "vitest";

import {
  createProvider,
  readProviderFactoryOptions,
} from "../../../src/llm/provider.js";
import { createOwnedCodePredictionProvider } from "../../../src/services/code-prediction/provider.js";

describe("code prediction provider ownership", () => {
  it("clones the active route into a separate tool-free provider", async () => {
    const primary = createProvider("openai-compatible", {
      baseURL: "http://127.0.0.1:8765/v1",
      model: "primary-model",
      tools: [
        {
          type: "function",
          function: {
            name: "dangerous_tool",
            description: "must not cross into prediction",
            parameters: { type: "object" },
          },
        },
      ],
      timeoutMs: 90_000,
      extra: {
        maxRetries: 4,
        temperature: 0.8,
      },
    });

    const prediction = await createOwnedCodePredictionProvider({
      source: {
        provider: primary,
        workspaceRoot: "/workspace",
      },
      timeoutMs: 2_500,
      maxOutputTokens: 128,
    });

    expect(prediction.provider).not.toBe(primary);
    expect(prediction.providerName).toBe("openai-compatible");
    expect(prediction.model).toBe("primary-model");
    expect(readProviderFactoryOptions(prediction.provider)).toMatchObject({
      baseURL: "http://127.0.0.1:8765/v1",
      model: "primary-model",
      timeoutMs: 2_500,
      extra: {
        maxTokens: 128,
        maxRetries: 0,
        temperature: 0,
      },
    });
    expect(
      (
        prediction.provider as unknown as {
          readonly config: { readonly tools?: readonly unknown[] };
        }
      ).config.tools,
    ).toEqual([]);
    await prediction.dispose();
    await primary.dispose?.();
  });

  it("never carries a model identifier across a provider override", async () => {
    const primary = createProvider("openai-compatible", {
      baseURL: "http://127.0.0.1:8765/v1",
      model: "source-provider-only-model",
    });

    const prediction = await createOwnedCodePredictionProvider({
      source: {
        provider: primary,
        workspaceRoot: "/workspace",
      },
      provider: "ollama",
      timeoutMs: 2_500,
      maxOutputTokens: 128,
    });

    expect(prediction.providerName).toBe("ollama");
    expect(prediction.model).not.toBe("source-provider-only-model");
    expect(readProviderFactoryOptions(prediction.provider).model).not.toBe(
      "source-provider-only-model",
    );
    await prediction.dispose();
    await primary.dispose?.();
  });
});
