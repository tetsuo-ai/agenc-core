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

function hangingStreamAfterFirstChunk(): {
  readonly stream: AsyncIterable<unknown> & { abort: () => void };
  readonly abortSpy: ReturnType<typeof vi.fn>;
  readonly returnSpy: ReturnType<typeof vi.fn>;
} {
  const abortSpy = vi.fn();
  const returnSpy = vi.fn(async () => ({ done: true, value: undefined }));
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
          return await new Promise<IteratorResult<unknown>>(() => {});
        },
        return: returnSpy,
      };
    },
  };
  return { stream, abortSpy, returnSpy };
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
      },
    );

    expect(response.content).toBe("ok");
    expect(response.model).toBe("qwen2.5-coder:7b");
    expect(response.usage).toEqual({
      promptTokens: 8,
      completionTokens: 2,
      totalTokens: 10,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    const [params] = chat.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      model: "qwen2.5-coder:7b",
      keep_alive: "10m",
      options: {
        num_predict: 64,
        num_ctx: 8192,
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

    await vi.advanceTimersByTimeAsync(10_000);
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
    expect(list).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(returnSpy).toHaveBeenCalledTimes(1);
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

  test("health sidecar aborts long streams when Ollama goes down", async () => {
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

    await vi.advanceTimersByTimeAsync(5);

    await expect(observed).resolves.toMatchObject({
      name: "LLMProviderError",
      providerName: "ollama",
    });
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  test("health sidecar treats refused local connections as provider loss", async () => {
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

    await vi.advanceTimersByTimeAsync(5);

    await expect(observed).resolves.toMatchObject({
      name: "LLMProviderError",
      providerName: "ollama",
    });
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });
});
