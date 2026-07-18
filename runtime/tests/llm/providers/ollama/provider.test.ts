import { afterEach, describe, expect, test, vi } from "vitest";

import { OllamaProvider } from "./adapter.js";
import { withOllamaHealthSidecar } from "./health.js";

function setClient(
  provider: OllamaProvider,
  client: { readonly chat?: unknown; readonly list?: unknown },
): void {
  (provider as unknown as { client: unknown }).client = client;
}

async function* streamChunks(chunks: readonly unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function hangingStreamAfterFirstChunk(options: {
  readonly settleOnAbort?: boolean;
  readonly settleOnReturn?: boolean;
} = {}): {
  readonly stream: AsyncIterable<unknown> & { abort: () => void };
  readonly abortSpy: ReturnType<typeof vi.fn>;
  readonly returnSpy: ReturnType<typeof vi.fn>;
  readonly settlePendingNext: () => void;
} {
  let settlePendingNext: (() => void) | undefined;
  const settle = (): void => settlePendingNext?.();
  const abortSpy = vi.fn(() => {
    if (options.settleOnAbort !== false) settle();
  });
  const returnSpy = vi.fn(async () => {
    if (options.settleOnReturn !== false) settle();
    return { done: true, value: undefined };
  });
  const stream: AsyncIterable<unknown> & { abort: () => void } = {
    abort: abortSpy,
    [Symbol.asyncIterator]() {
      let calls = 0;
      return {
        next: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              done: false,
              value: {
                model: "llama3.3",
                message: { role: "assistant", content: "hel" },
                prompt_eval_count: 5,
                eval_count: 1,
              },
            };
          }
          return await new Promise<IteratorResult<unknown>>((resolve) => {
            settlePendingNext = () =>
              resolve({ done: true, value: undefined });
          });
        },
        return: returnSpy,
      };
    },
  };
  return { stream, abortSpy, returnSpy, settlePendingNext: settle };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("providers/ollama entrypoint", () => {
  test("exports the canonical Ollama provider class", () => {
    const provider = new OllamaProvider({
      model: "llama3.3",
    });

    expect(provider.name).toBe("ollama");
  });

  test("honors request-scoped model overrides when building requests", () => {
    const provider = new OllamaProvider({
      model: "llama3.3",
    });

    const params = (provider as any).buildParams(
      [{ role: "user", content: "review" }],
      { model: "qwen-reviewer" },
    );

    expect(params.model).toBe("qwen-reviewer");
  });

  test("uses the documented Ollama default model for direct construction", () => {
    const provider = new OllamaProvider({});

    const params = (provider as any).buildParams([
      { role: "user", content: "review" },
    ]);

    expect(params.model).toBe("llama3.3");
  });

  test("sends native SDK chat requests with local model options", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: "qwen2.5-coder:7b",
      message: {
        role: "assistant",
        content: "ok",
      },
      prompt_eval_count: 8,
      eval_count: 2,
    });
    const provider = new OllamaProvider({
      model: "llama3.3",
      host: "http://localhost:11434",
      maxTokens: 128,
      numCtx: 8192,
      keepAlive: "10m",
    });
    setClient(provider, { chat });

    const response = await provider.chat(
      [{ role: "user", content: "review" }],
      {
        model: "qwen2.5-coder:7b",
        maxOutputTokens: 64,
        systemPrompt: "Be terse.",
        temperature: 0.1,
        stopSequences: ["END"],
        singleWireAttempt: true,
      },
    );

    expect(response.content).toBe("ok");
    expect(response.model).toBe("qwen2.5-coder:7b");
    expect(response.usage).toEqual({
      promptTokens: 8,
      completionTokens: 2,
      totalTokens: 10,
      availability: "reported",
      provenance: "provider",
    });
    expect(chat).toHaveBeenCalledTimes(1);
    const [params] = chat.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      model: "qwen2.5-coder:7b",
      keep_alive: "10m",
      options: {
        temperature: 0.1,
        num_predict: 64,
        num_ctx: 8192,
        stop: ["END"],
      },
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "review" },
      ],
    });
    expect(chat.mock.calls[0]).toHaveLength(1);
  });

  test("preserves assistant tool-call history before tool results", () => {
    const provider = new OllamaProvider({
      model: "llama3.3",
    });

    const params = (provider as any).buildParams([
      { role: "user", content: "echo hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_echo_1",
            name: "system.echo",
            arguments: '{"text":"hi"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_echo_1",
        toolName: "system.echo",
        content: "hi",
      },
    ]);

    expect(params.messages).toEqual([
      { role: "user", content: "echo hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "system.echo",
              arguments: { text: "hi" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: "hi",
        tool_call_id: "call_echo_1",
        tool_name: "system.echo",
      },
    ]);
  });

  test("parses native SDK tool calls from chat responses", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: "llama3.3",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "system.echo",
              arguments: { text: "hi" },
            },
          },
        ],
      },
      prompt_eval_count: 8,
      eval_count: 2,
    });
    const provider = new OllamaProvider({
      model: "llama3.3",
    });
    setClient(provider, { chat });

    const response = await provider.chat([{ role: "user", content: "echo hi" }]);

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      {
        id: expect.any(String),
        name: "system.echo",
        arguments: '{"text":"hi"}',
      },
    ]);
  });

  test("ignores malformed native SDK chat response fields", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: 42,
      message: {
        role: "assistant",
        content: 123,
        tool_calls: { function: { name: "system.echo" } },
      },
      prompt_eval_count: "8",
      eval_count: -1,
    });
    const provider = new OllamaProvider({
      model: "llama3.3",
    });
    setClient(provider, { chat });

    const response = await provider.chat(
      [{ role: "user", content: "echo hi" }],
      { model: "request-model" },
    );

    expect(response).toMatchObject({
      content: "",
      finishReason: "stop",
      model: "request-model",
      toolCalls: [],
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    });
  });

  test("ignores malformed native SDK tool-call entries while preserving valid ones", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: "llama3.3",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          null,
          "noise",
          { function: null },
          { function: { name: "   ", arguments: { text: "missing name" } } },
          { function: { name: "system.echo", arguments: { text: "hi" } } },
          {
            function: {
              name: "system.search",
              arguments: '{"query":"typed string args"}',
            },
          },
        ],
      },
      prompt_eval_count: 8,
      eval_count: 2,
    });
    const provider = new OllamaProvider({
      model: "llama3.3",
    });
    setClient(provider, { chat });

    const response = await provider.chat([{ role: "user", content: "echo hi" }]);

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      {
        id: expect.any(String),
        name: "system.echo",
        arguments: '{"text":"hi"}',
      },
      {
        id: expect.any(String),
        name: "system.search",
        arguments: '{"query":"typed string args"}',
      },
    ]);
  });

  test("streams native SDK chat chunks through the provider callback", async () => {
    const chat = vi.fn().mockResolvedValue(
      streamChunks([
        {
          model: "llama3.3",
          message: { role: "assistant", content: "hel" },
        },
        {
          model: "llama3.3",
          message: { role: "assistant", content: "lo" },
          prompt_eval_count: 5,
          eval_count: 2,
        },
      ]),
    );
    const provider = new OllamaProvider({
      model: "llama3.3",
    });
    setClient(provider, { chat, list: vi.fn().mockResolvedValue({ models: [] }) });
    const chunks: Array<{ content: string; done: boolean }> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push({ content: chunk.content, done: chunk.done }),
    );

    expect(response.content).toBe("hello");
    expect(response.model).toBe("llama3.3");
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
    const [params] = chat.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      model: "llama3.3",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(chat.mock.calls[0]).toHaveLength(1);
  });

  test("ignores malformed native SDK stream chunks while preserving valid deltas", async () => {
    const chat = vi.fn().mockResolvedValue(
      streamChunks([
        null,
        {
          model: 42,
          message: {
            role: "assistant",
            content: 99,
            tool_calls: { function: { name: "system.echo" } },
          },
          prompt_eval_count: "bad",
          eval_count: -1,
        },
        {
          model: "llama3.3",
          message: {
            role: "assistant",
            content: "ok",
            tool_calls: [
              { function: { name: "system.echo", arguments: { text: "hi" } } },
              { function: { name: "", arguments: { text: "bad" } } },
            ],
          },
          prompt_eval_count: 4,
          eval_count: 2,
        },
        {
          message: {
            role: "assistant",
            content: "",
          },
        },
      ]),
    );
    const provider = new OllamaProvider({
      model: "llama3.3",
    });
    setClient(provider, { chat, list: vi.fn().mockResolvedValue({ models: [] }) });
    const chunks: Array<{ content: string; done: boolean }> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push({ content: chunk.content, done: chunk.done }),
    );

    expect(response.content).toBe("ok");
    expect(response.model).toBe("llama3.3");
    expect(response.usage).toEqual({
      promptTokens: 4,
      completionTokens: 2,
      totalTokens: 6,
      availability: "reported",
      provenance: "provider",
    });
    expect(response.toolCalls).toEqual([
      {
        id: expect.any(String),
        name: "system.echo",
        arguments: '{"text":"hi"}',
      },
    ]);
    expect(chunks).toEqual([
      { content: "ok", done: false },
      { content: "", done: true },
    ]);
  });

  test("keeps health monitoring active through slow stream consumption", async () => {
    vi.useFakeTimers();
    const { stream, abortSpy, returnSpy } = hangingStreamAfterFirstChunk();
    const chat = vi.fn().mockResolvedValue(stream);
    const list = vi.fn().mockRejectedValue(new Error("local server down"));
    const provider = new OllamaProvider({
      model: "llama3.3",
    });
    setClient(provider, { chat, list });
    const chunks: Array<{ content: string; done: boolean }> = [];

    const pending = provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push({ content: chunk.content, done: chunk.done }),
    );
    const observed = pending.then(
      (response) => response,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(chunks).toEqual([{ content: "hel", done: false }]);

    // Phase 4 #45 changed the default consecutive-failure threshold
    // to 2, so we need to advance through TWO probe intervals (20s)
    // for the sidecar to abort. The first probe at t=10s sees the
    // server down (counter=1), the second probe at t=20s confirms
    // (counter=2) and trips the abort.
    await vi.advanceTimersByTimeAsync(20_000);
    const response = await observed;

    expect(response).toMatchObject({
      content: "hel",
      partial: true,
      finishReason: "error",
      error: {
        name: "LLMProviderError",
        providerName: "ollama",
      },
    });
    expect(chunks).toEqual([
      { content: "hel", done: false },
      { content: "", done: true },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  test("retains the model boundary until an abort-ignoring stream read settles", async () => {
    vi.useFakeTimers();
    const { stream, abortSpy, returnSpy, settlePendingNext } =
      hangingStreamAfterFirstChunk({
        settleOnAbort: false,
        settleOnReturn: false,
      });
    const provider = new OllamaProvider({ model: "llama3.3" });
    setClient(provider, {
      chat: vi.fn().mockResolvedValue(stream),
      list: vi.fn().mockResolvedValue({ models: [] }),
    });
    const controller = new AbortController();
    let settled = false;

    const running = provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => {},
      { signal: controller.signal },
    );
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("caller cancelled"));
    await vi.advanceTimersByTimeAsync(0);

    expect(abortSpy).toHaveBeenCalledOnce();
    expect(returnSpy).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    settlePendingNext();
    await expect(running).resolves.toMatchObject({
      content: "hel",
      partial: true,
      finishReason: "error",
    });
  });

  test("healthCheck probes the local SDK model list", async () => {
    const list = vi.fn().mockResolvedValue({ models: [] });
    const provider = new OllamaProvider({
      model: "llama3.3",
    });
    setClient(provider, { list });

    await expect(provider.healthCheck()).resolves.toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("maps refused local connections to a useful Ollama error", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
      code: "ECONNREFUSED",
    });
    const chat = vi.fn().mockRejectedValue(refused);
    const provider = new OllamaProvider({
      model: "llama3.3",
      host: "http://localhost:11434",
    });
    setClient(provider, { chat });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow(
      "Cannot connect to Ollama at http://localhost:11434. Is the server running?",
    );
  });

  test("health sidecar aborts long streams when Ollama goes down (after 2 consecutive failures)", async () => {
    // Phase 4 #45 changed the default consecutive-failure threshold
    // from 1 to 2 so a single transient probe blip can't kill an
    // in-flight stream. Two consecutive `healthy === false` probes
    // are required to trip the abort.
    vi.useFakeTimers();
    const healthCheck = vi.fn().mockResolvedValue(false);

    const pending = withOllamaHealthSidecar({
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
      providerName: "ollama",
    });
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  test("health sidecar treats refused local connections as provider loss (after 2 consecutive ECONNREFUSED probes)", async () => {
    vi.useFakeTimers();
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
      code: "ECONNREFUSED",
    });
    const healthCheck = vi.fn().mockRejectedValue(refused);

    const pending = withOllamaHealthSidecar({
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
      providerName: "ollama",
    });
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  test("serializes image_url data-URL parts into Ollama's images[] field", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: "llava",
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 4,
      eval_count: 1,
    });
    const provider = new OllamaProvider({
      model: "llava",
      host: "http://localhost:11434",
    });
    setClient(provider, { chat });

    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${base64}` },
          },
        ],
      },
    ]);

    expect(chat).toHaveBeenCalledTimes(1);
    const [params] = chat.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      messages: [
        {
          role: "user",
          content: "What is in this image?",
          images: [base64],
        },
      ],
    });
    // The `data:image/...;base64,` prefix must be stripped — Ollama expects
    // raw base64 in `images`, never inside `content`.
    const [message] = (params as { messages: Array<Record<string, unknown>> })
      .messages;
    expect((message?.images as string[])[0]).not.toContain("data:image");
    expect(message?.content).not.toContain("base64,");
  });

  test("passes remote HTTP image URLs through Ollama's images[] field", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: "llava",
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 4,
      eval_count: 1,
    });
    const provider = new OllamaProvider({
      model: "llava",
      host: "http://localhost:11434",
    });
    setClient(provider, { chat });

    const imageUrl = " https://example.test/cat.png ";

    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: imageUrl },
          },
        ],
      },
    ]);

    const [params] = chat.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      messages: [
        {
          role: "user",
          content: "What is in this image?",
          images: ["https://example.test/cat.png"],
        },
      ],
    });
  });

  test("keeps unsupported image URL schemes visible in Ollama text content", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: "llava",
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 4,
      eval_count: 1,
    });
    const provider = new OllamaProvider({
      model: "llava",
      host: "http://localhost:11434",
    });
    setClient(provider, { chat });

    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: "file:///tmp/cat.png" },
          },
        ],
      },
    ]);

    const [params] = chat.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      messages: [
        {
          role: "user",
          content: "What is in this image?\n[image: file:///tmp/cat.png]",
        },
      ],
    });
    const [message] = (params as { messages: Array<Record<string, unknown>> })
      .messages;
    expect(message?.images).toBeUndefined();
  });
});
