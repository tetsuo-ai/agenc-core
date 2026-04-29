import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMMessage } from "../types.js";
import {
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";

// Mock the ollama module
const mockChat = vi.fn();
const mockList = vi.fn();

vi.mock("ollama", () => {
  return {
    Ollama: class MockOllama {
      chat = mockChat;
      list = mockList;
      constructor(_opts: any) {}
    },
  };
});

import { OllamaProvider } from "./adapter.js";

function makeResponse(overrides: Record<string, any> = {}) {
  return {
    message: { content: "Hello!", role: "assistant", tool_calls: [] },
    model: "llama3",
    prompt_eval_count: 10,
    eval_count: 5,
    ...overrides,
  };
}

describe("OllamaProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends messages in correct format", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({});
    const messages: LLMMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const response = await provider.chat(messages);

    expect(mockChat).toHaveBeenCalledOnce();
    const params = mockChat.mock.calls[0][0];
    expect(params.model).toBe("llama3");
    expect(params.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ]);
    expect(response.content).toBe("Hello!");
  });

  it("maps tool result messages with tool_call_id", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({});
    await provider.chat([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "desktop.bash",
            arguments: '{"command":"echo hi"}',
          },
        ],
      },
      {
        role: "tool",
        content: '{"stdout":"hi\\n","exitCode":0}',
        toolCallId: "call_1",
        toolName: "desktop.bash",
      },
    ]);

    const params = mockChat.mock.calls[0][0];
    expect(params.messages[2]).toEqual({
      role: "tool",
      content: '{"stdout":"hi\\n","exitCode":0}',
      tool_call_id: "call_1",
    });
  });

  it("passes options for temperature and context", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({
      temperature: 0.7,
      numCtx: 8192,
      numGpu: 1,
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockChat.mock.calls[0][0];
    expect(params.options).toEqual({
      temperature: 0.7,
      num_ctx: 8192,
      num_gpu: 1,
    });
  });

  it("uses custom model", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({ model: "mistral" });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockChat.mock.calls[0][0];
    expect(params.model).toBe("mistral");
  });

  it("reports execution profile from explicit num_ctx configuration", async () => {
    const provider = new OllamaProvider({
      model: "qwen2.5-coder",
      numCtx: 32_768,
      maxTokens: 2_048,
    });

    await expect(provider.getExecutionProfile?.()).resolves.toEqual({
      provider: "ollama",
      model: "qwen2.5-coder",
      contextWindowTokens: 32_768,
      contextWindowSource: "ollama_request_num_ctx",
      maxOutputTokens: 2_048,
    });
  });

  it("parses tool calls", async () => {
    const response = makeResponse({
      message: {
        content: "",
        role: "assistant",
        tool_calls: [
          { function: { name: "search", arguments: { q: "test" } } },
        ],
      },
    });
    mockChat.mockResolvedValueOnce(response);

    const provider = new OllamaProvider({});
    const result = await provider.chat([{ role: "user", content: "test" }]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("search");
    expect(result.toolCalls[0].arguments).toBe('{"q":"test"}');
    expect(result.finishReason).toBe("tool_calls");
  });

  it("assigns unique IDs to duplicate-named tool calls (non-streaming)", async () => {
    const response = makeResponse({
      message: {
        content: "",
        role: "assistant",
        tool_calls: [
          { function: { name: "search", arguments: { q: "first" } } },
          { function: { name: "search", arguments: { q: "second" } } },
        ],
      },
    });
    mockChat.mockResolvedValueOnce(response);

    const provider = new OllamaProvider({});
    const result = await provider.chat([{ role: "user", content: "test" }]);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("search");
    expect(result.toolCalls[1].name).toBe("search");
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
    expect(result.toolCalls[0].id).not.toBe("search");
    expect(result.toolCalls[1].id).not.toBe("search");
  });

  it("assigns unique IDs to duplicate-named tool calls (streaming)", async () => {
    const chunks = [
      {
        message: {
          content: "",
          role: "assistant",
          tool_calls: [
            { function: { name: "search", arguments: { q: "first" } } },
            { function: { name: "search", arguments: { q: "second" } } },
          ],
        },
        model: "llama3",
        prompt_eval_count: 5,
        eval_count: 10,
      },
    ];
    mockChat.mockResolvedValueOnce(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const provider = new OllamaProvider({});
    const result = await provider.chatStream(
      [{ role: "user", content: "test" }],
      () => undefined,
    );

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("search");
    expect(result.toolCalls[1].name).toBe("search");
    expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
    expect(result.toolCalls[0].id).not.toBe("search");
    expect(result.toolCalls[1].id).not.toBe("search");
  });

  it("handles streaming via async iterable", async () => {
    const chunks = [
      { message: { content: "Hello" }, model: "llama3" },
      {
        message: { content: " world" },
        model: "llama3",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ];
    mockChat.mockResolvedValueOnce(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const provider = new OllamaProvider({});
    const onChunk = vi.fn();
    const result = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(result.content).toBe("Hello world");
    expect(onChunk).toHaveBeenCalledWith({ content: "Hello", done: false });
    expect(onChunk).toHaveBeenCalledWith({ content: " world", done: false });
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("returns usage information", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({});
    const result = await provider.chat([{ role: "user", content: "test" }]);

    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("records request metrics for routed Ollama tools", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up info",
            parameters: { type: "object" },
          },
        },
      ],
    });

    const result = await provider.chat(
      [{ role: "user", content: "test" }],
      {
        toolRouting: { allowedToolNames: ["lookup"] },
      },
    );

    expect(result.requestMetrics).toMatchObject({
      toolCount: 1,
      toolNames: ["lookup"],
      requestedToolNames: ["lookup"],
      missingRequestedToolNames: [],
      toolResolution: "subset_exact",
      stream: undefined,
    });
  });

  it("treats an empty routed allowlist as no attached tools", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up info",
            parameters: { type: "object" },
          },
        },
      ],
    });

    const result = await provider.chat(
      [{ role: "user", content: "test" }],
      {
        toolRouting: { allowedToolNames: [] },
      },
    );

    expect(result.requestMetrics).toMatchObject({
      toolCount: 0,
      toolNames: [],
      requestedToolNames: [],
      missingRequestedToolNames: [],
      toolResolution: "all_tools_empty_filter",
      toolsAttached: false,
      stream: undefined,
    });
  });

  it("emits provider request and response trace events when enabled", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const events: Array<Record<string, unknown>> = [];
    const provider = new OllamaProvider({
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up info",
            parameters: { type: "object" },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "test" }],
      {
        toolRouting: { allowedToolNames: ["lookup"] },
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "request",
      transport: "chat",
      provider: "ollama",
      context: {
        requestedToolNames: ["lookup"],
        resolvedToolNames: ["lookup"],
        missingRequestedToolNames: [],
        toolResolution: "subset_exact",
        providerCatalogToolCount: 1,
      },
      payload: {
        model: "llama3",
      },
    });
    expect(events[1]).toMatchObject({
      kind: "response",
      transport: "chat",
      provider: "ollama",
      payload: {
        model: "llama3",
      },
    });
    expect((events[1].payload as { message?: { content?: string } }).message?.content).toBe(
      "Hello!",
    );
  });

  it("suppresses tools when routed Ollama allowlist resolves to zero matches (fail-closed)", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up info",
            parameters: { type: "object" },
          },
        },
      ],
    });

    const result = await provider.chat(
      [{ role: "user", content: "test" }],
      {
        toolRouting: { allowedToolNames: ["mcp.example.start"] },
      },
    );

    // Previously the adapter fell back to the full catalog here, silently
    // bypassing the allowlist constraint (audit S1.2). It now returns an
    // empty tool set with the diagnostic resolution code so the executor
    // can decide how to recover.
    expect(result.requestMetrics).toMatchObject({
      toolCount: 0,
      toolNames: [],
      requestedToolNames: ["mcp.example.start"],
      missingRequestedToolNames: ["mcp.example.start"],
      toolResolution: "subset_no_resolved_matches",
      providerCatalogToolCount: 1,
    });
  });

  it("healthCheck returns true when server is running", async () => {
    mockList.mockResolvedValueOnce({ models: [] });

    const provider = new OllamaProvider({});
    const result = await provider.healthCheck();
    expect(result).toBe(true);
    expect(mockList).toHaveBeenCalledOnce();
  });

  it("healthCheck returns false when server is not running", async () => {
    mockList.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const provider = new OllamaProvider({});
    const result = await provider.healthCheck();
    expect(result).toBe(false);
  });

  it("maps ECONNREFUSED to descriptive error", async () => {
    mockChat.mockRejectedValueOnce({
      code: "ECONNREFUSED",
      message: "Connection refused",
    });

    const provider = new OllamaProvider({});
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(/Cannot connect to Ollama/);
  });

  it("maps general errors to LLMProviderError", async () => {
    mockChat.mockRejectedValueOnce({ message: "model not found" });

    const provider = new OllamaProvider({});
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMProviderError);
  });

  it("maps 500 errors to LLMServerError", async () => {
    mockChat.mockRejectedValueOnce({
      status: 500,
      message: "Internal server error",
    });

    const provider = new OllamaProvider({});
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMServerError);
  });

  it("maps 401 to LLMAuthenticationError", async () => {
    mockChat.mockRejectedValueOnce({ status: 401, message: "Unauthorized" });

    const provider = new OllamaProvider({});
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMAuthenticationError);
  });

  it("maps AbortError to LLMTimeoutError", async () => {
    mockChat.mockRejectedValueOnce({ name: "AbortError", message: "aborted" });

    const provider = new OllamaProvider({ timeoutMs: 1000 });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMTimeoutError);
  });

  it("uses the per-call timeout override and forwards the abort signal", async () => {
    mockChat.mockImplementationOnce(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject({ name: "AbortError", message: "aborted" });
          }, { once: true });
        }),
    );

    const provider = new OllamaProvider({ timeoutMs: 60_000 });
    await expect(
      provider.chat(
        [{ role: "user", content: "test" }],
        { timeoutMs: 5 },
      ),
    ).rejects.toThrow(LLMTimeoutError);

    expect(mockChat).toHaveBeenCalledOnce();
    expect(mockChat.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns partial streamed content on mid-stream failure", async () => {
    mockChat.mockResolvedValueOnce(
      (async function* () {
        yield { message: { content: "partial " }, model: "llama3" };
        yield { message: { content: "response" }, model: "llama3" };
        throw { name: "AbortError", message: "stream interrupted" };
      })(),
    );

    const provider = new OllamaProvider({ timeoutMs: 1000 });
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      () => undefined,
    );

    expect(response.finishReason).toBe("error");
    expect(response.partial).toBe(true);
    expect(response.content).toBe("partial response");
    expect(response.error).toBeInstanceOf(LLMTimeoutError);
  });

  it("throws when stream fails before any content is received", async () => {
    mockChat.mockResolvedValueOnce(
      (async function* () {
        throw new Error("stream failed");
      })(),
    );

    const provider = new OllamaProvider({});
    await expect(
      provider.chatStream([{ role: "user", content: "test" }], () => undefined),
    ).rejects.toThrow(LLMProviderError);
  });

  it("passes keepAlive configuration", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({ keepAlive: "10m" });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockChat.mock.calls[0][0];
    expect(params.keep_alive).toBe("10m");
  });

  it("passes tools in OpenAI-compatible format", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());

    const provider = new OllamaProvider({
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up info",
            parameters: { type: "object" },
          },
        },
      ],
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockChat.mock.calls[0][0];
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].function.name).toBe("lookup");
  });

  it("repairs orphan tool messages and sends to Ollama", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());
    const provider = new OllamaProvider({});

    const result = await provider.chat([
      { role: "user", content: "test" },
      { role: "assistant", content: "" },
      {
        role: "tool",
        content: '{"stdout":"","exitCode":0}',
        toolCallId: "call_1",
        toolName: "desktop.bash",
      },
    ]);
    expect(result.content).toBe("Hello!");
    expect(mockChat).toHaveBeenCalled();
  });

  it("repairs mixed valid/invalid tool history and sends to Ollama", async () => {
    mockChat.mockResolvedValueOnce(makeResponse());
    const provider = new OllamaProvider({});

    const result = await provider.chat([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "desktop.bash",
            arguments: '{"command":"echo hi"}',
          },
        ],
      },
      {
        role: "tool",
        content: '{"stdout":"hi\\n","exitCode":0}',
        toolCallId: "call_1",
      },
      { role: "assistant", content: "" },
      {
        role: "tool",
        content: '{"stdout":"","exitCode":0}',
        toolCallId: "call_2",
      },
    ]);
    expect(result.content).toBe("Hello!");
    expect(mockChat).toHaveBeenCalled();
  });
});
