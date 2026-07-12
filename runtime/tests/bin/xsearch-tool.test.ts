/**
 * G1: LIVE XSearch Pattern A — gates + one-shot native path wiring.
 * Drives shipped createModelFacingTools / supportsProviderNativeXSearch.
 */
import { describe, expect, it, vi } from "vitest";

import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import { supportsProviderNativeXSearch } from "../../src/llm/provider-native-search.js";
import type { LLMProvider } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

function findTool(
  tools: readonly { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }[],
  name: string,
) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("supportsProviderNativeXSearch", () => {
  it("requires grok + xSearch true + grok-4 model", () => {
    expect(
      supportsProviderNativeXSearch({
        provider: "grok",
        model: "grok-4.5",
        xSearch: true,
      }),
    ).toBe(true);
    expect(
      supportsProviderNativeXSearch({
        provider: "grok",
        model: "grok-4.5",
        xSearch: false,
      }),
    ).toBe(false);
    expect(
      supportsProviderNativeXSearch({
        provider: "openai",
        model: "grok-4.5",
        xSearch: true,
      }),
    ).toBe(false);
    expect(
      supportsProviderNativeXSearch({
        provider: "grok",
        model: "grok-code-fast-1",
        xSearch: true,
      }),
    ).toBe(false);
  });
});

describe("LIVE XSearch tool", () => {
  it("is registered in the model-facing catalog", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
    });
    expect(tools.some((t) => t.name === "XSearch")).toBe(true);
  });

  it("hard-refuses when session provider is not grok", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () =>
        ({
          services: {
            provider: { name: "openai" } as LLMProvider,
          },
        }) as unknown as Session,
      llmXai: { x_search: true },
    });
    const xsearch = findTool(tools as never, "XSearch");
    const result = (await xsearch.execute({ query: "xai" })) as {
      content: string;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/only available when the session provider is grok/i);
  });

  it("refuses when x_search is disabled (default off)", async () => {
    const provider = {
      name: "grok",
    } as LLMProvider;
    // mark as factory-backed so identity + factory options resolve
    const { createProvider } = await import("../../src/llm/provider.js");
    const real = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-4.5",
      tools: [],
    });
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () =>
        ({
          services: { provider: real },
        }) as unknown as Session,
      llmXai: { x_search: false },
    });
    const xsearch = findTool(tools as never, "XSearch");
    const result = (await xsearch.execute({ query: "xai" })) as {
      content: string;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/x_search = true/i);
    void provider;
  });

  it("one-shots native x_search when enabled (mocked provider factory)", async () => {
    const chat = vi.fn(async () => ({
      content: "People are talking about xAI.[[1]](https://x.com/xai/status/1)",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "grok-4.5",
      finishReason: "stop" as const,
      providerEvidence: {
        citations: ["https://x.com/xai/status/1"],
        serverSideToolCalls: [
          { type: "x_search_call", toolType: "x_search", id: "c1" },
        ],
        serverSideToolUsage: [{ toolType: "x_search", count: 1 }],
      },
    }));

    const { createProvider } = await import("../../src/llm/provider.js");
    const sessionProvider = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-4.5",
      tools: [],
      extra: { xSearch: true },
    });

    const factory = vi.fn((...args: Parameters<typeof createProvider>) => {
      const p = createProvider(...args);
      return Object.assign(p, { chat }) as typeof p;
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () =>
        ({
          services: { provider: sessionProvider },
        }) as unknown as Session,
      llmXai: { x_search: true },
      providerFactory: factory as typeof createProvider,
    });
    const xsearch = findTool(tools as never, "XSearch");
    const result = (await xsearch.execute({ query: "xAI updates" })) as {
      content: string;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/grok_x_search/);
    expect(result.content).toMatch(/x\.com\/xai\/status\/1/);
    expect(factory).toHaveBeenCalled();
    const factoryExtra = factory.mock.calls[0]?.[1]?.extra as
      | { xSearch?: boolean; webSearch?: boolean }
      | undefined;
    expect(factoryExtra?.xSearch).toBe(true);
    expect(factoryExtra?.webSearch).toBe(false);
    expect(chat).toHaveBeenCalled();
  });
});
