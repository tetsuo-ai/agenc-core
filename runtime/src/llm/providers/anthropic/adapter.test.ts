import { describe, expect, test, vi } from "vitest";
import { ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME } from "../../structured-output.js";
import { AnthropicProvider } from "./adapter.js";

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function useDeterministicFallbackTimers(): () => void {
  vi.useFakeTimers();
  const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  return () => {
    randomSpy.mockRestore();
    vi.useRealTimers();
  };
}

describe("AnthropicProvider", () => {
  test("propagates fallback trigger from chat requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
      providerFallback: {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
        maxFailures: 1,
      },
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "anthropic",
      toProvider: "grok",
      fromModel: "claude-3-7-sonnet",
      toModel: "grok-4-fast",
    });
  });

  test("binds fallback trigger to request-scoped chat model overrides", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
      providerFallback: {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
        maxFailures: 1,
      },
    });

    await expect(
      provider.chat(
        [{ role: "user", content: "hello" }],
        { model: "claude-reviewer" },
      ),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "anthropic",
      toProvider: "grok",
      fromModel: "claude-reviewer",
      toModel: "grok-4-fast",
    });
  });

  test("propagates fallback trigger from stream requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
      providerFallback: {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
        maxFailures: 1,
      },
    });

    await expect(
      provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      ),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "anthropic",
      toProvider: "grok",
      fromModel: "claude-3-7-sonnet",
      toModel: "grok-4-fast",
    });
  });

  test("triggers fallback from repeated stream overload events", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        sseResponse([
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
        ]),
      )
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
      providerFallback: {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
      },
    });

    try {
      const pending = provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );
      const assertion = expect(pending).rejects.toMatchObject({
        name: "FallbackTriggeredError",
        fromProvider: "anthropic",
        toProvider: "grok",
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      restoreTimers();
    }
  });

  test("triggers fallback from default-threshold stream HTTP overloads", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 529,
          headers: { "content-type": "application/json" },
        }),
      )
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
      providerFallback: {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
      },
    });

    try {
      const pending = provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );
      const assertion = expect(pending).rejects.toMatchObject({
        name: "FallbackTriggeredError",
        fromProvider: "anthropic",
        toProvider: "grok",
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      restoreTimers();
    }
  });

  test("does not trigger stream fallback after partial message output", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    let attempt = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      attempt += 1;
      if (attempt < 3) {
        return Promise.resolve(
          sseResponse([
            'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
          ]),
        );
      }
      return Promise.resolve(
        sseResponse([
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
        ]),
      );
    });
    const chunks: string[] = [];
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
      providerFallback: {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
      },
    });

    try {
      const pending = provider.chatStream(
        [{ role: "user", content: "hello" }],
        (chunk) => {
          if (chunk.content) chunks.push(chunk.content);
        },
      );
      const assertion = expect(pending).rejects.toThrow("busy");

      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(chunks).toEqual(["partial"]);
    } finally {
      restoreTimers();
    }
  });

  test("honors request-scoped model overrides on chat calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-reviewer",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "review" }],
      { model: "claude-reviewer" },
    );

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request.model).toBe("claude-reviewer");
    expect(response.model).toBe("claude-reviewer");
  });

  test("passes structured output through synthetic tool_use and parses the result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-3-7-sonnet",
          content: [
            {
              type: "tool_use",
              id: "toolu_structured",
              name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
              input: { answer: "ok" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "answer" }],
      {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
            },
          },
        },
      },
    );

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request.tool_choice).toEqual({
      type: "tool",
      name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
    });
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe("stop");
    expect(response.structuredOutput).toMatchObject({
      type: "json_schema",
      name: "answer",
      parsed: { answer: "ok" },
    });
  });

  test("adds the context-management beta header when context management is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-3-7-sonnet",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      contextManagement: {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      },
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }]);

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(request.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    });
    expect(headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
  });

  test("streams messages-api text deltas and emits final tool calls from tool_use blocks", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-7-sonnet","content":[],"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"system.echo","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"text\\":\\"hi\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-3-7-sonnet",
      fetchImpl,
    });
    const chunks: Array<{
      content: string;
      done: boolean;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    }> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toEqual([
      { content: "Hel", done: false },
      { content: "lo", done: false },
      {
        content: "",
        done: false,
        toolInputBlockStart: {
          callId: "toolu_1",
          index: 1,
          contentBlock: {
            type: "tool_use",
            id: "toolu_1",
            name: "system.echo",
            input: {},
          },
        },
      },
      {
        content: "",
        done: false,
        toolInputDelta: {
          callId: "toolu_1",
          index: 1,
          partialJson: '{"text":"hi"}',
        },
      },
      {
        content: "",
        done: false,
        toolCalls: [
          { id: "toolu_1", name: "system.echo", arguments: '{"text":"hi"}' },
        ],
      },
      {
        content: "",
        done: true,
        toolCalls: [
          { id: "toolu_1", name: "system.echo", arguments: '{"text":"hi"}' },
        ],
      },
    ]);
    expect(response.content).toBe("Hello");
    expect(response.toolCalls).toEqual([
      { id: "toolu_1", name: "system.echo", arguments: '{"text":"hi"}' },
    ]);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.usage).toEqual({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(request.stream).toBe(true);
    expect(headers.get("x-api-key")).toBe("anthropic-test");
    expect(headers.get("accept")).toBe("text/event-stream");
  });
});
