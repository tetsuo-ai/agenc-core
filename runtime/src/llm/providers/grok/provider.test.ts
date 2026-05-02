import { describe, expect, test } from "vitest";

import { LLMProviderError } from "../../errors.js";
import { createProvider } from "../../provider.js";
import type { LLMTool } from "../../types.js";
import { resolveBuiltInProviderInfo } from "../../registry/provider-info.js";
import { GrokProvider } from "./index.js";

const TEST_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "FileRead",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
};

const STRUCTURED_OUTPUT = {
  schema: {
    type: "json_schema" as const,
    name: "answer",
    schema: {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
      additionalProperties: false,
    },
  },
};

describe("providers/grok entrypoint", () => {
  test("exports the canonical Grok provider class", () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4-fast",
    });

    expect(provider.name).toBe("grok");
  });

  test("uses registry defaults when constructed directly", () => {
    const registry = resolveBuiltInProviderInfo("grok");
    const provider = new GrokProvider({
      apiKey: "test-key",
    });
    const config = (provider as any).config as {
      model: string;
      baseURL: string;
    };

    expect(config.model).toBe(registry?.defaultModel);
    expect(config.baseURL).toBe(registry?.baseURL);
  });

  test("attaches native web_search only for Grok 4-capable models", () => {
    const grok4 = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4-fast",
      webSearch: true,
    });
    const grok4Request = (grok4 as any).buildRequestPlan([
      { role: "user", content: "look up the latest docs" },
    ]);

    expect(grok4Request.params.tools).toContainEqual(
      expect.objectContaining({ type: "web_search" }),
    );

    const codeFast = new GrokProvider({
      apiKey: "test-key",
      model: "grok-code-fast-1",
      webSearch: true,
    });
    const codeFastRequest = (codeFast as any).buildRequestPlan([
      { role: "user", content: "look up the latest docs" },
    ]);

    expect(JSON.stringify(codeFastRequest.params.tools ?? [])).not.toContain(
      "web_search",
    );
  });

  test("rejects structured outputs with tools outside the Grok 4 family", () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-code-fast-1",
      tools: [TEST_TOOL],
    });

    expect(() =>
      (provider as any).buildRequestPlan(
        [{ role: "user", content: "answer with JSON" }],
        { structuredOutput: STRUCTURED_OUTPUT },
      ),
    ).toThrow(LLMProviderError);
  });

  test("routes grok-code-fast through the default provider factory", () => {
    const provider = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-code-fast-1",
      extra: { webSearch: true },
    });
    const request = (provider as any).buildRequestPlan([
      { role: "user", content: "inspect this code" },
    ]);

    expect(request.params.model).toBe("grok-code-fast-1");
    expect(JSON.stringify(request.params.tools ?? [])).not.toContain(
      "web_search",
    );
  });
});
