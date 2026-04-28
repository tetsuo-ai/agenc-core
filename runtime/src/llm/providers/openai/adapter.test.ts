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

describe("OpenAIProvider", () => {
  test("honors request-scoped model overrides on chat calls", async () => {
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
  });

  test("uses local chat-completions request shape for OpenAI-compatible local endpoints", async () => {
    const emitWarning = vi.fn();
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
    expect(emitWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "llm_request_metadata",
        message: expect.stringContaining('"model":"qwen3.6-35b-a3b-fp8"'),
      }),
    );
  });

  test("uses max_completion_tokens for non-local OpenAI chat completions", async () => {
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
    });

    await provider.chat([{ role: "user", content: "hello" }], {
      maxOutputTokens: 2048,
    });

    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request.max_completion_tokens).toBe(2048);
    expect("max_tokens" in request).toBe(false);
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
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"system.echo","arguments":"{\\"text\\":\\"hi\\"}"}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
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

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(request.stream).toBe(true);
    expect(headers.get("accept")).toBe("text/event-stream");
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
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"Hi "}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"system.echo","arguments":"{\\"text\\":"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"there","tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_1","model":"gpt-5","choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n',
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
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request.stream).toBe(true);
    expect(request.stream_options).toEqual({ include_usage: true });
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

  test("uses x-goog-api-key headers and the /openai path prefix for Gemini", async () => {
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
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBe("gemini-test");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect("store" in requestBody).toBe(false);
  });
});
