import { describe, expect, test, vi } from "vitest";
import {
  LLMContextWindowExceededError,
  LLMRateLimitError,
  LLMServerError,
} from "../../errors.js";
import { GeminiProvider } from "../gemini/index.js";
import { LMStudioProvider } from "../lmstudio/index.js";
import { OpenAIProvider } from "./adapter.js";

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

function expectNoRequestMetadataWarning(emitWarning: ReturnType<typeof vi.fn>): void {
  expect(
    emitWarning.mock.calls.some(([warning]) => {
      return (
        typeof warning === "object" &&
        warning !== null &&
        "cause" in warning &&
        warning.cause === "llm_request_metadata"
      );
    }),
  ).toBe(false);
}

describe("OpenAIProvider", () => {
  test("propagates fallback trigger from chat requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
        maxFailures: 1,
      },
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "openai",
      toProvider: "grok",
      fromModel: "gpt-5",
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
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
        maxFailures: 1,
      },
    });

    await expect(
      provider.chat(
        [{ role: "user", content: "hello" }],
        { model: "gpt-5-reviewer" },
      ),
    ).rejects.toMatchObject({
      name: "FallbackTriggeredError",
      fromProvider: "openai",
      toProvider: "grok",
      fromModel: "gpt-5-reviewer",
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
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
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
      fromProvider: "openai",
      toProvider: "grok",
      fromModel: "gpt-5",
      toModel: "grok-4-fast",
    });
  });

  test("triggers fallback from repeated responses stream overload events", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        sseResponse([
          'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"type":"overloaded_error","message":"busy"}}}\n\n',
        ]),
      )
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
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
        fromProvider: "openai",
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

  test("triggers fallback from repeated chat-completions stream overload events", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        sseResponse([
          'data: {"error":{"type":"overloaded_error","message":"busy"}}\n\n',
        ]),
      )
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      useResponsesApi: false,
      fetchImpl,
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
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
        fromProvider: "openai",
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

  test("does not trigger stream fallback after partial responses output", async () => {
    const restoreTimers = useDeterministicFallbackTimers();
    let attempt = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      attempt += 1;
      if (attempt < 3) {
        return Promise.resolve(
          sseResponse([
            'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"type":"overloaded_error","message":"busy"}}}\n\n',
          ]),
        );
      }
      return Promise.resolve(
        sseResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"type":"overloaded_error","message":"busy"}}}\n\n',
        ]),
      );
    });
    const chunks: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
      providerFallback: {
        provider: "openai",
        model: "gpt-5",
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
    const emitWarning = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          model: "gpt-5-reviewer",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            total_tokens: 4,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
      emitWarning,
    });

    const response = await provider.chat(
      [{ role: "user", content: "review" }],
      { model: "gpt-5-reviewer" },
    );

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request.model).toBe("gpt-5-reviewer");
    expect(response.model).toBe("gpt-5-reviewer");
    expectNoRequestMetadataWarning(emitWarning);
  });

  test("passes structured output through Responses requests and parses the result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          model: "gpt-5",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "{\"answer\":\"ok\"}" }],
            },
          ],
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            total_tokens: 4,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
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
    expect(request.text).toMatchObject({
      format: {
        type: "json_schema",
        name: "answer",
        strict: true,
      },
    });
    expect(response.structuredOutput).toMatchObject({
      type: "json_schema",
      name: "answer",
      parsed: { answer: "ok" },
    });
  });

  test("rejects responses-api non-stream tool calls with invalid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          model: "gpt-5",
          output: [
            {
              type: "function_call",
              id: "fc_bad",
              call_id: "call_bad",
              name: "system.echo",
              arguments: "not-json",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow("OpenAI Responses response emitted invalid function_call");
  });

  test("uses local chat-completions request shape for OpenAI-compatible local endpoints", async () => {
    const emitWarning = vi.fn();
    const emitDiagnostic = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          model: "qwen3.6-35b-a3b-fp8",
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 1,
            total_tokens: 6,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new OpenAIProvider({
      apiKey: "local-token",
      model: "qwen3.6-35b-a3b-fp8",
      baseURL: "http://127.0.0.1:8000/v1",
      useResponsesApi: false,
      fetchImpl,
      emitWarning,
      emitDiagnostic,
    });

    await provider.chat(
      [{ role: "user", content: "hello" }],
      {
        systemPrompt: "base instructions",
        maxOutputTokens: 8192,
        contextWindowTokens: 262_144,
      },
    );

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request.max_tokens).toBe(8192);
    expect("max_completion_tokens" in request).toBe(false);
    expect(request.messages).toEqual([
      { role: "system", content: "base instructions" },
      { role: "user", content: "hello" },
    ]);
    expectNoRequestMetadataWarning(emitWarning);
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "llm_request_metadata",
        message: expect.stringContaining('"model":"qwen3.6-35b-a3b-fp8"'),
      }),
    );
  });

  test("uses max_completion_tokens for non-local OpenAI chat completions", async () => {
    const emitWarning = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          model: "gpt-5",
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok",
              },
              finish_reason: "stop",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      useResponsesApi: false,
      fetchImpl,
      emitWarning,
    });

    await provider.chat([{ role: "user", content: "hello" }], {
      maxOutputTokens: 2048,
    });

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request.max_completion_tokens).toBe(2048);
    expect("max_tokens" in request).toBe(false);
    expectNoRequestMetadataWarning(emitWarning);
  });

  test("rejects chat-completions non-stream tool calls with invalid JSON", async () => {
    const emitWarning = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_bad",
          model: "gpt-5",
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_bad",
                    type: "function",
                    function: {
                      name: "system.echo",
                      arguments: "not-json",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      useResponsesApi: false,
      fetchImpl,
      emitWarning,
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow("OpenAI chat-completions response emitted invalid tool_call");
    expectNoRequestMetadataWarning(emitWarning);
  });

  test("fails before chat-completions network calls when the request exceeds the context window", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new OpenAIProvider({
      apiKey: "local-token",
      model: "qwen3.6-35b-a3b-fp8",
      baseURL: "http://127.0.0.1:8000/v1",
      useResponsesApi: false,
      contextWindowTokens: 128,
      maxTokens: 4096,
      fetchImpl,
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toBeInstanceOf(LLMContextWindowExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refreshes oauth credentials after a 401 and retries once", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "unauthorized" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            model: "gpt-5",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              total_tokens: 4,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const refreshAccessToken = vi.fn().mockResolvedValue({
      kind: "refreshed",
      accessToken: "oauth-token-2",
      refreshToken: "refresh-token-2",
    });

    const provider = new OpenAIProvider({
      model: "gpt-5",
      authMode: "oauth",
      oauth: {
        accessToken: "oauth-token-1",
        refreshToken: "refresh-token-1",
        refreshAccessToken,
      },
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    const secondHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Headers;
    expect(firstHeaders.get("authorization")).toBe("Bearer oauth-token-1");
    expect(secondHeaders.get("authorization")).toBe("Bearer oauth-token-2");
  });

  test("hard-fails OAuth exhaustion and keeps the session in re-auth required state", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "unauthorized" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "unauthorized" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            model: "gpt-5",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "recovered" }],
              },
            ],
            usage: {
              input_tokens: 4,
              output_tokens: 1,
              total_tokens: 5,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const refreshAccessToken = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "exhausted",
        reason: "refresh revoked",
      })
      .mockResolvedValueOnce({
        kind: "refreshed",
        accessToken: "oauth-token-2",
        refreshToken: "refresh-token-2",
      });

    const provider = new OpenAIProvider({
      model: "gpt-5",
      authMode: "oauth",
      oauth: {
        accessToken: "oauth-token-1",
        refreshToken: "refresh-token-1",
        refreshAccessToken,
      },
      fetchImpl,
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toMatchObject({
      providerName: "openai",
      statusCode: 401,
      message: expect.stringContaining("OAuth refresh exhausted"),
    });

    await expect(
      provider.chat([{ role: "user", content: "hello again" }]),
    ).rejects.toMatchObject({
      providerName: "openai",
      statusCode: 401,
      message: expect.stringContaining("OAuth refresh exhausted"),
    });

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("classifies 404 endpoint failures with the openai marker", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("Not Found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
      ),
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow("openai_category=endpoint_not_found");
  });

  test("streams responses-api text deltas and resolves tool calls from stream events", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"system.echo","arguments":"{\\"text\\":\\"hi\\"}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]},{"type":"web_search_call","id":"ws_1","status":"completed"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"system.echo","arguments":"{\\"text\\":\\"hi\\"}"}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}}}\n\n',
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
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
        toolCalls: [
          { id: "call_1", name: "system.echo", arguments: '{"text":"hi"}' },
        ],
      },
      {
        content: "",
        done: true,
        toolCalls: [
          { id: "call_1", name: "system.echo", arguments: '{"text":"hi"}' },
        ],
      },
    ]);
    expect(response.content).toBe("Hello");
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "system.echo", arguments: '{"text":"hi"}' },
    ]);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.usage).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
      cachedInputTokens: 2,
      reasoningOutputTokens: 1,
      webSearchRequests: 1,
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(request.stream).toBe(true);
    expect(headers.get("accept")).toBe("text/event-stream");
  });

  test("rejects responses-api stream tool calls with invalid completed JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_bad","call_id":"call_bad","name":"system.echo","arguments":"not-json"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5","output":[]}}\n\n',
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
    });
    const chunks: unknown[] = [];

    await expect(
      provider.chatStream(
        [{ role: "user", content: "hello" }],
        (chunk) => chunks.push(chunk),
      ),
    ).rejects.toThrow("OpenAI Responses stream emitted invalid function_call");
    expect(
      chunks.some(
        (chunk) =>
          typeof chunk === "object" &&
          chunk !== null &&
          "toolCalls" in chunk,
      ),
    ).toBe(false);
  });

  test("rejects malformed tool calls present only in responses-api completion payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5","output":[{"type":"function_call","id":"fc_bad","call_id":"call_bad","name":"system.echo","arguments":"not-json"}]}}\n\n',
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
    });
    const chunks: unknown[] = [];

    await expect(
      provider.chatStream(
        [{ role: "user", content: "hello" }],
        (chunk) => chunks.push(chunk),
      ),
    ).rejects.toThrow("OpenAI Responses response emitted invalid function_call");
    expect(chunks).toEqual([]);
  });

  test("refreshes oauth credentials before retrying a streaming request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "unauthorized" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        sseResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
        ]),
      );
    const refreshAccessToken = vi.fn().mockResolvedValue({
      kind: "refreshed",
      accessToken: "oauth-token-2",
      refreshToken: "refresh-token-2",
    });
    const provider = new OpenAIProvider({
      model: "gpt-5",
      authMode: "oauth",
      oauth: {
        accessToken: "oauth-token-1",
        refreshToken: "refresh-token-1",
        refreshAccessToken,
      },
      fetchImpl,
    });
    const chunks: Array<{ content: string; done: boolean }> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push({ content: chunk.content, done: chunk.done }),
    );

    expect(response.content).toBe("ok");
    expect(chunks).toEqual([
      { content: "ok", done: false },
      { content: "", done: true },
    ]);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const firstHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    const secondHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Headers;
    expect(firstHeaders.get("authorization")).toBe("Bearer oauth-token-1");
    expect(secondHeaders.get("authorization")).toBe("Bearer oauth-token-2");
    expect(secondHeaders.get("accept")).toBe("text/event-stream");
  });

  test("streams chat-completions deltas instead of buffering the full reply", async () => {
    const emitWarning = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"Hi "}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"system.echo","arguments":"{\\"text\\":"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"there","tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      useResponsesApi: false,
      fetchImpl,
      emitWarning,
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
      { content: "Hi ", done: false },
      { content: "there", done: false },
      {
        content: "",
        done: true,
        toolCalls: [
          { id: "call_1", name: "system.echo", arguments: '{"text":"hi"}' },
        ],
      },
    ]);
    expect(response.content).toBe("Hi there");
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "system.echo", arguments: '{"text":"hi"}' },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 7,
      completionTokens: 4,
      totalTokens: 11,
      cachedInputTokens: 3,
      reasoningOutputTokens: 2,
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request.stream).toBe(true);
    expect(request.stream_options).toEqual({ include_usage: true });
    expectNoRequestMetadataWarning(emitWarning);
  });

  test("rejects chat-completions stream tool calls with invalid completed JSON", async () => {
    const emitWarning = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"system.echo","arguments":"not-json"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      useResponsesApi: false,
      fetchImpl,
      emitWarning,
    });
    const chunks: unknown[] = [];

    await expect(
      provider.chatStream(
        [{ role: "user", content: "hello" }],
        (chunk) => chunks.push(chunk),
      ),
    ).rejects.toThrow("OpenAI chat-completions stream emitted invalid tool_call");
    expect(chunks).toEqual([]);
    expectNoRequestMetadataWarning(emitWarning);
  });

  test("does not surface truncated chat-completions tool calls as executable calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"Let me write that."}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Write","arguments":"{\\"file_path\\":\\"/tmp/parser.c\\"}"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"finish_reason":"length"}],"usage":{"prompt_tokens":85000,"completion_tokens":4096,"total_tokens":89096}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      useResponsesApi: false,
      fetchImpl,
    });
    const chunks: Array<{
      content: string;
      done: boolean;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    }> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "rewrite parser" }],
      (chunk) => chunks.push(chunk),
    );

    expect(response.finishReason).toBe("length");
    expect(response.toolCalls).toEqual([]);
    expect(chunks).toEqual([
      { content: "Let me write that.", done: false },
      { content: "", done: true },
    ]);
  });

  test("surfaces streaming 429s as typed rate-limit errors", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      useResponsesApi: false,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "too many requests" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "7",
            },
          },
        ),
      ),
    });

    await expect(
      provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      ),
    ).rejects.toEqual(new LLMRateLimitError("openai", 7_000));
  });

  test("surfaces streaming 5xxs as typed server errors for compat providers", async () => {
    const provider = new OpenAIProvider({
      apiKey: "or-test",
      model: "openai/gpt-5",
      providerName: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      useResponsesApi: false,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "upstream overloaded" } }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    await expect(
      provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      ),
    ).rejects.toMatchObject({
      name: LLMServerError.name,
      providerName: "openrouter",
      statusCode: 503,
    });
  });

  test("omits Authorization headers for LMStudio when no API key is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          model: "qwen2.5-coder:7b",
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 1,
            total_tokens: 5,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new LMStudioProvider({
      model: "qwen2.5-coder:7b",
      baseURL: "http://localhost:1234/v1",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }]);

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("http://localhost:1234/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
  });

  test("uses bearer headers and the /openai path prefix for Gemini", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          model: "gemini-2.5-pro",
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 1,
            total_tokens: 5,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }]);

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer gemini-test");
    expect(headers.get("x-goog-api-key")).toBeNull();
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect("store" in requestBody).toBe(false);
  });
});
