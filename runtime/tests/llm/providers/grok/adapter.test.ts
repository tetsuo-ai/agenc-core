import { describe, expect, test, vi } from "vitest";

import type { LLMMessage, LLMTool } from "../../types.js";
import { LLMTimeoutError } from "../../errors.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER } from "../../wire/shared.js";
import { DEFAULT_REQUEST_OPEN_TIMEOUT_MS, GrokProvider } from "./adapter.js";

function buildXaiResponse(id: string, text: string): Record<string, unknown> {
  return {
    id,
    status: "completed",
    incomplete_details: null,
    model: "grok-4-fast",
    output_text: text,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
  };
}

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

function withResponse<T>(data: T) {
  return {
    withResponse: async () => ({
      data,
      response: new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      request_id: null,
    }),
  };
}

function streamFromEvents(
  events: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function streamFromEventsThenThrow(
  events: readonly Record<string, unknown>[],
  error: Error,
): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
      throw error;
    },
  };
}

function useDeterministicFallbackTimers(): () => void {
  vi.useFakeTimers();
  const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  return () => {
    randomSpy.mockRestore();
    vi.useRealTimers();
  };
}

describe("GrokProvider incremental continuation", () => {
  const previousMessages: LLMMessage[] = [
    { role: "user", content: "hello" },
  ];
  const currentMessages: LLMMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "follow up" },
  ];

  test("single-wire chat disables SDK and OAuth-refresh retries", async () => {
    const refreshBearer = vi.fn().mockResolvedValue({
      kind: "refreshed",
      bearer: "xai-refreshed",
    });
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    }).withAuthRefreshCallbacks({ refreshBearer });
    const unauthorized = Object.assign(new Error("unauthorized"), {
      status: 401,
    });
    const create = vi.fn().mockImplementation(
      (_params: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
        expect(requestOptions).toMatchObject({ maxRetries: 0 });
        throw unauthorized;
      },
    );
    (provider as any).client = { responses: { create } };

    await expect(
      provider.chat(
        [{ role: "user", content: "hello" }],
        { singleWireAttempt: true },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(refreshBearer).not.toHaveBeenCalled();
  });

  test("single-wire chat does not retry an expired continuation", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      emitWarning: (warning) => warnings.push(warning),
    });
    (provider as any).incrementalTracker.recordRequest(
      (provider as any).buildIncrementalRequestShape({
        model: "grok-4-fast",
        store: false,
      }),
      previousMessages,
    );
    (provider as any).incrementalTracker.recordResponse({
      previousResponseId: "resp_single_wire",
      itemsAdded: [{ role: "assistant", content: "hi" }],
      recordedAtMs: Date.now(),
    });
    const create = vi.fn().mockImplementation(
      (params: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
        expect(params.previous_response_id).toBe("resp_single_wire");
        expect(requestOptions).toMatchObject({ maxRetries: 0 });
        throw Object.assign(new Error("previous_response_id expired"), {
          status: 404,
        });
      },
    );
    (provider as any).client = { responses: { create } };

    await expect(
      provider.chat(currentMessages, { singleWireAttempt: true }),
    ).rejects.toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(warnings).not.toContainEqual(
      expect.objectContaining({ cause: "previous_response_id_expired" }),
    );
  });

  test("single-wire stream hands fallback outward after one SDK request", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      providerFallback: {
        provider: "grok",
        model: "grok-4-fast",
        targets: [{ provider: "openai", model: "gpt-5" }],
      },
    });
    const overloaded = Object.assign(new Error("overloaded"), { status: 529 });
    const create = vi.fn().mockImplementation(
      (_params: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
        expect(requestOptions).toMatchObject({ maxRetries: 0 });
        return withResponse(streamFromEventsThenThrow([], overloaded));
      },
    );
    (provider as any).client = { responses: { create } };

    await expect(
      provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
        { singleWireAttempt: true },
      ),
    ).rejects.toMatchObject({ name: "FallbackTriggeredError" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("stream cancellation waits for the pending physical read after return settles", async () => {
    const pendingRead = Promise.withResolvers<
      IteratorResult<Record<string, unknown>>
    >();
    const iterator = {
      next: vi.fn(() => pendingRead.promise),
      return: vi.fn(async () => ({
        done: true as const,
        value: undefined,
      })),
    };
    const stream: AsyncIterable<Record<string, unknown>> = {
      [Symbol.asyncIterator]: () => iterator,
    };
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    });
    (provider as any).client = {
      responses: { create: vi.fn(() => withResponse(stream)) },
    };
    const controller = new AbortController();
    let settled = false;

    const running = provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => {},
      { signal: controller.signal, singleWireAttempt: true },
    );
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledTimes(1));
    controller.abort("cancel stream");
    await vi.waitFor(() => expect(iterator.return).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);

    pendingRead.resolve({ done: true, value: undefined });
    await expect(running).rejects.toBeDefined();
  });

  test("triggers configured fallback after repeated chat overloads", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      providerFallback: {
        provider: "grok",
        model: "grok-4-fast",
        targets: [{ provider: "openai", model: "gpt-5" }],
      },
    });
    const overloaded = Object.assign(new Error("overloaded"), { status: 529 });
    const create = vi.fn().mockImplementation(() => {
      throw overloaded;
    });
    (provider as any).client = {
      responses: { create },
    };

    try {
      const pending = provider.chat(
        [{ role: "user", content: "hello" }],
        { model: "grok-4-reviewer" },
      );
      const assertion = expect(pending).rejects.toMatchObject({
        name: "FallbackTriggeredError",
        fromProvider: "grok",
        toProvider: "openai",
        fromModel: "grok-4-reviewer",
        toModel: "gpt-5",
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(create).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      restoreTimers();
    }
  });

  test("triggers configured fallback after repeated stream overloads", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      providerFallback: {
        provider: "grok",
        model: "grok-4-fast",
        targets: [{ provider: "openai", model: "gpt-5" }],
      },
    });
    const overloaded = Object.assign(new Error("overloaded"), { status: 529 });
    const create = vi.fn().mockImplementation(() => {
      throw overloaded;
    });
    (provider as any).client = {
      responses: { create },
    };

    try {
      const pending = provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
        { model: "grok-4-reviewer" },
      );
      const assertion = expect(pending).rejects.toMatchObject({
        name: "FallbackTriggeredError",
        fromProvider: "grok",
        toProvider: "openai",
        fromModel: "grok-4-reviewer",
        toModel: "gpt-5",
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(create).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      restoreTimers();
    }
  });

  test("bounds fallback waits by provider retry budget", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      maxRetries: 1,
      providerFallback: {
        provider: "grok",
        model: "grok-4-fast",
        targets: [{ provider: "openai", model: "gpt-5" }],
        maxFailures: 5,
      },
    });
    const overloaded = Object.assign(new Error("overloaded"), { status: 529 });
    const create = vi.fn().mockImplementation(() => {
      throw overloaded;
    });
    (provider as any).client = {
      responses: { create },
    };

    try {
      const pending = provider.chat([{ role: "user", content: "hello" }]);
      const assertion = expect(pending).rejects.toThrow("overloaded");

      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      restoreTimers();
    }
  });

  test("does not trigger stream fallback after partial output", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      providerFallback: {
        provider: "grok",
        model: "grok-4-fast",
        targets: [{ provider: "openai", model: "gpt-5" }],
      },
    });
    const overloaded = Object.assign(new Error("overloaded"), { status: 529 });
    let attempt = 0;
    const create = vi.fn().mockImplementation(() => {
      attempt += 1;
      if (attempt < 3) {
        throw overloaded;
      }
      return withResponse(
        streamFromEventsThenThrow(
          [{ type: "response.output_text.delta", delta: "partial" }],
          overloaded,
        ),
      );
    });
    (provider as any).client = {
      responses: { create },
    };

    try {
      const pending = provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );

      await vi.advanceTimersByTimeAsync(1500);
      const response = await pending;
      expect(response.content).toBe("partial");
      expect(response.error).toMatchObject({ statusCode: 529 });
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      restoreTimers();
    }
  });

  test("honors request-scoped model overrides when building requests", () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    });

    const built = (provider as any).buildRequestPlan(previousMessages, {
      model: "grok-4-0709",
    });

    expect(built.params.model).toBe("grok-4-0709");
  });

  function planWithTools(parallelToolCalls?: boolean) {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      tools: [TEST_TOOL],
      ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    });
    return (provider as any).buildRequestPlan(previousMessages);
  }

  test("sends parallel_tool_calls: true by default when tools are attached", () => {
    const built = planWithTools();

    expect(built.params.tools).toHaveLength(1);
    expect(built.params.parallel_tool_calls).toBe(true);
  });

  test("parallelToolCalls: false still pins one tool call per turn", () => {
    expect(planWithTools(false).params.parallel_tool_calls).toBe(false);
  });

  test("reuses previous_response_id and retries chat with full history on expiry", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      emitWarning: (warning) => warnings.push(warning),
    });

    (provider as any).incrementalTracker.recordRequest(
      (provider as any).buildIncrementalRequestShape({
        model: "grok-4-fast",
        store: false,
      }),
      previousMessages,
    );
    (provider as any).incrementalTracker.recordResponse({
      previousResponseId: "resp_prev",
      itemsAdded: [{ role: "assistant", content: "hi" }],
      recordedAtMs: Date.now(),
    });

    const requestBodies: Record<string, unknown>[] = [];
    (provider as any).client = {
      responses: {
        create: vi
          .fn()
          .mockImplementationOnce((params: Record<string, unknown>) => {
            requestBodies.push(params);
            throw Object.assign(new Error("previous_response_id expired"), {
              status: 404,
            });
          })
          .mockImplementationOnce((params: Record<string, unknown>) => {
            requestBodies.push(params);
            return withResponse(buildXaiResponse("resp_next", "done"));
          }),
      },
    };

    const result = await provider.chat(currentMessages);

    expect(result.content).toBe("done");
    expect(requestBodies[0]?.previous_response_id).toBe("resp_prev");
    expect(JSON.stringify(requestBodies[0]?.input)).toContain("follow up");
    expect(JSON.stringify(requestBodies[0]?.input)).not.toContain("hello");
    expect(requestBodies[1]?.previous_response_id).toBeUndefined();
    expect(JSON.stringify(requestBodies[1]?.input)).toContain("hello");
    expect(JSON.stringify(requestBodies[1]?.input)).toContain("follow up");
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "previous_response_id_expired",
      }),
    );
  });

  test("reuses previous_response_id and retries streaming with full history on expiry", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      emitWarning: (warning) => warnings.push(warning),
    });

    (provider as any).incrementalTracker.recordRequest(
      (provider as any).buildIncrementalRequestShape({
        model: "grok-4-fast",
        store: false,
      }),
      previousMessages,
    );
    (provider as any).incrementalTracker.recordResponse({
      previousResponseId: "resp_prev_stream",
      itemsAdded: [{ role: "assistant", content: "hi" }],
      recordedAtMs: Date.now(),
    });

    const requestBodies: Record<string, unknown>[] = [];
    (provider as any).client = {
      responses: {
        create: vi
          .fn()
          .mockImplementationOnce((params: Record<string, unknown>) => {
            requestBodies.push(params);
            throw Object.assign(new Error("previous response not found"), {
              status: 404,
            });
          })
          .mockImplementationOnce((params: Record<string, unknown>) => {
            requestBodies.push(params);
            return withResponse(
              streamFromEvents([
                {
                  type: "response.completed",
                  response: buildXaiResponse("resp_stream_next", "stream done"),
                },
              ]),
            );
          }),
      },
    };

    const chunks: string[] = [];
    const result = await provider.chatStream(
      currentMessages,
      (chunk) => {
        if (chunk.content.length > 0) {
          chunks.push(chunk.content);
        }
      },
    );

    expect(result.content).toBe("stream done");
    // Since the stream-resilience change (bbf85192f), a completed response
    // whose stream produced no output_text.delta emits its envelope text as
    // one streaming chunk too — a delta-less xAI stream must not render a
    // successful-but-blank turn.
    expect(chunks).toEqual(["stream done"]);
    expect(requestBodies[0]?.previous_response_id).toBe("resp_prev_stream");
    expect(JSON.stringify(requestBodies[0]?.input)).toContain("follow up");
    expect(JSON.stringify(requestBodies[0]?.input)).not.toContain("hello");
    expect(requestBodies[1]?.previous_response_id).toBeUndefined();
    expect(JSON.stringify(requestBodies[1]?.input)).toContain("hello");
    expect(JSON.stringify(requestBodies[1]?.input)).toContain("follow up");
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "previous_response_id_expired",
      }),
    );
  });

  test("preserves large tool result bodies in function_call_output input items", () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    });

    const largeReadResult = [
      "1→# AgenC Shell Implementation Plan",
      "",
      `${"plan-line ".repeat(1200)}`,
      "1251→If this plan and the implementation ever disagree, the implementation is wrong until the plan and decision log are updated together.",
    ].join("\n");

    const built = (provider as any).buildRequestPlan([
      { role: "user", content: "can you read PLAN.md" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_plan",
            name: "FileRead",
            arguments: JSON.stringify({ path: "PLAN.md" }),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_plan",
        toolName: "FileRead",
        content: largeReadResult,
      },
    ] satisfies LLMMessage[]);

    const functionCallOutput = (built.params.input as Array<Record<string, unknown>>)
      .find((item) => item.type === "function_call_output");

    expect(functionCallOutput).toBeDefined();
    expect(functionCallOutput?.call_id).toBe("call_read_plan");
    expect(functionCallOutput?.output).toBe(largeReadResult);
    expect(String(functionCallOutput?.output)).toContain(
      "AgenC Shell Implementation Plan",
    );
    expect(String(functionCallOutput?.output)).toContain(
      "implementation is wrong until the plan and decision log are updated together.",
    );
  });

  test("does not retry completed text responses with tool_choice none", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      tools: [TEST_TOOL],
    });
    const text =
      "**Extending ShellState for M5: Adding shopt map. Writing shopt.h first.**";
    const requestBodies: Record<string, unknown>[] = [];
    const create = vi.fn((params: Record<string, unknown>) => {
      requestBodies.push(params);
      return withResponse(buildXaiResponse("resp_text", text));
    });
    (provider as any).client = {
      responses: { create },
    };

    const result = await provider.chat([
      { role: "user", content: "read state" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_state",
            name: "FileRead",
            arguments: JSON.stringify({ file_path: "include/agenc/state.h" }),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_state",
        toolName: "FileRead",
        content: "state header",
      },
    ]);

    expect(result.content).toBe(text);
    expect(create).toHaveBeenCalledTimes(1);
    expect(requestBodies[0]?.tool_choice).not.toBe("none");
  });

  test("carries xAI usage details into LLMUsage", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    });
    const create = vi.fn(() =>
      withResponse({
        ...buildXaiResponse("resp_usage", "searched"),
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
        server_side_tool_usage: {
          SERVER_SIDE_TOOL_WEB_SEARCH: 2,
        },
      })
    );
    (provider as any).client = {
      responses: { create },
    };

    const result = await provider.chat([{ role: "user", content: "search" }]);

    expect(result.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 4,
      reasoningOutputTokens: 3,
      webSearchRequests: 2,
    });
  });

  test("streamed usage is last-cumulative-wins, never a sum across events", async () => {
    // xAI streams usage snapshots as CUMULATIVE totals; a stream can carry
    // usage on more than one event (in_progress snapshots plus the final
    // response.completed). Per-turn usage must equal the FINAL cumulative
    // value — summing the snapshots would blow up quadratically (the
    // absurd "+900M cached" family of readings). Pins exactly-once
    // per-response usage accounting at the adapter boundary.
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    });
    const finalUsage = {
      input_tokens: 48_892,
      output_tokens: 169,
      total_tokens: 49_061,
      input_tokens_details: { cached_tokens: 46_720 },
      output_tokens_details: { reasoning_tokens: 15 },
    };
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "response.in_progress",
            response: {
              ...buildXaiResponse("resp_usage_stream", ""),
              status: "in_progress",
              usage: {
                input_tokens: 48_892,
                output_tokens: 40,
                total_tokens: 48_932,
                input_tokens_details: { cached_tokens: 46_720 },
              },
            },
          },
          { type: "response.output_text.delta", delta: "part one " },
          { type: "response.output_text.delta", delta: "part two" },
          {
            type: "response.completed",
            response: {
              ...buildXaiResponse("resp_usage_stream", "part one part two"),
              usage: finalUsage,
            },
          },
        ]),
      )
    );
    (provider as any).client = { responses: { create } };

    const result = await provider.chatStream(
      [{ role: "user", content: "go" }],
      () => {},
    );

    expect(result.usage).toMatchObject({
      promptTokens: 48_892,
      completionTokens: 169,
      totalTokens: 49_061,
      cachedInputTokens: 46_720,
      reasoningOutputTokens: 15,
    });
    // Guard the failure mode explicitly: any summing across the two
    // usage-bearing events would exceed the final cumulative values.
    expect(result.usage.totalTokens).toBeLessThanOrEqual(49_061);
    expect(result.usage.cachedInputTokens).toBeLessThanOrEqual(46_720);
  });

  test("does not replace streamed text with a tool-disabled retry", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      tools: [TEST_TOOL],
    });
    const text =
      "**Extending ShellState for M5: Adding shopt map. Writing shopt.h first.**";
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "response.output_text.delta",
            delta: text,
          },
          {
            type: "response.completed",
            response: buildXaiResponse("resp_stream_text", text),
          },
        ]),
      )
    );
    (provider as any).client = {
      responses: { create },
    };
    const chunks: string[] = [];

    const result = await provider.chatStream(
      [
        { role: "user", content: "read state" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_read_state",
              name: "FileRead",
              arguments: JSON.stringify({ file_path: "include/agenc/state.h" }),
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_read_state",
          toolName: "FileRead",
          content: "state header",
        },
      ],
      (chunk) => {
        if (chunk.content.length > 0) chunks.push(chunk.content);
      },
    );

    expect(result.content).toBe(text);
    expect(chunks).toEqual([text]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("surfaces xAI stream error events as provider errors", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    });
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "error",
            message:
              "Service temporarily unavailable. The model is at capacity.",
          },
        ]),
      )
    );
    (provider as any).client = {
      responses: { create },
    };

    const result = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => {},
    );

    expect(result.content).toBe("");
    expect(result.finishReason).toBe("error");
    expect(result.error?.name).toBe("LLMServerError");
    expect(result.error?.message).toContain("model is at capacity");
    expect(result.usage).toMatchObject({
      totalTokens: 0,
      availability: "unknown",
      provenance: "synthetic",
    });
  });
});

describe("GrokProvider streaming incremental continuation (AGENC_XAI_INCREMENTAL)", () => {
  const firstTurn: LLMMessage[] = [{ role: "user", content: "hello" }];
  const secondTurn: LLMMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "follow up" },
  ];
  const systemPromptAt = (clock: string): string =>
    `Static instructions.${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}Current time: ${clock}`;

  function streamingProvider(incrementalContinuation: boolean | undefined) {
    const warnings: Array<{ cause: string; message: string }> = [];
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      emitWarning: (warning) => warnings.push(warning),
      ...(incrementalContinuation !== undefined
        ? { incrementalContinuation }
        : {}),
    });
    const requestBodies: Record<string, unknown>[] = [];
    const create = vi.fn((params: Record<string, unknown>) => {
      requestBodies.push(params);
      const ordinal = requestBodies.length;
      return withResponse(
        streamFromEvents([
          {
            type: "response.completed",
            response: buildXaiResponse(
              `resp_${ordinal}`,
              ordinal === 1 ? "hi" : "done",
            ),
          },
        ]),
      );
    });
    (provider as any).client = { responses: { create } };
    return { provider, requestBodies, create, warnings };
  }

  test("the second streaming request carries previous_response_id and only the delta", async () => {
    const { provider, requestBodies } = streamingProvider(true);

    await provider.chatStream(firstTurn, () => {}, {
      systemPrompt: systemPromptAt("noon"),
    });
    await provider.chatStream(secondTurn, () => {}, {
      systemPrompt: systemPromptAt("one"),
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.previous_response_id).toBeUndefined();
    expect(JSON.stringify(requestBodies[0]?.input)).toContain("Static instructions");
    expect(requestBodies[1]?.previous_response_id).toBe("resp_1");
    const delta = JSON.stringify(requestBodies[1]?.input);
    // Only the items added since the stored response, plus the fresh dynamic
    // tail; the static system prompt and the earlier turns live server-side.
    expect(delta).toContain("follow up");
    expect(delta).toContain("Current time: one");
    expect(delta).not.toContain("hello");
    expect(delta).not.toContain("Static instructions");
    expect(delta).not.toContain("Current time: noon");
  });

  test("stays off by default: every streaming request re-sends the full history", async () => {
    const { provider, requestBodies } = streamingProvider(undefined);

    await provider.chatStream(firstTurn, () => {}, {
      systemPrompt: systemPromptAt("noon"),
    });
    await provider.chatStream(secondTurn, () => {}, {
      systemPrompt: systemPromptAt("one"),
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]?.previous_response_id).toBeUndefined();
    const full = JSON.stringify(requestBodies[1]?.input);
    expect(full).toContain("hello");
    expect(full).toContain("follow up");
    expect(full).toContain("Static instructions");
  });

  test("a single-wire attempt that loses its continuation clears the tracker for the next attempt", async () => {
    const { provider, requestBodies, create, warnings } = streamingProvider(true);
    await provider.chatStream(firstTurn, () => {}, {
      systemPrompt: systemPromptAt("noon"),
    });
    expect((provider as any).incrementalTracker.previousResponseId()).toBe("resp_1");

    create.mockImplementationOnce((params: Record<string, unknown>) => {
      requestBodies.push(params);
      throw Object.assign(new Error("previous response not found"), {
        status: 404,
      });
    });

    await expect(
      provider.chatStream(secondTurn, () => {}, {
        systemPrompt: systemPromptAt("one"),
        singleWireAttempt: true,
      }),
    ).rejects.toBeDefined();

    // One rejected wire attempt, no in-band retry, continuation cleared so
    // the reconnect ladder's next admitted attempt sends full history.
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]?.previous_response_id).toBe("resp_1");
    expect((provider as any).incrementalTracker.previousResponseId()).toBeUndefined();
    expect(warnings).toContainEqual(
      expect.objectContaining({ cause: "previous_response_id_expired" }),
    );
  });
});

describe("GrokProvider stream timeout semantics", () => {
  // Chunks arrive `gapMs` after the previous chunk is consumed, so the
  // stream is never idle for longer than `gapMs` even though its total
  // duration is `events.length * gapMs`.
  function steadilyChunkingStream(
    events: readonly Record<string, unknown>[],
    gapMs: number,
  ): AsyncIterable<Record<string, unknown>> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          yield event;
        }
      },
    };
  }

  test("an unconfigured stream survives a six-hour silent chunk gap", async () => {
    vi.useFakeTimers();
    try {
      const sixHours = 6 * 60 * 60_000;
      const provider = new GrokProvider({
        apiKey: "xai-test",
        model: "grok-4-fast",
      });
      const create = vi.fn().mockImplementation(() =>
        withResponse({
          async *[Symbol.asyncIterator]() {
            yield { type: "response.output_text.delta", delta: "one " };
            await new Promise((resolve) => setTimeout(resolve, sixHours));
            yield { type: "response.output_text.delta", delta: "two" };
            yield {
              type: "response.completed",
              response: buildXaiResponse(
                "resp_unbounded_silent_stream",
                "one two",
              ),
            };
          },
        }),
      );
      (provider as any).client = { responses: { create } };

      const resultPromise = provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );
      resultPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(sixHours + 1);

      await expect(resultPromise).resolves.toMatchObject({
        content: "one two",
        finishReason: "stop",
      });
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an unconfigured request whose headers never arrive aborts at the request-open default", async () => {
    vi.useFakeTimers();
    try {
      const provider = new GrokProvider({
        apiKey: "xai-test",
        model: "grok-4-fast",
      });
      // The SDK request honours the abort signal but never produces headers:
      // the shape of a half-open TCP connection.
      const create = vi.fn(
        (_params: Record<string, unknown>, requestOptions: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            requestOptions.signal?.addEventListener(
              "abort",
              () => reject(requestOptions.signal?.reason ?? new Error("aborted")),
              { once: true },
            );
          }),
      );
      (provider as any).client = { responses: { create } };

      const resultPromise = provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );
      let settled = false;
      const outcome = resultPromise.then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      void outcome.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_OPEN_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const error = await outcome;
      expect(error).toBeInstanceOf(LLMTimeoutError);
      expect(error).toMatchObject({ timeoutMs: DEFAULT_REQUEST_OPEN_TIMEOUT_MS });
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an explicit timeout_ms of 0 keeps the request-open phase unbounded", async () => {
    vi.useFakeTimers();
    try {
      const provider = new GrokProvider({
        apiKey: "xai-test",
        model: "grok-4-fast",
        timeoutMs: 0,
      });
      const headersGate = Promise.withResolvers<unknown>();
      const create = vi.fn(() => headersGate.promise);
      (provider as any).client = { responses: { create } };

      const resultPromise = provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );
      resultPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);

      // A bare promise has no withResponse(); the adapter awaits it and uses
      // the settled value as the stream itself.
      headersGate.resolve(
        streamFromEvents([
          {
            type: "response.completed",
            response: buildXaiResponse("resp_unbounded_open", "late but fine"),
          },
        ]),
      );
      await expect(resultPromise).resolves.toMatchObject({
        content: "late but fine",
        finishReason: "stop",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("bypasses the SDK's implicit ten-minute header timer", async () => {
    vi.useFakeTimers();
    try {
      const provider = new GrokProvider({
        apiKey: "xai-test",
        model: "grok-4-fast",
      });
      const client = await (provider as any).ensureClient();
      const responseGate = Promise.withResolvers<Response>();
      client.fetch = vi.fn(() => responseGate.promise);
      const controller = new AbortController();
      let settled = false;
      const request = client
        .fetchWithTimeout(
          "https://api.x.ai/v1/responses",
          { method: "POST" },
          600_000,
          controller,
        )
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
      expect(settled).toBe(false);
      expect(controller.signal.aborted).toBe(false);

      responseGate.resolve(new Response(null, { status: 200 }));
      await expect(request).resolves.toBeInstanceOf(Response);
    } finally {
      vi.useRealTimers();
    }
  });

  test("healthy stream longer than timeoutMs completes — timeout is inter-chunk idle, not a total deadline", async () => {
    // Revert guard: with the pre-0.7.3 streamDeadlineAt total-budget
    // semantics this stream is killed at t=1000ms mid-flight and the call
    // rejects; with idle semantics every chunk gap (600ms) is under the
    // 1000ms window and the stream completes.
    vi.useFakeTimers();
    try {
      const provider = new GrokProvider({
        apiKey: "xai-test",
        model: "grok-4-fast",
        timeoutMs: 1000,
      });
      const create = vi.fn().mockImplementation(() =>
        withResponse(
          steadilyChunkingStream(
            [
              { type: "response.output_text.delta", delta: "one " },
              { type: "response.output_text.delta", delta: "two " },
              { type: "response.output_text.delta", delta: "three" },
              {
                type: "response.completed",
                response: buildXaiResponse("resp_slow_stream", "one two three"),
              },
            ],
            600,
          ),
        ),
      );
      (provider as any).client = { responses: { create } };

      const deltas: string[] = [];
      const resultPromise = provider.chatStream(
        [{ role: "user", content: "hello" }],
        (chunk) => {
          if (typeof (chunk as { delta?: unknown }).delta === "string") {
            deltas.push((chunk as { delta: string }).delta);
          }
        },
      );
      // Surface rejections through the assertion below instead of an
      // unhandled-rejection crash while timers advance.
      resultPromise.catch(() => {});
      // 4 gaps x 600ms = 2400ms total stream time, well past the 1000ms
      // timeout that the old code treated as a wall-clock deadline.
      await vi.advanceTimersByTimeAsync(2600);
      const result = await resultPromise;
      expect(result.content).toBe("one two three");
      expect(result.finishReason).toBe("stop");
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stream idle past timeoutMs still aborts with the stalled error", async () => {
    vi.useFakeTimers();
    try {
      const provider = new GrokProvider({
        apiKey: "xai-test",
        model: "grok-4-fast",
        timeoutMs: 1000,
      });
      const create = vi.fn().mockImplementation(() =>
        withResponse({
          // Chunk two never arrives inside the idle window: the stream goes
          // silent for far longer than timeoutMs after chunk one.
          async *[Symbol.asyncIterator]() {
            yield { type: "response.output_text.delta", delta: "one " };
            await new Promise((resolve) => setTimeout(resolve, 60_000));
            yield { type: "response.output_text.delta", delta: "two" };
          },
        }),
      );
      (provider as any).client = { responses: { create } };

      const resultPromise = provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );
      resultPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1100);
      // The stalled abort retains admission until the pending physical read
      // settles; advance past the hung read so teardown can complete.
      await vi.advanceTimersByTimeAsync(60_000);
      // The adapter captures the stall in the result rather than rejecting:
      // partial content is preserved and the mapped timeout error is carried
      // on finishReason "error".
      const result = await resultPromise;
      expect(result.content).toBe("one ");
      expect(result.finishReason).toBe("error");
      expect(result.error?.name).toBe("LLMTimeoutError");
      expect(result.error).toMatchObject({ timeoutMs: 1000 });
    } finally {
      vi.useRealTimers();
    }
  });
});
