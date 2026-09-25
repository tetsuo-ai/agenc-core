import { describe, expect, test, vi } from "vitest";

import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";
import {
  assertOllamaToolChoiceResponse,
  resolveOllamaToolChoice,
} from "../../../../src/llm/providers/ollama/tool-choice.js";
import { createOllamaToolNameProjection } from "../../../../src/llm/providers/ollama/tool-naming.js";
import { LLMInvalidResponseError, LLMProviderError } from "../../../../src/llm/errors.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProviderTraceEvent,
  LLMTool,
} from "../../../../src/llm/types.js";

const echo: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo text",
    parameters: { type: "object", properties: { text: { type: "string" } } },
  },
};
const search: LLMTool = {
  type: "function",
  function: {
    name: "system.search",
    description: "Search",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  },
};
const catalog = [echo, search];

function setClient(
  provider: OllamaProvider,
  client: { readonly chat?: unknown; readonly list?: unknown; readonly show?: unknown },
): void {
  (provider as unknown as { client: unknown }).client = client;
}

function providerWithTools(): OllamaProvider {
  return new OllamaProvider({
    model: "llama3.3",
    tools: catalog,
  });
}

async function* streamChunks(chunks: readonly unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function textResponse(content = "ok") {
  return {
    model: "llama3.3",
    message: { role: "assistant", content },
    prompt_eval_count: 4,
    eval_count: 2,
  };
}

function toolCallResponse(name: string, args: Record<string, unknown> = { text: "hi" }) {
  return {
    model: "llama3.3",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name, arguments: args } }],
    },
    prompt_eval_count: 4,
    eval_count: 2,
  };
}

async function invoke(
  provider: OllamaProvider,
  streaming: boolean,
  options: LLMChatOptions,
  response: unknown,
): Promise<{
  readonly result: Awaited<ReturnType<OllamaProvider["chat"]>> | undefined;
  readonly error: unknown;
  readonly requests: Record<string, unknown>[];
  readonly traces: LLMProviderTraceEvent[];
}> {
  const requests: Record<string, unknown>[] = [];
  const traces: LLMProviderTraceEvent[] = [];
  const chat = vi.fn(async (request: Record<string, unknown>) => {
    requests.push(request);
    return request.stream ? streamChunks([response]) : response;
  });
  setClient(provider, { chat, list: vi.fn().mockResolvedValue({ models: [] }) });
  const messages: LLMMessage[] = [{ role: "user", content: "hello" }];
  const callOptions: LLMChatOptions = {
    ...options,
    trace: { onProviderTraceEvent: (event) => traces.push(event) },
  };
  try {
    const result = streaming
      ? await provider.chatStream(messages, () => {}, callOptions)
      : await provider.chat(messages, callOptions);
    return { result, error: undefined, requests, traces };
  } catch (error) {
    return { result: undefined, error, requests, traces };
  }
}

describe("resolveOllamaToolChoice", () => {
  const names = createOllamaToolNameProjection(catalog);

  test("auto keeps the selected catalog", () => {
    for (const toolChoice of [undefined, "auto"] as const) {
      const resolution = resolveOllamaToolChoice(toolChoice, names);
      expect(resolution).toMatchObject({
        requested: "auto",
        effective: "auto",
      });
      expect(resolution.advertisedWireTools.map((tool) => tool.function.name)).toEqual([
        "system.echo",
        "system.search",
      ]);
    }
  });

  test("none omits the advertised catalog", () => {
    const resolution = resolveOllamaToolChoice("none", names);
    expect(resolution).toMatchObject({
      requested: "none",
      effective: "none",
      toolSuppressionReason: "tool_choice_none",
    });
    expect(resolution.advertisedWireTools).toEqual([]);
    expect(resolution.advertisedNames.salvageTools).toEqual([]);
  });

  test("required keeps the full catalog and is effective auto", () => {
    const resolution = resolveOllamaToolChoice("required", names);
    expect(resolution).toMatchObject({
      requested: "required",
      effective: "auto",
    });
    expect(resolution.advertisedWireTools.map((tool) => tool.function.name)).toEqual([
      "system.echo",
      "system.search",
    ]);
  });

  test("a specific function advertises only that tool", () => {
    const resolution = resolveOllamaToolChoice(
      { type: "function", name: "system.search" },
      names,
    );
    expect(resolution).toMatchObject({
      requested: "function:system.search",
      effective: "function:system.search",
    });
    expect(resolution.advertisedWireTools.map((tool) => tool.function.name)).toEqual([
      "system.search",
    ]);
  });

  test("rejects a specific function that is not in the catalog", () => {
    expect(() =>
      resolveOllamaToolChoice({ type: "function", name: "missing" }, names),
    ).toThrow(/toolChoice references unavailable tool: missing/u);
  });
});

describe("assertOllamaToolChoiceResponse", () => {
  const names = createOllamaToolNameProjection(catalog);

  test("none rejects any tool-call response", () => {
    const resolution = resolveOllamaToolChoice("none", names);
    expect(() =>
      assertOllamaToolChoiceResponse(resolution, [
        { id: "1", name: "system.echo", arguments: "{}" },
      ]),
    ).toThrow(LLMInvalidResponseError);
  });

  test("a specific function requires that tool in the response", () => {
    const resolution = resolveOllamaToolChoice(
      { type: "function", name: "system.echo" },
      names,
    );
    expect(() => assertOllamaToolChoiceResponse(resolution, [])).toThrow(
      /toolChoice required function system\.echo/u,
    );
    expect(() =>
      assertOllamaToolChoiceResponse(resolution, [
        { id: "1", name: "system.echo", arguments: "{}" },
      ]),
    ).not.toThrow();
  });
});

describe("Ollama adapter toolChoice", () => {
  test.each([false, true])(
    "none omits tools and records requested/effective choice (stream=%s)",
    async (streaming) => {
      const { result, error, requests, traces } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: "none" },
        textResponse("plain text"),
      );

      expect(error).toBeUndefined();
      expect(result?.content).toBe("plain text");
      expect(result?.toolCalls).toEqual([]);
      expect(requests[0]).not.toHaveProperty("tools");
      expect(result?.requestMetrics).toMatchObject({
        toolChoice: "none",
        toolsAttached: false,
        toolSuppressionReason: "tool_choice_none",
      });
      expect(traces.find((event) => event.kind === "request")?.context).toMatchObject({
        requestedToolChoice: "none",
        effectiveToolChoice: "none",
        toolSuppressionReason: "tool_choice_none",
      });
    },
  );

  test.each([false, true])(
    "none does not salvage text that looks like a tool call (stream=%s)",
    async (streaming) => {
      const fakeCall = JSON.stringify({
        name: "system.echo",
        arguments: { text: "hi" },
      });
      const { result, error, requests } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: "none" },
        textResponse(fakeCall),
      );

      expect(error).toBeUndefined();
      expect(requests[0]).not.toHaveProperty("tools");
      expect(result?.toolCalls).toEqual([]);
      expect(result?.content).toBe(fakeCall);
    },
  );

  test.each([false, true])(
    "none rejects a native tool-call response (stream=%s)",
    async (streaming) => {
      const { result, error, requests } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: "none" },
        toolCallResponse("system.echo"),
      );

      expect(result).toBeUndefined();
      expect(requests[0]).not.toHaveProperty("tools");
      expect(error).toBeInstanceOf(LLMInvalidResponseError);
      expect(error).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/toolChoice=none forbids tool calls/u),
        }),
      );
    },
  );

  test.each([false, true])(
    "auto retains the current selected catalog (stream=%s)",
    async (streaming) => {
      const { result, error, requests, traces } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: "auto" },
        textResponse("ok"),
      );

      expect(error).toBeUndefined();
      expect(result?.content).toBe("ok");
      expect(requests[0]?.tools).toEqual(
        catalog.map((tool) => ({
          type: "function",
          function: tool.function,
        })),
      );
      expect(result?.requestMetrics).toMatchObject({
        toolChoice: "auto",
        toolsAttached: true,
      });
      expect(traces.find((event) => event.kind === "request")?.context).toMatchObject({
        requestedToolChoice: "auto",
        effectiveToolChoice: "auto",
      });
    },
  );

  test.each([false, true])(
    "undefined toolChoice keeps auto catalog behavior (stream=%s)",
    async (streaming) => {
      const { result, error, requests } = await invoke(
        providerWithTools(),
        streaming,
        {},
        textResponse("ok"),
      );

      expect(error).toBeUndefined();
      expect(result?.content).toBe("ok");
      expect(requests[0]?.tools).toHaveLength(2);
    },
  );

  test.each([false, true])(
    "plan-mode required toolChoice sends the full catalog as auto (stream=%s)",
    async (streaming) => {
      const { result, error, requests, traces } = await invoke(
        providerWithTools(),
        streaming,
        // Plan mode sets toolChoice: "required" when tools are available.
        { toolChoice: "required" },
        textResponse("planning"),
      );

      expect(error).toBeUndefined();
      expect(result?.content).toBe("planning");
      expect(requests[0]?.tools).toHaveLength(2);
      expect(requests[0]).not.toHaveProperty("tool_choice");
      expect(result?.requestMetrics).toMatchObject({ toolChoice: "auto" });
      expect(traces.find((event) => event.kind === "request")?.context).toMatchObject({
        requestedToolChoice: "required",
        effectiveToolChoice: "auto",
      });
    },
  );

  test.each([false, true])(
    "a truncated named choice recovers instead of failing the check (stream=%s)",
    async (streaming) => {
      const truncated = {
        ...toolCallResponse("system.echo"),
        done: true,
        done_reason: "length",
        message: {
          role: "assistant",
          content: "partial",
          tool_calls: [{ function: { name: "system.echo", arguments: { text: "hi" } } }],
        },
      };
      const { result, error } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: { type: "function", name: "system.echo" } },
        truncated,
      );

      expect(error).toBeUndefined();
      expect(result?.finishReason).toBe("length");
      expect(result?.toolCalls).toEqual([]);
      expect(result?.content).toBe("partial");
    },
  );

  test.each([false, true])(
    "an unknown done_reason under a named choice keeps the finish error (stream=%s)",
    async (streaming) => {
      const { result, error } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: { type: "function", name: "system.echo" } },
        {
          ...toolCallResponse("system.echo"),
          done: true,
          done_reason: "mystery",
        },
      );

      expect(error).toBeUndefined();
      expect(result?.finishReason).toBe("error");
      expect(result?.toolCalls).toEqual([]);
      expect(result?.error).toEqual(expect.objectContaining({
        message: expect.stringContaining("Unknown Ollama done_reason"),
      }));
    },
  );

  test.each([false, true])(
    "an unknown done_reason under none keeps the finish error (stream=%s)",
    async (streaming) => {
      const { result, error } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: "none" },
        {
          ...toolCallResponse("system.echo"),
          done: true,
          done_reason: "mystery",
        },
      );

      expect(error).toBeUndefined();
      expect(result?.finishReason).toBe("error");
      expect(result?.toolCalls).toEqual([]);
    },
  );

  test.each([false, true])(
    "a specific function ships only that tool and accepts its call (stream=%s)",
    async (streaming) => {
      const { result, error, requests, traces } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: { type: "function", name: "system.search" } },
        toolCallResponse("system.search", { query: "docs" }),
      );

      expect(error).toBeUndefined();
      expect(result?.toolCalls).toEqual([
        {
          id: expect.any(String),
          name: "system.search",
          arguments: '{"query":"docs"}',
        },
      ]);
      expect(requests[0]?.tools).toEqual([
        {
          type: "function",
          function: search.function,
        },
      ]);
      expect(result?.requestMetrics).toMatchObject({
        toolChoice: "function:system.search",
        toolCount: 1,
        toolNames: ["system.search"],
      });
      expect(traces.find((event) => event.kind === "request")?.context).toMatchObject({
        requestedToolChoice: "function:system.search",
        effectiveToolChoice: "function:system.search",
      });
    },
  );

  test.each([false, true])(
    "a specific function rejects a text-only response (stream=%s)",
    async (streaming) => {
      const { result, error, requests } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: { type: "function", name: "system.echo" } },
        textResponse("I will not call a tool"),
      );

      expect(result).toBeUndefined();
      expect(requests[0]?.tools).toHaveLength(1);
      expect(error).toBeInstanceOf(LLMInvalidResponseError);
      expect(error).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/toolChoice required function system\.echo/u),
        }),
      );
    },
  );

  test.each([false, true])(
    "a specific function rejects a call to a different catalog tool (stream=%s)",
    async (streaming) => {
      const { result, error, requests } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: { type: "function", name: "system.echo" } },
        toolCallResponse("system.search", { query: "nope" }),
      );

      expect(result).toBeUndefined();
      expect(requests[0]?.tools).toEqual([
        {
          type: "function",
          function: echo.function,
        },
      ]);
      expect(error).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/outside the advertised request catalog/u),
        }),
      );
    },
  );

  test.each([false, true])(
    "a specific function missing from the catalog fails locally (stream=%s)",
    async (streaming) => {
      const { result, error, requests } = await invoke(
        providerWithTools(),
        streaming,
        { toolChoice: { type: "function", name: "missing" } },
        textResponse("should not run"),
      );

      expect(result).toBeUndefined();
      expect(requests).toEqual([]);
      expect(error).toBeInstanceOf(LLMProviderError);
      expect(error).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/toolChoice references unavailable tool: missing/u),
        }),
      );
    },
  );

  test("none omits the text-tool protocol catalog", async () => {
    const provider = providerWithTools();
    const requests: Record<string, unknown>[] = [];
    setClient(provider, {
      show: vi.fn(async () => ({ capabilities: ["completion", "thinking"] })),
      chat: vi.fn(async (request: Record<string, unknown>) => {
        requests.push(request);
        return textResponse("ok");
      }),
      list: vi.fn().mockResolvedValue({ models: [] }),
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { toolChoice: "none" },
    );

    expect(response.content).toBe("ok");
    expect(requests[0]).not.toHaveProperty("tools");
    const systemContent = String(
      (requests[0]?.messages as Array<Record<string, unknown>> | undefined)?.[0]
        ?.content ?? "",
    );
    expect(systemContent).not.toContain("system.echo");
    expect(systemContent).not.toContain("Tool calling protocol");
    expect(response.requestMetrics).toMatchObject({
      toolChoice: "none",
      toolSuppressionReason: "tool_choice_none",
    });
  });
});
