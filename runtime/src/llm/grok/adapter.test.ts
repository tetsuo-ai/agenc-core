import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMMessage, LLMTool } from "../types.js";
import {
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";
import { sanitizeToolCallArgumentsForReplay } from "../chat-executor-tool-utils.js";

// Mock the openai module
const mockCreate = vi.fn();
const mockRetrieve = vi.fn();
const mockDelete = vi.fn();
const mockModelsListFn = vi.fn();
const mockOpenAIConstructor = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      responses = {
        create: mockCreate,
        retrieve: mockRetrieve,
        delete: mockDelete,
      };
      models = { list: mockModelsListFn };
      constructor(opts: any) {
        mockOpenAIConstructor(opts);
      }
    },
  };
});

// Import after mock setup
import { GrokProvider } from "./adapter.js";

const DOCUMENTED_XAI_RESPONSES_FIELDS = new Set([
  "include",
  "input",
  "logprobs",
  "max_output_tokens",
  "max_turns",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "store",
  "stream",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "user",
]);

function makeCompletion(overrides: Record<string, any> = {}) {
  return {
    status: "completed",
    output_text: "Hello!",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "Hello!" }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    model: "grok-4-1-fast-reasoning",
    ...overrides,
  };
}

describe("GrokProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("applies a default request timeout when timeoutMs is omitted", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    await provider.chat([{ role: "user", content: "test" }]);

    expect(mockOpenAIConstructor).toHaveBeenCalledOnce();
    // Default timeout was raised from 60s to 120s in the runtime hardening
    // batch (PR #174) because the planner-verifier phase on reasoning models
    // routinely exceeded 60s. This test pins the new default.
    expect(mockOpenAIConstructor.mock.calls[0][0].timeout).toBe(120_000);
  });

  it("reports execution profile from explicit context window overrides", async () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-3-mini",
      contextWindowTokens: 99_999,
      maxTokens: 4_096,
    });

    await expect(provider.getExecutionProfile?.()).resolves.toEqual({
      provider: "grok",
      model: "grok-3-mini",
      contextWindowTokens: 99_999,
      contextWindowSource: "explicit_config",
      maxOutputTokens: 4_096,
    });
  });

  it("does not advertise undocumented provider-side compaction support", () => {
    const provider = new GrokProvider({ apiKey: "test-key" });

    expect(provider.getCapabilities()).toMatchObject({
      stateful: {
        assistantPhase: false,
        previousResponseId: true,
        encryptedReasoning: true,
        storedResponseRetrieval: true,
        storedResponseDeletion: true,
        opaqueCompaction: false,
      },
    });
  });

  it("retrieves a stored xAI response using the documented Responses API method", async () => {
    mockRetrieve.mockResolvedValueOnce({
      id: "resp_saved_1",
      model: "grok-4.20-reasoning",
      status: "completed",
      output_text: "Saved answer",
      output: [
        {
          type: "reasoning",
          encrypted_content: "ciphertext",
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "Saved answer" }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      server_side_tool_usage: {
        SERVER_SIDE_TOOL_WEB_SEARCH: 1,
      },
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.retrieveStoredResponse?.("resp_saved_1");

    expect(mockRetrieve).toHaveBeenCalledWith("resp_saved_1");
    expect(response).toMatchObject({
      id: "resp_saved_1",
      provider: "grok",
      model: "grok-4.20-reasoning",
      status: "completed",
      content: "Saved answer",
      encryptedReasoning: {
        requested: true,
        available: true,
      },
    });
    expect(
      response?.providerEvidence?.serverSideToolUsage?.[0]?.category,
    ).toBe("SERVER_SIDE_TOOL_WEB_SEARCH");
  });

  it("deletes a stored xAI response using the documented Responses API method", async () => {
    mockDelete.mockResolvedValueOnce({
      id: "resp_saved_1",
      deleted: true,
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    const result = await provider.deleteStoredResponse?.("resp_saved_1");

    expect(mockDelete).toHaveBeenCalledWith("resp_saved_1");
    expect(result).toEqual({
      id: "resp_saved_1",
      provider: "grok",
      deleted: true,
      raw: {
        id: "resp_saved_1",
        deleted: true,
      },
    });
  });

  it("treats timeoutMs=0 as unlimited instead of restoring the default timeout", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 0 });
    await provider.chat([{ role: "user", content: "test" }]);

    expect(mockOpenAIConstructor).toHaveBeenCalledOnce();
    expect(mockOpenAIConstructor.mock.calls[0][0].timeout).toBeUndefined();
  });

  it("sends messages in Responses-compatible format", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    const messages: LLMMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];

    const response = await provider.chat(messages);

    expect(mockCreate).toHaveBeenCalledOnce();
    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe("grok-4-1-fast-reasoning");
    expect(params.input).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ]);
    expect(response.content).toBe("Hello!");
    expect(response.finishReason).toBe("stop");
    expect(response.requestMetrics).toBeDefined();
    expect(response.requestMetrics?.messageCount).toBeGreaterThan(0);
    expect(response.requestMetrics?.systemMessages).toBe(1);
    expect(response.requestMetrics?.userMessages).toBe(1);
  });

  it("includes tool schema diagnostics in requestMetrics", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
    });

    const response = await provider.chat([{ role: "user", content: "run ls" }]);
    expect(response.requestMetrics).toBeDefined();
    expect(response.requestMetrics?.toolCount).toBeGreaterThan(0);
    expect(response.requestMetrics?.toolSchemaChars).toBeGreaterThan(0);
  });

  it("applies per-call routed tool subset when provided", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "system.httpGet",
            description: "http get",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "run ls" }],
      { toolRouting: { allowedToolNames: ["system.bash"] } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeDefined();
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe("system.bash");
  });

  it("preserves documented required single-tool choice for the Responses API", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      { toolChoice: "required" },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.tool_choice).toBe("required");
  });

  it("captures selected tools and tool_choice in request metrics", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "system.httpGet",
            description: "http get",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      {
        toolRouting: { allowedToolNames: ["system.bash"] },
        toolChoice: "required",
      },
    );

    expect(response.requestMetrics).toMatchObject({
      toolCount: 1,
      toolNames: ["system.bash"],
      requestedToolNames: ["system.bash"],
      missingRequestedToolNames: [],
      toolResolution: "subset_exact",
      toolChoice: "required",
      store: false,
    });
  });

  it("treats an empty routed allowlist as no attached tools", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "reply with exactly ACK" }],
      {
        toolRouting: { allowedToolNames: [] },
        toolChoice: "none",
      },
    );

    const params = mockCreate.mock.calls.at(-1)?.[0];
    expect(params.tools).toBeUndefined();
    expect(response.requestMetrics).toMatchObject({
      toolCount: 0,
      toolNames: [],
      requestedToolNames: [],
      toolResolution: "all_tools_empty_filter",
      toolsAttached: false,
      store: false,
    });
  });

  it("suppresses tools when toolChoice none is set without an explicit allowlist", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "reply with exactly ACK" }],
      { toolChoice: "none" },
    );

    const params = mockCreate.mock.calls.at(-1)?.[0];
    expect(params.tools).toBeUndefined();
    expect(response.requestMetrics).toMatchObject({
      toolCount: 0,
      toolResolution: "all_tools_empty_filter",
      toolSuppressionReason: "tool_choice_none",
      toolsAttached: false,
    });
  });


  it("normalizes forced function tool_choice for the Responses API", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "mcp.browser.browser_navigate",
            description: "open a url",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "open the docs" }],
      { toolChoice: { type: "function", name: "mcp.browser.browser_navigate" } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.tool_choice).toEqual({
      type: "function",
      function: {
        name: "mcp.browser.browser_navigate",
      },
    });
  });

  it("emits raw provider request and response trace events when enabled", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      {
        toolRouting: { allowedToolNames: ["system.bash"] },
        toolChoice: "required",
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
      provider: "grok",
      context: {
        requestedToolNames: ["system.bash"],
        resolvedToolNames: ["system.bash"],
        missingRequestedToolNames: [],
        toolResolution: "subset_exact",
        messageCount: 1,
        systemMessages: 0,
        userMessages: 1,
        assistantMessages: 0,
        toolMessages: 0,
      },
      payload: {
        tool_choice: "required",
      },
    });
    expect((events[0].payload as { tools?: Array<{ name?: string }> }).tools?.[0]?.name).toBe(
      "system.bash",
    );
    expect(events[1]).toMatchObject({
      kind: "response",
      transport: "chat",
      provider: "grok",
    });
    expect((events[1].payload as { output_text?: string }).output_text).toBe("Hello!");
  });

  it("captures provider request IDs and response headers in non-stream traces when exposed by the SDK", async () => {
    mockCreate.mockReturnValueOnce({
      withResponse: vi.fn().mockResolvedValue({
        data: makeCompletion({ id: "resp_nonstream" }),
        response: new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_nonstream_123",
          },
        }),
        request_id: "req_nonstream_123",
      }),
    });

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({ apiKey: "test-key" });

    await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      {
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(events[1]).toMatchObject({
      kind: "response",
      context: {
        providerRequestId: "req_nonstream_123",
        providerResponseId: "resp_nonstream",
        responseStatus: 200,
        responseHeaders: {
          "content-type": "application/json",
          "x-request-id": "req_nonstream_123",
        },
      },
    });
  });

  it("records provider-default timeout provenance in request traces", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({
      apiKey: "test-key",
    });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    try {
      await provider.chat(
        [{ role: "user", content: "inspect the repo" }],
        {
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        },
      );
    } finally {
      dateNow.mockRestore();
    }

    expect(events[0]).toMatchObject({
      kind: "request",
      context: {
        configuredProviderTimeoutMs: null,
        callOverrideTimeoutMs: null,
        // Default timeout was raised from 60s to 120s in PR #174.
        effectiveTimeoutMs: 120_000,
        timeoutSource: "provider_default",
        timeoutMs: 120_000,
      },
    });
  });

  it("preserves unlimited timeout provenance for streamed requests", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.completed",
          response: makeCompletion({
            output_text: "done",
          }),
        };
      })(),
    );

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({
      apiKey: "test-key",
      timeoutMs: 0,
    });

    await provider.chatStream(
      [{ role: "user", content: "inspect the repo" }],
      () => undefined,
      {
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(events[0]).toMatchObject({
      kind: "request",
      transport: "chat_stream",
      context: {
        configuredProviderTimeoutMs: 0,
        callOverrideTimeoutMs: null,
        effectiveTimeoutMs: null,
        timeoutSource: "provider_config",
        timeoutMs: null,
      },
    });
  });

  it("emits a stream-open trace and raw stream events with provider request metadata", async () => {
    mockCreate.mockReturnValueOnce({
      withResponse: vi.fn().mockResolvedValue({
        data: (async function* () {
          yield {
            type: "response.output_text.delta",
            delta: "Hello",
          };
          yield {
            type: "response.completed",
            response: makeCompletion({
              id: "resp_stream",
              output_text: "Hello",
            }),
          };
        })(),
        response: new Response(null, {
          status: 200,
          headers: {
            "x-request-id": "req_stream_123",
          },
        }),
        request_id: "req_stream_123",
      }),
    });

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({ apiKey: "test-key" });

    await provider.chatStream(
      [{ role: "user", content: "inspect the repo" }],
      () => undefined,
      {
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(events[1]).toMatchObject({
      kind: "stream_event",
      payload: { type: "stream.open" },
      context: {
        eventIndex: 0,
        eventType: "stream.open",
        providerRequestId: "req_stream_123",
        responseStatus: 200,
      },
    });
    expect(events[2]).toMatchObject({
      kind: "stream_event",
      payload: {
        type: "response.output_text.delta",
        delta: "Hello",
      },
      context: {
        eventIndex: 1,
        eventType: "response.output_text.delta",
        providerRequestId: "req_stream_123",
      },
    });
    expect(events[3]).toMatchObject({
      kind: "stream_event",
      payload: {
        type: "response.completed",
      },
      context: {
        eventIndex: 2,
        eventType: "response.completed",
        providerRequestId: "req_stream_123",
      },
    });
    expect(events[4]).toMatchObject({
      kind: "response",
      context: {
        providerRequestId: "req_stream_123",
        providerResponseId: "resp_stream",
      },
    });
  });

  it("records per-call timeout overrides in request traces", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({
      apiKey: "test-key",
      timeoutMs: 60_000,
    });

    await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      {
        timeoutMs: 5,
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(events[0]).toMatchObject({
      kind: "request",
      context: {
        configuredProviderTimeoutMs: 60_000,
        callOverrideTimeoutMs: 5,
        effectiveTimeoutMs: 5,
        timeoutSource: "call_override",
        timeoutMs: 5,
      },
    });
  });

  it("suppresses tools when routed allowlist resolves to zero matches (fail-closed)", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "inspect the repo" }],
      {
        toolRouting: { allowedToolNames: ["mcp.example.start"] },
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    // Previously the adapter fell back to the full catalog here, silently
    // bypassing the allowlist constraint (audit S1.2). It now returns an
    // empty tool set with the diagnostic resolution code so the executor
    // can decide how to recover.
    expect(response.requestMetrics).toMatchObject({
      toolCount: 0,
      toolNames: [],
      requestedToolNames: ["mcp.example.start"],
      missingRequestedToolNames: ["mcp.example.start"],
      toolResolution: "subset_no_resolved_matches",
      providerCatalogToolCount: 1,
    });
    expect(events[0]).toMatchObject({
      kind: "request",
      context: {
        requestedToolNames: ["mcp.example.start"],
        resolvedToolNames: [],
        missingRequestedToolNames: ["mcp.example.start"],
        toolResolution: "subset_no_resolved_matches",
        providerCatalogToolCount: 1,
      },
    });
  });

  it("records persisted stateful anchor details on provider response traces", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        id: "resp_trace_stateful_1",
        output_text: "Stored",
      }),
    );

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [{ role: "user", content: "Persist the anchor." }],
      {
        stateful: { sessionId: "sess-trace-stateful" },
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind: "response",
      transport: "chat",
      context: {
        statefulResponseId: "resp_trace_stateful_1",
        statefulContinued: false,
      },
    });
    expect((events[1].context as Record<string, unknown>).statefulReconciliationHash)
      .toEqual(expect.any(String));
  });

  it("preserves explicitly routed tools even when they were dropped from the slimmed full catalog", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const bulkySystemTools: LLMTool[] = Array.from({ length: 180 }, (_, index) => ({
      type: "function",
      function: {
        name: `system.tool_${String(index).padStart(3, "0")}`,
        description: `tool ${index} ` + "x".repeat(240),
        parameters: {
          type: "object",
          properties: {
            payload: {
              type: "string",
              description: "y".repeat(500),
            },
          },
        },
      },
    }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        ...bulkySystemTools,
        {
          type: "function",
          function: {
            name: "mcp.example.start",
            description: "start the example tool",
            parameters: {
              type: "object",
              properties: {
                scenario: { type: "string" },
                async_player: { type: "boolean" },
              },
            },
          },
        },
      ],
    });

    const response = await provider.chat(
      [{ role: "user", content: "start the example tool" }],
      { toolRouting: { allowedToolNames: ["mcp.example.start"] } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeDefined();
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe("mcp.example.start");
    expect(response.requestMetrics).toMatchObject({
      toolCount: 1,
      toolNames: ["mcp.example.start"],
      requestedToolNames: ["mcp.example.start"],
      missingRequestedToolNames: [],
      toolResolution: "subset_exact",
    });
  });

  it("parses tool calls from response", async () => {
    const completion = makeCompletion({
      output_text: "",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: '{"q":"test"}',
        },
      ],
    });
    mockCreate.mockResolvedValueOnce(completion);

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([
      { role: "user", content: "search for test" },
    ]);

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe("search");
    expect(response.finishReason).toBe("tool_calls");
  });

  it("preserves provider function calls whose JSON arguments contain HTML entities inside string values", async () => {
    const completion = makeCompletion({
      output_text: "",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "system.writeFile",
          arguments:
            '{"path":"src/parser.c","content":"strcmp(token, \\"&quot;&gt;&quot;\\") == 0 && strcmp(token, \\"&amp;\\") == 0;"}',
        },
      ],
    });
    mockCreate.mockResolvedValueOnce(completion);

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([
      { role: "user", content: "write parser.c" },
    ]);

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      {
        id: "call_1",
        name: "system.writeFile",
        arguments:
          '{"path":"src/parser.c","content":"strcmp(token, \\"\\">\\"\\") == 0 && strcmp(token, \\"&\\") == 0;"}',
      },
    ]);
  });

  it("emits a trace when a provider function call is rejected during normalization", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        output_text: "",
        output: [
          {
            type: "function_call",
            call_id: "call_bad",
            name: "system.writeFile",
            arguments: '["bad"]',
          },
        ],
      }),
    );

    const events: Array<Record<string, unknown>> = [];
    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat(
      [{ role: "user", content: "write parser.c" }],
      {
        trace: {
          includeProviderPayloads: true,
          onProviderTraceEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
      },
    );

    expect(response.toolCalls).toHaveLength(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stream_event",
          transport: "chat",
          payload: expect.objectContaining({
            eventType: "tool_call_validation_failed",
            failureCode: "non_object_arguments",
            toolCallId: "call_bad",
            toolName: "system.writeFile",
          }),
        }),
      ]),
    );
  });

  it("surfaces provider citations as provider evidence", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        citations: [
          "https://docs.phaser.io",
          "https://pixijs.com",
        ],
      }),
    );

    const provider = new GrokProvider({ apiKey: "test-key", webSearch: true });
    const response = await provider.chat([
      { role: "user", content: "Compare Phaser and Pixi from official docs" },
    ]);

    expect(response.providerEvidence?.citations).toEqual([
      "https://docs.phaser.io",
      "https://pixijs.com",
    ]);
  });

  it("injects web_search tool when webSearch is true", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4-1-fast-reasoning",
      webSearch: true,
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeDefined();
    expect(params.tools.some((t: any) => t.type === "web_search")).toBe(true);
  });

  it("injects documented xAI provider-native tools from the capability surface", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4-1-fast-reasoning",
      webSearch: true,
      webSearchOptions: {
        allowedDomains: ["docs.x.ai"],
        enableImageUnderstanding: true,
      },
      xSearch: true,
      xSearchOptions: {
        allowedXHandles: ["xai"],
        enableVideoUnderstanding: true,
      },
      codeExecution: true,
      collectionsSearch: {
        enabled: true,
        vectorStoreIds: ["collection-123"],
        maxNumResults: 10,
      },
      remoteMcp: {
        enabled: true,
        servers: [
          {
            serverUrl: "https://mcp.example.com/sse",
            serverLabel: "docs",
            allowedTools: ["search_docs"],
          },
        ],
      },
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toEqual(
      expect.arrayContaining([
        {
          type: "web_search",
          filters: { allowed_domains: ["docs.x.ai"] },
          enable_image_understanding: true,
        },
        {
          type: "x_search",
          allowed_x_handles: ["xai"],
          enable_video_understanding: true,
        },
        { type: "code_interpreter" },
        {
          type: "file_search",
          vector_store_ids: ["collection-123"],
          max_num_results: 10,
        },
        {
          type: "mcp",
          server_url: "https://mcp.example.com/sse",
          server_label: "docs",
          allowed_tools: ["search_docs"],
        },
      ]),
    );
  });

  it("does not inject web_search tool for unsupported Grok models", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-code-fast-1",
      webSearch: true,
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeUndefined();
  });

  it("captures documented server-side tool calls and usage in provider evidence", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        server_side_tool_usage: {
          SERVER_SIDE_TOOL_WEB_SEARCH: 2,
          SERVER_SIDE_TOOL_VIEW_IMAGE: 1,
        },
        output: [
          {
            type: "web_search_call",
            id: "ws_123",
            name: "web_search",
            arguments: "{\"query\":\"xai\"}",
            status: "completed",
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "Hello!" }],
          },
        ],
      }),
    );

    const provider = new GrokProvider({
      apiKey: "test-key",
      webSearch: true,
    });
    const response = await provider.chat([{ role: "user", content: "test" }]);

    expect(response.providerEvidence?.serverSideToolCalls).toEqual([
      {
        type: "web_search_call",
        toolType: "web_search",
        id: "ws_123",
        functionName: "web_search",
        arguments: "{\"query\":\"xai\"}",
        status: "completed",
        raw: expect.objectContaining({
          type: "web_search_call",
          id: "ws_123",
        }),
      },
    ]);
    expect(response.providerEvidence?.serverSideToolUsage).toEqual([
      {
        category: "SERVER_SIDE_TOOL_WEB_SEARCH",
        toolType: "web_search",
        count: 2,
      },
      {
        category: "SERVER_SIDE_TOOL_VIEW_IMAGE",
        toolType: "view_image",
        count: 1,
      },
    ]);
  });

  it("wires max_turns, reasoning effort, and encrypted reasoning include from config", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    // Per developers/model-capabilities/text/reasoning, the `reasoning`
    // parameter is only supported on `grok-4.20-multi-agent-0309` (where
    // it controls agent count). All other Grok 4 variants reject it.
    // The strict pre-flight validator enforces this.
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.20-multi-agent-0309",
      maxTurns: 4,
      reasoningEffort: "high",
      includeEncryptedReasoning: true,
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.max_turns).toBe(4);
    expect(params.reasoning).toEqual({ effort: "high" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("sends documented xAI text.format requests and parses structured output payloads", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        output_text:
          '{"overall":"pass","confidence":0.93,"unresolved":[],"steps":[{"name":"delegate_logs","verdict":"pass","confidence":0.93,"retryable":false,"issues":[],"summary":"grounded"}]}',
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text:
                  '{"overall":"pass","confidence":0.93,"unresolved":[],"steps":[{"name":"delegate_logs","verdict":"pass","confidence":0.93,"retryable":false,"issues":[],"summary":"grounded"}]}',
              },
            ],
          },
        ],
      }),
    );

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat(
      [{ role: "user", content: "verify the delegated output" }],
      {
        structuredOutput: {
          enabled: true,
          schema: {
            type: "json_schema",
            name: "agenc_subagent_verifier_decision",
            schema: {
              type: "object",
              properties: {
                overall: { type: "string" },
              },
              required: ["overall"],
            },
          },
        },
      },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.text).toEqual({
      format: {
        type: "json_schema",
        name: "agenc_subagent_verifier_decision",
        schema: {
          type: "object",
          properties: {
            overall: { type: "string" },
          },
          required: ["overall"],
        },
        strict: true,
      },
    });
    expect(response.structuredOutput).toEqual({
      type: "json_schema",
      name: "agenc_subagent_verifier_decision",
      rawText:
        '{"overall":"pass","confidence":0.93,"unresolved":[],"steps":[{"name":"delegate_logs","verdict":"pass","confidence":0.93,"retryable":false,"issues":[],"summary":"grounded"}]}',
      parsed: {
        overall: "pass",
        confidence: 0.93,
        unresolved: [],
        steps: [
          {
            name: "delegate_logs",
            verdict: "pass",
            confidence: 0.93,
            retryable: false,
            issues: [],
            summary: "grounded",
          },
        ],
      },
    });
    expect(response.requestMetrics).toMatchObject({
      structuredOutputEnabled: true,
      structuredOutputName: "agenc_subagent_verifier_decision",
      structuredOutputStrict: true,
    });
  });

  it("rejects structured outputs with tools on non-Grok-4 models instead of silently degrading", async () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-code-fast-1",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    await expect(
      provider.chat(
        [{ role: "user", content: "inspect the repo and summarize findings" }],
        {
          structuredOutput: {
            enabled: true,
            schema: {
              type: "json_schema",
              name: "repo_summary",
              schema: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                },
                required: ["summary"],
              },
            },
          },
        },
      ),
    ).rejects.toThrow(/structured outputs with tools require a Grok 4 model/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed structured output payloads instead of treating them as success", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        output_text: '["repo looks healthy"]',
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: '["repo looks healthy"]',
              },
            ],
          },
        ],
      }),
    );

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chat(
        [{ role: "user", content: "inspect the repo and summarize findings" }],
        {
          structuredOutput: {
            enabled: true,
            schema: {
              type: "json_schema",
              name: "repo_summary",
              schema: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                },
                required: ["summary"],
              },
            },
          },
        },
      ),
    ).rejects.toThrow(/must return a top-level JSON object/i);
  });

  it("disables parallel tool calls by default when tools are present", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
    });

    await provider.chat([{ role: "user", content: "run ls" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.parallel_tool_calls).toBe(false);
  });

  it("honors parallelToolCalls override when enabled", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      parallelToolCalls: true,
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
    });

    await provider.chat([{ role: "user", content: "run ls" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.parallel_tool_calls).toBe(true);
  });

  it("preserves full tool descriptions and strips nested schema metadata Grok rejects", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const noisyTool: LLMTool = {
      type: "function",
      function: {
        name: "noisy.tool",
        description: "D".repeat(800),
        parameters: {
          type: "object",
          description: "Top-level schema description",
          properties: {
            command: {
              type: "string",
              description: "Very long per-field description",
            },
          },
          required: ["command"],
        },
      },
    };

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [noisyTool],
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    const tool = params.tools[0];
    // Description passes through intact — the 200-char cap was
    // structurally defeating model-contract prompts.
    expect(tool.description).toBe("D".repeat(800));
    // Nested-schema metadata (description, title, etc.) is still
    // stripped because Grok rejects those fields.
    const paramsJson = JSON.stringify(tool.parameters);
    expect(paramsJson.includes("description")).toBe(false);
  });

  it("keeps tools on follow-up turns even when tool payload is large", async () => {
    // Regression test for the legacy `MAX_TOOL_SCHEMA_CHARS_FOLLOWUP = 20_000`
    // bug. The previous behavior dropped the entire `tools` array on every
    // follow-up turn whose serialized tool schema exceeded 20K chars,
    // which made the Grok agent loop exit after exactly one tool call per
    // chat turn (the model would have no tools to call on the followup).
    // The fix removed the budget guard; now tools are always sent. The
    // strict-filter `assertNoSilentToolDropOnFollowup` enforces this
    // structurally — if the runtime selects tools and they get stripped
    // before send, the adapter throws.
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const manyTools: LLMTool[] = Array.from({ length: 120 }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: `Tool ${i}`,
        parameters: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            c: { type: "string" },
            d: { type: "string" },
            e: { type: "string" },
            f: { type: "string" },
          },
          required: ["a"],
        },
      },
    }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: manyTools,
    });
    await provider.chat([
      { role: "user", content: "run tool" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "tool_1",
            arguments: '{"a":"value"}',
          },
        ],
      },
      {
        role: "tool",
        content: "{\"ok\":true}",
        toolCallId: "call_1",
        toolName: "tool_1",
      },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(Array.isArray(params.tools)).toBe(true);
    expect((params.tools as unknown[]).length).toBe(120);
  });

  it("auto-trims tool catalog to documented xAI 128-tool maximum", async () => {
    // AgenC's live tool registry has 129 tools (77 system + 20 doom MCP
    // + 18 agenc protocol + 6 social + 4 task + execute_with_agent +
    // coordinator_mode + 2 solana-fender). xAI docs cap tools at 128.
    // The adapter must auto-trim to stay functional; the strict filter's
    // 128-tool rejection is a defense-in-depth catch below this layer.
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const overLimitTools: LLMTool[] = Array.from(
      { length: 129 },
      (_, i) => ({
        type: "function",
        function: {
          name: `tool_${String(i).padStart(3, "0")}`,
          description: `Tool ${i}`,
          parameters: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
        },
      }),
    );

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: overLimitTools,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let capturedWarnCalls: unknown[][] = [];
    try {
      await provider.chat([{ role: "user", content: "hello" }]);
      // Capture before mockRestore() below clears mock.calls.
      capturedWarnCalls = warnSpy.mock.calls.map((call) => [...call]);
    } finally {
      warnSpy.mockRestore();
    }

    const params = mockCreate.mock.calls[0][0];
    expect(Array.isArray(params.tools)).toBe(true);
    // Trimmed to exactly 128; the last tool (tool_128) is dropped.
    expect((params.tools as unknown[]).length).toBe(128);
    const sentNames = (params.tools as Array<{ name?: unknown }>).map((t) =>
      String(t.name),
    );
    expect(sentNames[0]).toBe("tool_000");
    expect(sentNames[127]).toBe("tool_127");
    expect(sentNames).not.toContain("tool_128");

    // Operator-visible warning naming the dropped tool.
    const warnCall = capturedWarnCalls.find((call) =>
      String(call[0] ?? "").includes("Tool catalog has 129 tools"),
    );
    expect(warnCall).toBeDefined();
    expect(String(warnCall?.[0] ?? "")).toContain("tool_128");
  });

  it("prioritizes critical AgenC task tools before trimming over-limit xAI catalogs", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const lowerPriorityTools: LLMTool[] = Array.from(
      { length: 129 },
      (_, i) => ({
        type: "function",
        function: {
          name: `aaa.tool_${String(i).padStart(3, "0")}`,
          description: `Tool ${i}`,
          parameters: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
        },
      }),
    );
    const completeTaskTool: LLMTool = {
      type: "function",
      function: {
        name: "agenc.completeTask",
        description: "Submit proof for a completed AgenC task",
        parameters: {
          type: "object",
          properties: {
            taskPda: { type: "string" },
            proofHash: { type: "string" },
          },
          required: ["taskPda", "proofHash"],
        },
      },
    };

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: [...lowerPriorityTools, completeTaskTool],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let capturedWarnCalls: unknown[][] = [];
    try {
      await provider.chat([{ role: "user", content: "submit completion" }]);
      capturedWarnCalls = warnSpy.mock.calls.map((call) => [...call]);
    } finally {
      warnSpy.mockRestore();
    }

    const params = mockCreate.mock.calls[0][0];
    expect(Array.isArray(params.tools)).toBe(true);
    expect((params.tools as unknown[]).length).toBe(128);
    const sentNames = (params.tools as Array<{ name?: unknown }>).map((t) =>
      String(t.name),
    );
    expect(sentNames).toContain("agenc.completeTask");
    expect(sentNames).not.toContain("aaa.tool_128");

    const warnCall = capturedWarnCalls.find((call) =>
      String(call[0] ?? "").includes("Tool catalog has 130 tools"),
    );
    expect(warnCall).toBeDefined();
    expect(String(warnCall?.[0] ?? "")).toContain("aaa.tool_128");
    expect(String(warnCall?.[0] ?? "")).not.toContain("agenc.completeTask");
  });

  it("does NOT trim when tool catalog is exactly at the 128 limit", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const atLimitTools: LLMTool[] = Array.from({ length: 128 }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: `Tool ${i}`,
        parameters: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      },
    }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      tools: atLimitTools,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let capturedWarnCalls: unknown[][] = [];
    try {
      await provider.chat([{ role: "user", content: "hello" }]);
      capturedWarnCalls = warnSpy.mock.calls.map((call) => [...call]);
    } finally {
      warnSpy.mockRestore();
    }

    const params = mockCreate.mock.calls[0][0];
    expect((params.tools as unknown[]).length).toBe(128);
    const trimWarns = capturedWarnCalls.filter((call) =>
      String(call[0] ?? "").includes("Tool catalog has"),
    );
    expect(trimWarns).toHaveLength(0);
  });

  it("passes usage information", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([{ role: "user", content: "test" }]);

    expect(response.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("handles streaming", async () => {
    const chunks = [
      {
        type: "response.output_text.delta",
        delta: "Hello",
      },
      {
        type: "response.output_text.delta",
        delta: " world",
      },
      {
        type: "response.completed",
        response: makeCompletion({
          output_text: "Hello world",
          model: "grok-3",
        }),
      },
    ];
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key" });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.content).toBe("Hello world");
    expect(onChunk).toHaveBeenCalledWith({ content: "Hello", done: false });
    expect(onChunk).toHaveBeenCalledWith({ content: " world", done: false });
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("maps 429 error to LLMRateLimitError", async () => {
    mockCreate.mockRejectedValueOnce({
      status: 429,
      message: "Rate limited",
      headers: {},
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMRateLimitError);
  });

  it("surfaces provider error details on non-stream failed responses", async () => {
    mockCreate.mockResolvedValueOnce(
      makeCompletion({
        status: "failed",
        output_text: "",
        error: {
          message: "upstream failure",
          code: 502,
        },
      }),
    );

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([{ role: "user", content: "test" }]);

    expect(response.finishReason).toBe("error");
    expect(response.error).toBeInstanceOf(LLMProviderError);
    expect(response.error?.message).toContain("upstream failure");
  });

  it("maps 500 errors to LLMServerError", async () => {
    mockCreate.mockRejectedValueOnce({
      status: 500,
      message: "Internal server error",
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMServerError);
  });

  it("maps 401 to LLMAuthenticationError", async () => {
    mockCreate.mockRejectedValueOnce({
      status: 401,
      message: "Invalid API key",
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMAuthenticationError);
  });

  it("maps AbortError to LLMTimeoutError", async () => {
    mockCreate.mockRejectedValueOnce({
      name: "AbortError",
      message: "signal aborted",
    });

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 1000 });
    await expect(
      provider.chat([{ role: "user", content: "test" }]),
    ).rejects.toThrow(LLMTimeoutError);
  });

  it("uses the per-call timeout override and forwards the abort signal", async () => {
    mockCreate.mockImplementationOnce(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject({ name: "AbortError", message: "signal aborted" });
          }, { once: true });
        }),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 60_000 });
    const timeoutError = await provider.chat(
      [{ role: "user", content: "test" }],
      { timeoutMs: 5 },
    ).catch((error: unknown) => error);

    expect(timeoutError).toBeInstanceOf(LLMTimeoutError);
    expect((timeoutError as LLMTimeoutError).timeoutMs).toBe(5);
    expect((timeoutError as LLMTimeoutError).message).toContain("5ms");

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns partial streamed content on mid-stream failure", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.output_text.delta",
          delta: "partial ",
        };
        yield {
          type: "response.output_text.delta",
          delta: "response",
        };
        throw { name: "AbortError", message: "stream interrupted" };
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 1000 });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.finishReason).toBe("error");
    expect(response.partial).toBe(true);
    expect(response.content).toBe("partial response");
    expect(response.error).toBeInstanceOf(LLMTimeoutError);
  });

  it("surfaces provider error details on response.failed stream events", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.failed",
          response: {
            status: "failed",
            error: { message: "stream failed", code: 503 },
          },
        };
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 1000 });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.finishReason).toBe("error");
    expect(response.error).toBeInstanceOf(LLMProviderError);
    expect(response.error?.message).toContain("stream failed");
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("stops on response.completed even if trailing stream noise follows", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.completed",
          response: makeCompletion({
            output_text: "done",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
          }),
        };
        // Provider-side trailing noise should be ignored after completion.
        yield {
          type: "response.output_text.delta",
          delta: "ignored",
        };
        await new Promise(() => undefined);
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 20 });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.finishReason).toBe("stop");
    expect(response.error).toBeUndefined();
    expect(response.content).toBe("done");
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("times out stalled streaming responses and returns partial output", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: "response.output_text.delta",
          delta: "partial ",
        };
        await new Promise(() => undefined);
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 20 });
    const onChunk = vi.fn();
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      onChunk,
    );

    expect(response.finishReason).toBe("error");
    expect(response.partial).toBe(true);
    expect(response.content).toBe("partial ");
    expect(response.error).toBeInstanceOf(LLMTimeoutError);
    expect(onChunk).toHaveBeenCalledWith({ content: "partial ", done: false });
    expect(onChunk).toHaveBeenCalledWith({
      content: "",
      done: true,
      toolCalls: [],
    });
  });

  it("suppresses async cleanup rejections from streamIterator.return", async () => {
    const returnSpy = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("cleanup failed")),
    );

    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]() {
        let yielded = false;
        return {
          async next() {
            if (yielded) return { done: true, value: undefined };
            yielded = true;
            return {
              done: false,
              value: {
                type: "response.completed",
                response: makeCompletion({
                  output_text: "done",
                }),
              },
            };
          },
          return: returnSpy,
        };
      },
    });

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chatStream(
      [{ role: "user", content: "test" }],
      () => undefined,
    );

    expect(response.content).toBe("done");
    expect(returnSpy).toHaveBeenCalledOnce();
  });

  it("enforces an absolute stream timeout even when chunks keep arriving", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        while (true) {
          yield {
            type: "response.output_text.delta",
            delta: "",
          };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key", timeoutMs: 35 });
    await expect(
      provider.chatStream([{ role: "user", content: "test" }], () => undefined),
    ).rejects.toThrow(LLMTimeoutError);
  });

  it("throws when stream fails before any content is received", async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        throw new Error("stream failed");
      })(),
    );

    const provider = new GrokProvider({ apiKey: "test-key" });
    await expect(
      provider.chatStream([{ role: "user", content: "test" }], () => undefined),
    ).rejects.toThrow(LLMProviderError);
  });

  it("healthCheck returns true on success", async () => {
    mockModelsListFn.mockResolvedValueOnce({ data: [] });

    const provider = new GrokProvider({ apiKey: "test-key" });
    const result = await provider.healthCheck();
    expect(result).toBe(true);
  });

  it("healthCheck returns false on failure", async () => {
    mockModelsListFn.mockRejectedValueOnce(new Error("fail"));

    const provider = new GrokProvider({ apiKey: "test-key" });
    const result = await provider.healthCheck();
    expect(result).toBe(false);
  });

  it("uses custom model", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-3-mini",
    });
    await provider.chat([{ role: "user", content: "test" }]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe("grok-3-mini");
  });

  it("formats tool result messages correctly", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    await provider.chat([
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "search",
            arguments: '{"query":"test"}',
          },
        ],
      },
      {
        role: "tool",
        content: "result data",
        toolCallId: "call_1",
        toolName: "search",
      },
    ]);

    const params = mockCreate.mock.calls[0][0];
    // Index shifts by 1 because assistant messages with empty content
    // + toolCalls now emit a placeholder message before function_call
    // items to satisfy xAI's "each message must have content" rule.
    expect(params.input[3]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "result data",
    });
  });

  it("formats assistant tool_calls for follow-up turns", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    await provider.chat([
      { role: "user", content: "open terminal" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "desktop.bash",
            arguments: '{"command":"xfce4-terminal >/dev/null 2>&1 &"}',
          },
        ],
      },
      {
        role: "tool",
        content: '{"stdout":"","stderr":"","exitCode":0}',
        toolCallId: "call_1",
        toolName: "desktop.bash",
      },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.input[1]).toEqual({
      role: "assistant",
      content: "Calling tool.",
    });
    expect(params.input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "desktop.bash",
      arguments: '{"command":"xfce4-terminal >/dev/null 2>&1 &"}',
    });
  });

  it("drops undocumented assistant phase metadata from Responses API assistant input items", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const provider = new GrokProvider({ apiKey: "test-key" });
    await provider.chat([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Start working." },
      { role: "assistant", content: "Checking the environment first.", phase: "commentary" },
      { role: "user", content: "Continue." },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(params.input).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Start working." },
      {
        role: "assistant",
        content: "Checking the environment first.",
      },
      { role: "user", content: "Continue." },
    ]);
  });

  it("never emits assistant phase metadata in xAI Responses requests", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion({ id: "resp_phase_retry" }));

    const provider = new GrokProvider({ apiKey: "test-key" });
    const response = await provider.chat([
      { role: "user", content: "Start." },
      { role: "assistant", content: "Working...", phase: "commentary" },
      { role: "user", content: "Continue." },
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].input[1]).toEqual({
      role: "assistant",
      content: "Working...",
    });
    expect(response.content).toBe("Hello!");
  });

  it("repairs orphan tool messages and sends to provider instead of rejecting", async () => {
    const provider = new GrokProvider({ apiKey: "test-key" });

    // repairToolTurnSequence synthesizes a minimal assistant tool_calls
    // envelope for orphan tool results, so the call proceeds to the provider.
    mockCreate.mockResolvedValueOnce(makeCompletion());
    const result = await provider.chat([
      { role: "user", content: "test" },
      { role: "assistant", content: "" },
      {
        role: "tool",
        content: '{"stdout":"","stderr":"","exitCode":0}',
        toolCallId: "call_1",
        toolName: "desktop.bash",
      },
    ]);
    expect(result.content).toBe("Hello!");
    expect(mockCreate).toHaveBeenCalled();
  });

  it("rejects non-tool messages before pending tool results are resolved", async () => {
    const provider = new GrokProvider({ apiKey: "test-key" });

    await expect(
      provider.chat([
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo hi"}',
            },
          ],
        },
        { role: "assistant", content: "done" },
      ]),
    ).rejects.toThrow(LLMMessageValidationError);
    await expect(
      provider.chat([
        { role: "user", content: "test" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo hi"}',
            },
          ],
        },
        { role: "assistant", content: "done" },
      ]),
    ).rejects.toThrow(/tool_result_missing/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("repairs two orphan tool-result pairs and sends them to the provider", async () => {
    const provider = new GrokProvider({ apiKey: "test-key" });
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const result = await provider.chat([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "test" },
      { role: "assistant", content: "" },
      {
        role: "tool",
        content: '{"stdout":"","exitCode":0}',
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
    expect(mockCreate).toHaveBeenCalled();
  });

  it("repairs mixed valid/invalid tool-turn history and sends to provider", async () => {
    const provider = new GrokProvider({ apiKey: "test-key" });
    mockCreate.mockResolvedValueOnce(makeCompletion());

    const result = await provider.chat([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: "",
        phase: "commentary",
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
    expect(mockCreate).toHaveBeenCalled();
  });

  it("uses previous_response_id for safe stateful continuation", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_1",
          output_text: "Hello",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_2",
          output_text: "Follow-up",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-1" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "follow up" },
      ],
      { stateful: { sessionId: "sess-1" } },
    );

    const firstParams = mockCreate.mock.calls[0][0];
    const secondParams = mockCreate.mock.calls[1][0];
    expect(firstParams.previous_response_id).toBeUndefined();
    expect(firstParams.store).toBe(true);
    expect(secondParams.previous_response_id).toBe("resp_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.responseId).toBe("resp_2");
  });

  it("defaults stateful Responses requests to store=false and replays locally", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_default_store_1",
          output_text: "Hello",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_default_store_2",
          output_text: "Follow-up",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-default-store" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "follow up" },
      ],
      { stateful: { sessionId: "sess-default-store" } },
    );

    const firstParams = mockCreate.mock.calls[0][0];
    const secondParams = mockCreate.mock.calls[1][0];
    expect(firstParams.store).toBe(true);
    expect(secondParams.store).toBe(true);
    expect(secondParams.previous_response_id).toBe("resp_default_store_1");
    expect(second.stateful?.attempted).toBe(true);
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
    expect(second.stateful?.responseId).toBe("resp_default_store_2");
  });

  it("does not persist previous_response_id anchors for empty assistant turns", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_empty",
          output_text: "",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_fresh",
          output_text: "Recovered statelessly",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-empty-anchor" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "user", content: "follow up after empty turn" },
      ],
      { stateful: { sessionId: "sess-empty-anchor" } },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBeUndefined();
    expect(second.stateful?.continued).toBe(false);
  });

  it("keeps previous_response_id continuity across a tool turn and the next user turn", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_tool_initial",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo TOKEN=ONYX-SHARD-58"}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_tool_followup",
          output_text: "TOKEN=ONYX-SHARD-58",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_tool_next",
          output_text: "confirmed",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    const first = await provider.chat(
      [{ role: "user", content: "find the token" }],
      { stateful: { sessionId: "sess-tool-turn" } },
    );
    const second = await provider.chat(
      [
        { role: "user", content: "find the token" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo TOKEN=ONYX-SHARD-58"}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"TOKEN=ONYX-SHARD-58\\n","exitCode":0}',
          toolCallId: "call_1",
          toolName: "desktop.bash",
        },
      ],
      { stateful: { sessionId: "sess-tool-turn" } },
    );
    const third = await provider.chat(
      [
        { role: "user", content: "find the token" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_1",
              name: "desktop.bash",
              arguments: '{"command":"echo TOKEN=ONYX-SHARD-58"}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"TOKEN=ONYX-SHARD-58\\n","exitCode":0}',
          toolCallId: "call_1",
          toolName: "desktop.bash",
        },
        { role: "assistant", content: "TOKEN=ONYX-SHARD-58" },
        { role: "user", content: "repeat the token" },
      ],
      { stateful: { sessionId: "sess-tool-turn" } },
    );

    expect(first.finishReason).toBe("tool_calls");
    expect(second.content).toBe("TOKEN=ONYX-SHARD-58");
    expect(mockCreate.mock.calls[1][0].previous_response_id).toBe(
      "resp_tool_initial",
    );
    expect(JSON.stringify(mockCreate.mock.calls[1][0].input)).not.toContain(
      "find the token",
    );
    expect(JSON.stringify(mockCreate.mock.calls[1][0].input)).toContain(
      "TOKEN=ONYX-SHARD-58",
    );
    expect(second.requestMetrics?.statefulInputMode).toBe("incremental_delta");
    expect(second.requestMetrics?.statefulOmittedMessageCount).toBeGreaterThan(0);
    expect(mockCreate.mock.calls[2][0].previous_response_id).toBe(
      "resp_tool_followup",
    );
    expect(JSON.stringify(mockCreate.mock.calls[2][0].input)).not.toContain(
      "find the token",
    );
    expect(JSON.stringify(mockCreate.mock.calls[2][0].input)).toContain(
      "repeat the token",
    );
    expect(third.stateful?.continued).toBe(true);
    expect(third.stateful?.fallbackReason).toBeUndefined();
  });

  it("retries reasoning-only completed tool followups with tool_choice none", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_reasoning_only_initial",
          output_text: "",
          output: [
            {
              type: "reasoning",
              id: "rs_reasoning_only",
              summary: [
                {
                  type: "summary_text",
                  text:
                    "The final recovery turn must be direct. The ledger shows repeated failed tool calls.",
                },
              ],
              status: "completed",
            },
          ],
          usage: {
            input_tokens: 34492,
            output_tokens: 280,
            total_tokens: 34772,
            output_tokens_details: { reasoning_tokens: 280 },
          },
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_reasoning_only_retry",
          output_text: "Recovered after retry",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.20-beta-0309-reasoning",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    const response = await provider.chat([
      { role: "user", content: "find the token" },
      {
        role: "assistant",
        content: "",
        phase: "commentary",
        toolCalls: [
          {
            id: "call_reasoning_only_1",
            name: "system.bash",
            arguments: '{"command":"echo TOKEN=ONYX-SHARD-58"}',
          },
        ],
      },
      {
        role: "tool",
        content: "TOKEN=ONYX-SHARD-58",
        toolCallId: "call_reasoning_only_1",
        toolName: "system.bash",
      },
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].tool_choice).toBe("none");
    expect(mockCreate.mock.calls[1][0].stream).toBe(false);
    expect(response.content).toBe("Recovered after retry");
  });

  it("retries direct silent tool drops with tool_choice required", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_silent_drop_initial",
          output_text: "I will call system.bash to inspect the build.",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "I will call system.bash to inspect the build.",
                },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_silent_drop_retry",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_silent_drop_1",
              name: "system.bash",
              arguments: '{"command":"pwd"}',
            },
          ],
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.20-beta-0309-reasoning",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    const response = await provider.chat([
      { role: "user", content: "inspect the build" },
      {
        role: "assistant",
        content: "",
        phase: "commentary",
        toolCalls: [
          {
            id: "call_silent_drop_seed",
            name: "system.bash",
            arguments: '{"command":"echo seeded"}',
          },
        ],
      },
      {
        role: "tool",
        content: "seeded",
        toolCallId: "call_silent_drop_seed",
        toolName: "system.bash",
      },
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].tool_choice).toBe("required");
    expect(mockCreate.mock.calls[1][0].stream).toBe(false);
    expect(response.toolCalls).toMatchObject([
      {
        id: "call_silent_drop_1",
        name: "system.bash",
        arguments: '{"command":"pwd"}',
      },
    ]);
  });

  it("retries silent tool drops that happen on the tool_choice none mitigation path", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_truncated_initial",
          output_text: "Continuing with tool calls to fix the build",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Continuing with tool calls to fix the build",
                },
              ],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 22,
            total_tokens: 122,
          },
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_truncated_retry_none",
          output_text: "I will call system.bash to inspect the build.",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "I will call system.bash to inspect the build.",
                },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_truncated_retry_required",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_recovered_1",
              name: "system.bash",
              arguments: '{"command":"ls"}',
            },
          ],
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.20-beta-0309-reasoning",
      tools: [
        {
          type: "function",
          function: {
            name: "system.bash",
            description: "run command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    });

    const response = await provider.chat([
      { role: "user", content: "inspect the build" },
      {
        role: "assistant",
        content: "",
        phase: "commentary",
        toolCalls: [
          {
            id: "call_truncation_seed",
            name: "system.bash",
            arguments: '{"command":"echo seeded"}',
          },
        ],
      },
      {
        role: "tool",
        content: "seeded",
        toolCallId: "call_truncation_seed",
        toolName: "system.bash",
      },
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[1][0].tool_choice).toBe("none");
    expect(mockCreate.mock.calls[2][0].tool_choice).toBe("required");
    expect(mockCreate.mock.calls[2][0].stream).toBe(false);
    expect(response.toolCalls).toMatchObject([
      {
        id: "call_recovered_1",
        name: "system.bash",
        arguments: '{"command":"ls"}',
      },
    ]);
  });

  it("keeps previous_response_id continuity when replayed tool-call arguments are sanitized", async () => {
    const rawArguments = JSON.stringify({
      path: "packages/core/src/routing.test.ts",
      content: "x".repeat(5_000),
    });
    const replayArguments = sanitizeToolCallArgumentsForReplay(rawArguments);

    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_large_tool_initial",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_large_1",
              name: "system.writeFile",
              arguments: rawArguments,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_large_tool_followup",
          output_text: "patched",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    const first = await provider.chat(
      [{ role: "user", content: "write the large routing test file" }],
      { stateful: { sessionId: "sess-large-tool-turn" } },
    );
    const second = await provider.chat(
      [
        { role: "user", content: "write the large routing test file" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_large_1",
              name: "system.writeFile",
              arguments: replayArguments,
            },
          ],
        },
        {
          role: "tool",
          content:
            '{"path":"packages/core/src/routing.test.ts","bytesWritten":5000}',
          toolCallId: "call_large_1",
          toolName: "system.writeFile",
        },
      ],
      { stateful: { sessionId: "sess-large-tool-turn" } },
    );

    expect(first.finishReason).toBe("tool_calls");
    expect(mockCreate.mock.calls[1][0].previous_response_id).toBe(
      "resp_large_tool_initial",
    );
    expect(second.content).toBe("patched");
    expect(second.requestMetrics?.statefulInputMode).toBe("incremental_delta");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("advances the continuation anchor across consecutive tool rounds", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_round_1",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_round_1",
              name: "system.bash",
              arguments: '{"command":"echo","args":["phase-1"]}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_round_2",
          output_text: "",
          output: [
            {
              type: "function_call",
              call_id: "call_round_2",
              name: "system.readFile",
              arguments: '{"path":"phase-1.txt"}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_round_3",
          output_text: "phase-2 complete",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [{ role: "user", content: "multi-step tool loop" }],
      { stateful: { sessionId: "sess-multi-tool-rounds" } },
    );

    await provider.chat(
      [
        { role: "user", content: "multi-step tool loop" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_round_1",
              name: "system.bash",
              arguments: '{"command":"echo","args":["phase-1"]}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"phase-1\\n","exitCode":0}',
          toolCallId: "call_round_1",
          toolName: "system.bash",
        },
      ],
      { stateful: { sessionId: "sess-multi-tool-rounds" } },
    );

    const third = await provider.chat(
      [
        { role: "user", content: "multi-step tool loop" },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_round_1",
              name: "system.bash",
              arguments: '{"command":"echo","args":["phase-1"]}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"stdout":"phase-1\\n","exitCode":0}',
          toolCallId: "call_round_1",
          toolName: "system.bash",
        },
        {
          role: "assistant",
          content: "",
          phase: "commentary",
          toolCalls: [
            {
              id: "call_round_2",
              name: "system.readFile",
              arguments: '{"path":"phase-1.txt"}',
            },
          ],
        },
        {
          role: "tool",
          content: '{"content":"phase-2 complete","path":"phase-1.txt"}',
          toolCallId: "call_round_2",
          toolName: "system.readFile",
        },
      ],
      { stateful: { sessionId: "sess-multi-tool-rounds" } },
    );

    const thirdParams = mockCreate.mock.calls[2][0];
    const thirdInput = JSON.stringify(thirdParams.input);

    expect(thirdParams.previous_response_id).toBe("resp_round_2");
    expect(third.requestMetrics?.statefulInputMode).toBe("incremental_delta");
    expect(third.requestMetrics?.statefulOmittedMessageCount).toBeGreaterThan(1);
    expect(thirdInput).not.toContain("multi-step tool loop");
    expect(thirdInput).not.toContain("phase-1\\n");
    expect(thirdInput).toContain("phase-2 complete");
  });

  it("does not emit undocumented server-side compaction fields when local compaction is configured", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion({ id: "resp_compact_req" }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        compaction: {
          enabled: true,
          compactThreshold: 12_000,
        },
      },
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { stateful: { sessionId: "sess-compact" } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.context_management).toBeUndefined();
    expect(response.compaction).toBeUndefined();
  });

  it("emits only xAI-documented top-level Responses fields", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion({ id: "resp_documented_fields" }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      maxTokens: 128,
      temperature: 0.2,
      parallelToolCalls: true,
      statefulResponses: {
        enabled: true,
        store: true,
        compaction: {
          enabled: true,
          compactThreshold: 12_000,
        },
      },
      tools: [
        {
          type: "function",
          function: {
            name: "system.readFile",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
    });

    await provider.chat(
      [{ role: "user", content: "hello" }],
      {
        toolChoice: "required",
        stateful: { sessionId: "sess-documented-fields" },
      },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(Object.keys(params).every((key) => DOCUMENTED_XAI_RESPONSES_FIELDS.has(key))).toBe(
      true,
    );
  });

  it("does not emit undocumented assistant phase metadata into xAI response input items", async () => {
    mockCreate.mockResolvedValueOnce(makeCompletion({ id: "resp_no_phase" }));

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
      },
    });

    await provider.chat([
      { role: "user", content: "first" },
      { role: "assistant", content: "working", phase: "commentary" },
      { role: "user", content: "continue" },
    ]);

    const params = mockCreate.mock.calls[0][0];
    expect(JSON.stringify(params.input)).not.toContain("\"phase\"");
  });

  it("keeps continuation behavior stable with and without local compaction config", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_plain_1",
          output_text: "Plain first",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_plain_2",
          output_text: "Stable follow-up",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_compact_1",
          output_text: "Compact first",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_compact_2",
          output_text: "Stable follow-up",
        }),
      );

    const plainProvider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });
    const compactProvider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
        compaction: {
          enabled: true,
          compactThreshold: 10_000,
        },
      },
    });

    await plainProvider.chat(
      [{ role: "user", content: "first" }],
      { stateful: { sessionId: "sess-ab-plain" } },
    );
    const plainFollowUp = await plainProvider.chat(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "Plain first", phase: "final_answer" },
        { role: "user", content: "continue" },
      ],
      { stateful: { sessionId: "sess-ab-plain" } },
    );

    await compactProvider.chat(
      [{ role: "user", content: "first" }],
      { stateful: { sessionId: "sess-ab-compact" } },
    );
    const compactFollowUp = await compactProvider.chat(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "Compact first", phase: "final_answer" },
        { role: "user", content: "continue" },
      ],
      { stateful: { sessionId: "sess-ab-compact" } },
    );

    expect(plainFollowUp.content).toBe("Stable follow-up");
    expect(compactFollowUp.content).toBe("Stable follow-up");
    expect(mockCreate.mock.calls[1][0].previous_response_id).toBe("resp_plain_1");
    expect(mockCreate.mock.calls[1][0].context_management).toBeUndefined();
    expect(mockCreate.mock.calls[3][0].previous_response_id).toBe("resp_compact_1");
    expect(mockCreate.mock.calls[3][0].context_management).toBeUndefined();
    expect(compactFollowUp.compaction).toBeUndefined();
  });

  it("falls back stateless on reconciliation mismatch and emits mismatch diagnostics", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_1",
          output_text: "First",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_2",
          output_text: "Fresh",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "first turn" },
      ],
      { stateful: { sessionId: "sess-mismatch" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "totally different turn" },
      ],
      { stateful: { sessionId: "sess-mismatch" } },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBeUndefined();
    expect(second.stateful?.fallbackReason).toBe("state_reconciliation_mismatch");
    expect(second.stateful?.previousReconciliationHash).toBeDefined();
    expect(second.stateful?.reconciliationMessageCount).toBe(1);
    expect(second.stateful?.reconciliationSource).toBe("non_system_messages");
    expect(second.stateful?.anchorMatched).toBe(false);
    expect(second.stateful?.events?.some((event) =>
      event.type === "state_reconciliation_mismatch"
    )).toBe(true);
  });

  it("trusts a known local compaction boundary and keeps previous_response_id", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_compacted_1",
          output_text: "Stored",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_compacted_2",
          output_text: "Resumed after compaction",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "first turn" },
      ],
      { stateful: { sessionId: "sess-compacted-trust" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "[Compacted: 51 earlier messages removed]" },
        { role: "user", content: "follow up after local compaction" },
      ],
      {
        stateful: {
          sessionId: "sess-compacted-trust",
          historyCompacted: true,
        },
      },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBe("resp_compacted_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(false);
    expect(second.stateful?.historyCompacted).toBe(true);
    expect(second.stateful?.compactedHistoryTrusted).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("retries stateless when previous_response_id retrieval fails", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_1",
          output_text: "First",
        }),
      )
      .mockRejectedValueOnce({
        status: 404,
        message: "previous_response_id not found",
      })
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_3",
          output_text: "Recovered",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-stale" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "First" },
        { role: "user", content: "continue" },
      ],
      { stateful: { sessionId: "sess-stale" } },
    );

    expect(mockCreate).toHaveBeenCalledTimes(3);
    const attemptedParams = mockCreate.mock.calls[1][0];
    const retryParams = mockCreate.mock.calls[2][0];
    expect(attemptedParams.previous_response_id).toBe("resp_1");
    expect(retryParams.previous_response_id).toBeUndefined();
    expect(second.stateful?.fallbackReason).toBe("provider_retrieval_failure");
    expect(second.stateful?.events?.some((event) =>
      event.reason === "provider_retrieval_failure"
    )).toBe(true);
  });

  it("falls back with missing_previous_response_id after provider restart", async () => {
    mockCreate.mockResolvedValue(
      makeCompletion({
        id: "resp_restart",
        output_text: "Stateless",
      }),
    );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    const response = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "assistant", content: "previous local history only" },
        { role: "user", content: "continue after restart" },
      ],
      { stateful: { sessionId: "sess-restart" } },
    );

    const params = mockCreate.mock.calls[0][0];
    expect(params.previous_response_id).toBeUndefined();
    expect(response.stateful?.fallbackReason).toBe(
      "missing_previous_response_id",
    );
  });

  it("uses a persisted resume anchor after provider restart", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_anchor",
          output_text: "Hello",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_resumed",
          output_text: "Resumed",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    const first = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      { stateful: { sessionId: "sess-resume" } },
    );
    provider.clearSessionState();

    const response = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "continue after restart" },
      ],
      {
        stateful: {
          sessionId: "sess-resume",
          resumeAnchor: {
            previousResponseId: "resp_anchor",
            reconciliationHash: first.stateful?.reconciliationHash,
          },
        },
      },
    );

    const params = mockCreate.mock.calls[1][0];
    expect(params.previous_response_id).toBe("resp_anchor");
    expect(response.stateful?.continued).toBe(true);
    expect(response.stateful?.responseId).toBe("resp_resumed");
  });

  it("continues statefully across changing system context injections", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_dynamic_1",
          output_text: "Stored",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_dynamic_2",
          output_text: "BLACK-ORBIT|8771|SIGMA-42",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Stateful continuity test A3" },
      ],
      { stateful: { sessionId: "sess-dynamic-context" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "system", content: "## Recent Progress\nupdated working summary" },
        { role: "user", content: "Stateful continuity test A3" },
        { role: "assistant", content: "Stored", phase: "final_answer" },
        { role: "user", content: "Stateful continuity test B3" },
      ],
      { stateful: { sessionId: "sess-dynamic-context" } },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBe("resp_dynamic_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(true);
    expect(second.stateful?.reconciliationMessageCount).toBe(3);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("continues statefully when reconciliation history replays assistant commentary", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_commentary_1",
          output_text: "**BLOCKED**: missing grounded evidence",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_commentary_2",
          output_text: "Recovered",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [{ role: "user", content: "Implement the delegated phase." }],
      { stateful: { sessionId: "sess-commentary-retry" } },
    );
    const second = await provider.chat(
      [{ role: "system", content: "Retry with tool-grounded evidence." }],
      {
        stateful: {
          sessionId: "sess-commentary-retry",
          reconciliationMessages: [
            { role: "user", content: "Implement the delegated phase." },
            {
              role: "assistant",
              content: "**BLOCKED**: missing grounded evidence",
              phase: "commentary",
            },
            { role: "system", content: "Retry with tool-grounded evidence." },
          ],
        },
      },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBe("resp_commentary_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("uses reconciliationMessages when prompt budgeting trims the provider payload", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_trim_1",
          output_text: "Stored",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_trim_2",
          output_text: "Resumed",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Stateful continuity test A5" },
      ],
      { stateful: { sessionId: "sess-trimmed-reconciliation" } },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Stateful continuity test B5" },
      ],
      {
        stateful: {
          sessionId: "sess-trimmed-reconciliation",
          reconciliationMessages: [
            { role: "system", content: "# Agent Configuration\nstatic prompt" },
            { role: "user", content: "Stateful continuity test A5" },
            { role: "assistant", content: "Stored", phase: "final_answer" },
            { role: "user", content: "Stateful continuity test B5" },
          ],
        },
      },
    );

    const secondParams = mockCreate.mock.calls[1][0];
    expect(secondParams.previous_response_id).toBe("resp_trim_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(true);
    expect(second.stateful?.reconciliationMessageCount).toBe(3);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });

  it("persists stateful anchors from reconciliationMessages when the first replay turn is already prompt-trimmed", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_trimmed_anchor_1",
          output_text: "Continued from trimmed replay",
        }),
      )
      .mockResolvedValueOnce(
        makeCompletion({
          id: "resp_trimmed_anchor_2",
          output_text: "Resumed safely",
        }),
      );

    const provider = new GrokProvider({
      apiKey: "test-key",
      statefulResponses: {
        enabled: true,
        store: true,
        fallbackToStateless: true,
      },
    });

    await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Implement phase two only." },
      ],
      {
        stateful: {
          sessionId: "sess-trimmed-anchor-persist",
          reconciliationMessages: [
            { role: "system", content: "# Agent Configuration\nstatic prompt" },
            { role: "user", content: "Implement phase one." },
            {
              role: "assistant",
              content: "Phase one complete.",
              phase: "final_answer",
            },
            { role: "user", content: "Implement phase two only." },
          ],
        },
      },
    );
    const second = await provider.chat(
      [
        { role: "system", content: "# Agent Configuration\nstatic prompt" },
        { role: "user", content: "Add tests for phases one and two." },
      ],
      {
        stateful: {
          sessionId: "sess-trimmed-anchor-persist",
          reconciliationMessages: [
            { role: "system", content: "# Agent Configuration\nstatic prompt" },
            { role: "user", content: "Implement phase one." },
            {
              role: "assistant",
              content: "Phase one complete.",
              phase: "final_answer",
            },
            { role: "user", content: "Implement phase two only." },
            {
              role: "assistant",
              content: "Continued from trimmed replay",
              phase: "final_answer",
            },
            { role: "user", content: "Add tests for phases one and two." },
          ],
        },
      },
    );

    const firstParams = mockCreate.mock.calls[0][0];
    const secondParams = mockCreate.mock.calls[1][0];
    expect(firstParams.previous_response_id).toBeUndefined();
    expect(secondParams.previous_response_id).toBe("resp_trimmed_anchor_1");
    expect(second.stateful?.continued).toBe(true);
    expect(second.stateful?.anchorMatched).toBe(true);
    expect(second.stateful?.fallbackReason).toBeUndefined();
  });
});
