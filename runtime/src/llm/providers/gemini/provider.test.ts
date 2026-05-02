import { describe, expect, test, vi } from "vitest";

import type { LLMTool } from "../../types.js";
import { GeminiProvider } from "./index.js";

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

const echoTool: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo text",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

describe("GeminiProvider", () => {
  test("uses the Gemini v1beta OpenAI shim with bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_gemini",
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

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
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

  test("sends tools through the Gemini OpenAI-compatible route and parses tool calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_gemini_tool",
          model: "gemini-2.5-pro",
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "system.echo",
                      arguments: "{\"text\":\"hi\"}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
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
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "call echo" }],
      { tools: [echoTool] },
    );

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "system.echo", arguments: "{\"text\":\"hi\"}" },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 4,
      completionTokens: 1,
      totalTokens: 5,
    });
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer gemini-test");
    expect(headers.get("x-goog-api-key")).toBeNull();
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.tools).toEqual([echoTool]);
    expect("store" in requestBody).toBe(false);
  });

  test("streams Gemini chat-completions deltas and accumulates tool calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_gemini_stream","model":"gemini-2.5-pro","choices":[{"index":0,"delta":{"content":"Hi "}}]}\n\n',
        'data: {"id":"chatcmpl_gemini_stream","model":"gemini-2.5-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"system.echo","arguments":"{\\"text\\":"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_gemini_stream","model":"gemini-2.5-pro","choices":[{"index":0,"delta":{"content":"there","tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_gemini_stream","model":"gemini-2.5-pro","choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });
    const chunks: Array<{
      content: string;
      done: boolean;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    }> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "call echo" }],
      (chunk) => chunks.push(chunk),
      { tools: [echoTool] },
    );

    expect(chunks).toEqual([
      { content: "Hi ", done: false },
      { content: "there", done: false },
      {
        content: "",
        done: true,
        toolCalls: [
          { id: "call_1", name: "system.echo", arguments: "{\"text\":\"hi\"}" },
        ],
      },
    ]);
    expect(response.content).toBe("Hi there");
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "system.echo", arguments: "{\"text\":\"hi\"}" },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 7,
      completionTokens: 4,
      totalTokens: 11,
    });

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("authorization")).toBe("Bearer gemini-test");
    expect(headers.get("x-goog-api-key")).toBeNull();
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.stream).toBe(true);
    expect(requestBody.stream_options).toEqual({ include_usage: true });
    expect(requestBody.tools).toEqual([echoTool]);
    expect("store" in requestBody).toBe(false);
  });

  test("rejects malformed streamed Gemini tool calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_gemini_bad","model":"gemini-2.5-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"system.echo","arguments":"not-json"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_gemini_bad","model":"gemini-2.5-pro","choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });
    const chunks: unknown[] = [];

    await expect(
      provider.chatStream(
        [{ role: "user", content: "call echo" }],
        (chunk) => chunks.push(chunk),
        { tools: [echoTool] },
      ),
    ).rejects.toThrow("chat-completions stream emitted invalid tool_call");
    expect(chunks).toEqual([]);
  });
});
