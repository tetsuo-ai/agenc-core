import { afterEach, describe, expect, test, vi } from "vitest";

import { LMStudioProvider } from "./index.js";
import { withLmstudioHealthSidecar } from "./health.js";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("LMStudioProvider", () => {
  test("omits authorization when no API key is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_lmstudio",
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

    const provider = new LMStudioProvider({
      model: "qwen2.5-coder:7b",
      baseURL: "http://localhost:1234/v1",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("http://localhost:1234/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe("qwen2.5-coder:7b");
    expect(requestBody.stream).toBe(false);
  });

  test("uses optional bearer auth when an API key is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_lmstudio_keyed",
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

    const provider = new LMStudioProvider({
      apiKey: "lmstudio-test",
      model: "qwen2.5-coder:7b",
      baseURL: "http://localhost:1234/v1",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }]);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer lmstudio-test");
  });

  test("honors request-scoped local model overrides", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_lmstudio_override",
          model: "local-deepseek-r1:8b",
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

    const provider = new LMStudioProvider({
      model: "qwen2.5-coder:7b",
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "local-deepseek-r1:8b" },
    );

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("http://localhost:1234/v1/chat/completions");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe("local-deepseek-r1:8b");
    expect(requestBody.stream).toBe(false);
  });

  test("streams chat completions through the local endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_lmstudio_stream","model":"qwen2.5-coder:7b","choices":[{"index":0,"delta":{"content":"hel"}}]}\n\n',
        'data: {"id":"chatcmpl_lmstudio_stream","model":"qwen2.5-coder:7b","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
        'data: {"id":"chatcmpl_lmstudio_stream","model":"qwen2.5-coder:7b","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new LMStudioProvider({
      model: "qwen2.5-coder:7b",
      fetchImpl,
    });
    const chunks: Array<{ content: string; done: boolean }> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push({ content: chunk.content, done: chunk.done }),
    );

    expect(response.content).toBe("hello");
    expect(response.usage).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
      availability: "reported",
      provenance: "provider",
    });
    expect(chunks).toEqual([
      { content: "hel", done: false },
      { content: "lo", done: false },
      { content: "", done: true },
    ]);
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("http://localhost:1234/v1/chat/completions");
    const headers = init?.headers as Headers;
    expect(headers.get("accept")).toBe("text/event-stream");
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody.model).toBe("qwen2.5-coder:7b");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.stream_options).toEqual({ include_usage: true });
  });

  test("health sidecar aborts long streams when LM Studio goes down (after 2 consecutive failures)", async () => {
    // Phase 4 #45 changed the default consecutive-failure threshold
    // from 1 to 2 so a single transient probe blip can't kill an
    // in-flight stream. Two consecutive `healthy === false` probes
    // are required to trip the abort.
    vi.useFakeTimers();
    const healthCheck = vi.fn().mockResolvedValue(false);

    const pending = withLmstudioHealthSidecar({
      intervalMs: 5,
      healthCheck,
      operation: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const observed = pending.catch((error: unknown) => error);

    // First probe at t=5ms: counter=1 < threshold=2, no abort.
    // Second probe at t=10ms: counter=2 >= threshold=2, abort fires.
    await vi.advanceTimersByTimeAsync(15);

    await expect(observed).resolves.toMatchObject({
      name: "LLMProviderError",
      providerName: "lmstudio",
    });
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  test("health sidecar treats refused local connections as provider loss (after 2 consecutive ECONNREFUSED probes)", async () => {
    vi.useFakeTimers();
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
      code: "ECONNREFUSED",
    });
    const healthCheck = vi.fn().mockRejectedValue(refused);

    const pending = withLmstudioHealthSidecar({
      intervalMs: 5,
      healthCheck,
      operation: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const observed = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15);

    await expect(observed).resolves.toMatchObject({
      name: "LLMProviderError",
      providerName: "lmstudio",
    });
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });
});
