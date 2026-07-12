import { describe, expect, test, vi } from "vitest";

import { LLMProviderError } from "../../errors.js";
import { createProvider } from "../../provider.js";
import type { LLMTool } from "../../types.js";
import { resolveBuiltInProviderInfo } from "../../registry/provider-info.js";
import { GrokProvider } from "./adapter.js";

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

  test("G0: multi-agent strips client function tools; keeps server built-ins", () => {
    const multiAgent = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.20-multi-agent-0309",
      tools: [TEST_TOOL],
      webSearch: true,
      xSearch: true,
    });
    const request = (multiAgent as any).buildRequestPlan([
      { role: "user", content: "research quantum computing" },
    ]);
    const tools = (request.params.tools ?? []) as Record<string, unknown>[];

    // No client function tools (FileRead) on the wire.
    expect(tools.some((t) => t.type === "function")).toBe(false);
    expect(JSON.stringify(tools)).not.toContain("FileRead");

    // Server built-ins still allowed when configured.
    expect(tools).toContainEqual(expect.objectContaining({ type: "web_search" }));
    expect(tools).toContainEqual(expect.objectContaining({ type: "x_search" }));
    expect(request.toolSelection.toolResolution).toBe(
      "multi_agent_server_tools_only",
    );
  });

  test("G0: multi-agent with only client tools yields empty tools array", () => {
    const multiAgent = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.20-multi-agent",
      tools: [TEST_TOOL],
    });
    const request = (multiAgent as any).buildRequestPlan([
      { role: "user", content: "hello" },
    ]);
    const tools = request.params.tools ?? [];
    expect(tools).toEqual([]);
  });

  test("G0: grok-4.5 still attaches client function tools", () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.5",
      tools: [TEST_TOOL],
    });
    const request = (provider as any).buildRequestPlan([
      { role: "user", content: "read a file" },
    ]);
    const tools = (request.params.tools ?? []) as Record<string, unknown>[];
    expect(tools.some((t) => t.type === "function")).toBe(true);
    expect(JSON.stringify(tools)).toContain("FileRead");
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

  test("prewarms the production Grok client and returns a reusable stream handle", async () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4-fast",
    });
    const listModels = vi.fn(async () => []);
    (provider as unknown as { client: unknown }).client = {
      models: { list: listModels },
    };
    const response = {
      content: "ok",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "grok-4-fast",
      finishReason: "stop" as const,
    };
    const chatStream = vi.spyOn(provider, "chatStream").mockResolvedValue(response);

    const handle = await provider.prewarmStartup({
      conversationId: "conv",
      threadId: "conv",
    });
    const streamed = await handle.chatStream(
      [{ role: "user", content: "hello" }],
      vi.fn(),
    );

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(streamed).toBe(response);
  });
});
