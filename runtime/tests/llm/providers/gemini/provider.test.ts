import { describe, expect, test, vi } from "vitest";

import { createTokenAccountingRequest } from "../../token-accounting.js";
import type { LLMTool } from "../../types.js";
import { GeminiProvider } from "./index.js";
import {
  createCsvAgentInvocationEnvelope,
  materializeAgentInvocationMessages,
} from "../../../../src/contracts/agent-invocation-envelope.js";

function invocationMessages() {
  return materializeAgentInvocationMessages(
    createCsvAgentInvocationEnvelope({
      jobId: "gemini-job",
      itemId: "gemini-item",
      rowIndex: 0,
      rowSha256: `sha256:${"b".repeat(64)}`,
      instruction: "GEMINI_TASK_MARKER",
      row: { payload: "GEMINI_DATA_MARKER" },
    }),
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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
  test("refuses invocation-looking content without durable authority metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    await expect(
      provider.chat([
        {
          role: "developer",
          content: '{"kind":"agent_invocation_runtime_policy"}',
        },
      ]),
    ).rejects.toThrow(/metadata is missing/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("preserves policy, task, and data as separate Gemini authorities", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    await provider.chat([...invocationMessages()]);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const request = JSON.parse(String(init?.body)) as {
      readonly systemInstruction?: unknown;
      readonly contents?: readonly unknown[];
    };
    expect(JSON.stringify(request.systemInstruction)).not.toContain(
      "GEMINI_TASK_MARKER",
    );
    expect(JSON.stringify(request.systemInstruction)).not.toContain(
      "GEMINI_DATA_MARKER",
    );
    expect(request.contents).toHaveLength(2);
    expect(JSON.stringify(request.contents?.[0])).toContain("GEMINI_TASK_MARKER");
    expect(JSON.stringify(request.contents?.[0])).not.toContain(
      "GEMINI_DATA_MARKER",
    );
    expect(JSON.stringify(request.contents?.[1])).toContain("GEMINI_DATA_MARKER");
  });

  test("counts the complete generateContent request through countTokens", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ totalTokens: 41 }));
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });
    const controller = new AbortController();
    const request = createTokenAccountingRequest({
      provider: provider.name,
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hello" }],
      options: {
        systemPrompt: "system instruction",
        tools: [echoTool],
        toolChoice: { type: "function", name: "system.echo" },
        maxOutputTokens: 321,
      },
      reservedOutputTokens: 321,
    });

    await expect(
      provider.tokenCountCapability.countTokens(request, controller.signal),
    ).resolves.toMatchObject({
      inputTokens: 41,
      complete: true,
      confidence: "high",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      generateContentRequest: {
        model: "models/gemini-2.5-pro",
        systemInstruction: { parts: [{ text: "system instruction" }] },
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        tools: [
          {
            functionDeclarations: [
              expect.objectContaining({ name: "system.echo" }),
            ],
          },
        ],
        toolConfig: expect.any(Object),
        generationConfig: expect.objectContaining({ maxOutputTokens: 321 }),
      },
    });
  });

  test("uses the Vertex publisher resource for complete token counts", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ totalTokens: 19 }));
    const provider = new GeminiProvider({
      accessToken: "vertex-token",
      project: "project-1",
      model: "gemini-2.5-pro",
      baseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
      fetchImpl,
    });
    const request = createTokenAccountingRequest({
      provider: provider.name,
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hello" }],
      options: {},
      reservedOutputTokens: 0,
    });

    await provider.tokenCountCapability.countTokens(
      request,
      new AbortController().signal,
    );
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:countTokens",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: expect.any(Object),
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty(
      "generateContentRequest",
    );
  });


  test("single-wire chat performs exactly one transport attempt", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "temporarily down" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    await expect(
      provider.chat(
        [{ role: "user", content: "hello" }],
        { singleWireAttempt: true },
      ),
    ).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("single-wire stream hands fallback outward without an internal retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
      providerFallback: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
      },
    });

    await expect(
      provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
        { singleWireAttempt: true },
      ),
    ).rejects.toMatchObject({ name: "FallbackTriggeredError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("uses native generateContent with x-goog-api-key auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "ok" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 1,
          totalTokenCount: 5,
        },
      }),
    );

    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }], {
      temperature: 0.25,
      stopSequences: ["END"],
    });

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("x-goog-api-key")).toBe("gemini-test");
    expect(headers.get("authorization")).toBeNull();
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.25,
        stopSequences: ["END"],
      },
    });
    expect("model" in requestBody).toBe(false);
    expect("store" in requestBody).toBe(false);
  });

  test("uses Gemini credential resolver bearer auth with user project", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "bearer" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );

    const provider = new GeminiProvider({
      model: "gemini-2.5-pro",
      fetchImpl,
      resolveCredential: async () => ({
        kind: "access-token",
        credential: "ya29-token",
        projectId: "project-1",
      }),
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("bearer");
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer ya29-token");
    expect(headers.get("x-goog-api-key")).toBeNull();
    expect(headers.get("x-goog-user-project")).toBe("project-1");
  });

  test("uses Vertex Gemini publisher paths with bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "vertex" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      model: "gemini-2.5-pro",
      baseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
      accessToken: "vertex-token",
      project: "project-1",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("vertex");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer vertex-token");
    expect(headers.get("x-goog-user-project")).toBe("project-1");
  });

  test("prefers explicit OAuth credentials over API key credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "oauth" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      authMode: "oauth",
      oauth: { accessToken: "oauth-token" },
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("oauth");
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.get("x-goog-api-key")).toBeNull();
  });

  test("sends tools as Gemini function declarations and parses function calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "system.echo",
                    args: { text: "hi" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 1,
          totalTokenCount: 5,
        },
      }),
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
      { id: "gemini_call_0", name: "system.echo", arguments: "{\"text\":\"hi\"}" },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 4,
      completionTokens: 1,
      totalTokens: 5,
      availability: "reported",
      provenance: "provider",
    });
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "system.echo",
            description: "Echo text",
            parameters: echoTool.function.parameters,
          },
        ],
      },
    ]);
  });

  test("streams Gemini text, function calls, and usage from streamGenerateContent", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi "}]},"finishReason":"STOP"}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"there"},{"functionCall":{"name":"system.echo","args":{"text":"hi"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":4,"totalTokenCount":11}}\n\n',
      ]),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });
    const chunks: unknown[] = [];

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
        done: false,
        toolInputBlockStart: {
          callId: "gemini_call_0",
          index: 0,
          contentBlock: {
            type: "tool_use",
            id: "gemini_call_0",
            name: "system.echo",
            input: { text: "hi" },
          },
        },
      },
      {
        content: "",
        done: false,
        toolInputDelta: {
          callId: "gemini_call_0",
          index: 0,
          partialJson: "{\"text\":\"hi\"}",
        },
      },
      {
        content: "",
        done: true,
        toolCalls: [
          {
            id: "gemini_call_0",
            name: "system.echo",
            arguments: "{\"text\":\"hi\"}",
          },
        ],
      },
    ]);
    expect(response.content).toBe("Hi there");
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      { id: "gemini_call_0", name: "system.echo", arguments: "{\"text\":\"hi\"}" },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 7,
      completionTokens: 4,
      totalTokens: 11,
      availability: "reported",
      provenance: "provider",
    });

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("x-goog-api-key")).toBe("gemini-test");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.tools).toBeDefined();
    expect("stream" in requestBody).toBe(false);
    expect("stream_options" in requestBody).toBe(false);
  });

  test("uses cachedContents prompt-cache hints and maps cached usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "cached" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 2,
          totalTokenCount: 22,
          cachedContentTokenCount: 16,
        },
      }),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      cachedContent: "cachedContents/project-context",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.usage.cachedInputTokens).toBe(16);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.cachedContent).toBe("cachedContents/project-context");
  });

  test("uses request prompt-cache hints before configured cachedContents", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "request cache" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      cachedContent: "cachedContents/project-context",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }], {
      promptCacheKey: "cachedContents/request-context",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.cachedContent).toBe("cachedContents/request-context");
  });

  test("preserves Gemini thought signatures through history and response thinking", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  thought: true,
                  text: "reasoning",
                  thoughtSignature: "sig-2",
                },
                { text: "done" },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          totalTokenCount: 6,
          thoughtsTokenCount: 1,
        },
      }),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    const response = await provider.chat([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "previous reasoning",
            signature: "sig-1",
          },
          { type: "text", text: "previous answer" },
        ] as never,
      },
      { role: "user", content: "continue" },
    ]);

    expect(response.thinking).toEqual([
      {
        text: "reasoning",
        redacted: false,
        signature: "sig-2",
        kind: "thinking",
      },
    ]);
    expect(response.usage.reasoningOutputTokens).toBe(1);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as {
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    expect(requestBody.contents[0]).toEqual({
      role: "model",
      parts: [
        {
          text: "previous reasoning",
          thought: true,
          thoughtSignature: "sig-1",
        },
        { text: "previous answer" },
      ],
    });
  });

  test("rejects malformed Gemini function calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { args: { text: "hi" } } }],
            },
            finishReason: "MALFORMED_FUNCTION_CALL",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      apiKey: "gemini-test",
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    await expect(
      provider.chat([{ role: "user", content: "call echo" }], {
        tools: [echoTool],
      }),
    ).rejects.toThrow("Gemini response emitted invalid functionCall");
  });
});
