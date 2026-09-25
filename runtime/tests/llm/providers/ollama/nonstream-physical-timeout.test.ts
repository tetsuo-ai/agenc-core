import { getEventListeners } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

import { LLMProviderError, LLMTimeoutError } from "../../../../src/llm/errors.js";
import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";
import { hangingStreamAfterFirstChunk } from "./ollama-test-helpers.js";

function setClient(
  provider: OllamaProvider,
  client: { readonly chat?: unknown; readonly list?: unknown; readonly abort?: unknown },
): void {
  (provider as unknown as { client: unknown }).client = client;
}

function hangingAbortAwareChat(): {
  readonly chat: (
    params: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
  readonly started: Promise<void>;
  readonly receivedSignal: () => AbortSignal | undefined;
  readonly physicalLive: () => boolean;
  readonly settleCount: () => number;
  readonly abortSeen: Promise<unknown>;
  readonly resolvePhysical: (value: unknown) => void;
} {
  let receivedSignal: AbortSignal | undefined;
  let physicalLive = false;
  let settleCount = 0;
  const started = Promise.withResolvers<void>();
  const abortSeen = Promise.withResolvers<unknown>();
  const physical = Promise.withResolvers<unknown>();
  const settlePhysical = (kind: "resolve" | "reject", value: unknown): void => {
    if (!physicalLive) return;
    physicalLive = false;
    settleCount += 1;
    if (kind === "resolve") physical.resolve(value);
    else physical.reject(value);
  };

  return {
    chat: (_params, options) => {
      physicalLive = true;
      receivedSignal = options?.signal;
      started.resolve();
      const signal = options?.signal;
      if (signal === undefined) return physical.promise;
      const onAbort = (): void => {
        abortSeen.resolve(signal.reason);
        settlePhysical("reject", signal.reason ?? new Error("aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return physical.promise.finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    },
    started: started.promise,
    receivedSignal: () => receivedSignal,
    physicalLive: () => physicalLive,
    settleCount: () => settleCount,
    abortSeen: abortSeen.promise,
    resolvePhysical: (value) => settlePhysical("resolve", value),
  };
}

function okChatResponse(): Record<string, unknown> {
  return {
    model: "llama3.3",
    message: { role: "assistant", content: "ok" },
    prompt_eval_count: 4,
    eval_count: 1,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Ollama non-streaming physical timeout and cancellation", () => {
  test("a hanging fake request observes abort and settles near the configured timeout", async () => {
    const hanging = hangingAbortAwareChat();
    const provider = new OllamaProvider({ model: "llama3.3" });
    setClient(provider, { chat: hanging.chat });
    let leaseLive = true;

    const pending = provider.chat(
      [{ role: "user", content: "hello" }],
      { timeoutMs: 5, singleWireAttempt: true },
    ).finally(() => {
      leaseLive = false;
    });
    await hanging.started;
    const observed = pending.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    const raced = Promise.race([
      observed,
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 500);
      }),
    ]);

    const result = await raced;
    expect(result).not.toBe("still-pending");
    expect(result).toBeInstanceOf(LLMTimeoutError);
    expect((result as Error).message).toContain("timed out after 5ms");
    expect(hanging.receivedSignal()?.aborted).toBe(true);
    expect(hanging.physicalLive()).toBe(false);
    expect(leaseLive).toBe(false);
    expect(hanging.settleCount()).toBe(1);
    await expect(pending).rejects.toBe(result);
  });

  test("caller cancellation preserves its reason and settles the physical request promptly", async () => {
    const hanging = hangingAbortAwareChat();
    const provider = new OllamaProvider({ model: "llama3.3" });
    setClient(provider, { chat: hanging.chat });
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    let leaseLive = true;

    const pending = provider.chat(
      [{ role: "user", content: "hello" }],
      { signal: controller.signal, timeoutMs: 60_000, singleWireAttempt: true },
    ).finally(() => {
      leaseLive = false;
    });
    const observed = pending.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await hanging.started;
    expect(hanging.physicalLive()).toBe(true);
    expect(leaseLive).toBe(true);

    controller.abort(reason);
    const raced = Promise.race([
      observed,
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 500);
      }),
    ]);

    const result = await raced;
    expect(result).not.toBe("still-pending");
    expect(result).toBeInstanceOf(LLMProviderError);
    expect(result).not.toBeInstanceOf(LLMTimeoutError);
    expect((result as Error).message).toContain("caller cancelled");
    expect((result as { cause?: unknown }).cause).toBe(reason);
    expect(hanging.receivedSignal()?.aborted).toBe(true);
    expect(await hanging.abortSeen).toBe(reason);
    expect(hanging.physicalLive()).toBe(false);
    expect(leaseLive).toBe(false);
    expect(hanging.settleCount()).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  test("a late response after timeout cannot settle the adapter a second time", async () => {
    const hanging = hangingAbortAwareChat();
    const provider = new OllamaProvider({ model: "llama3.3" });
    setClient(provider, { chat: hanging.chat });
    let settlements = 0;

    const pending = provider.chat(
      [{ role: "user", content: "hello" }],
      { timeoutMs: 5, singleWireAttempt: true },
    );
    void pending.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await hanging.started;

    await expect(
      Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("adapter-still-pending")), 80);
        }),
      ]),
    ).rejects.toBeInstanceOf(LLMTimeoutError);
    hanging.resolvePhysical(okChatResponse());
    await Promise.resolve();

    expect(settlements).toBe(1);
    expect(hanging.settleCount()).toBe(1);
    expect(hanging.physicalLive()).toBe(false);
  });

  test("a late response after caller cancel cannot replace the preserved reason", async () => {
    const hanging = hangingAbortAwareChat();
    const provider = new OllamaProvider({ model: "llama3.3" });
    setClient(provider, { chat: hanging.chat });
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    let settlements = 0;

    const pending = provider.chat(
      [{ role: "user", content: "hello" }],
      { signal: controller.signal, timeoutMs: 60_000, singleWireAttempt: true },
    );
    void pending.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await hanging.started;
    controller.abort(reason);

    await expect(
      Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("adapter-still-pending")), 80);
        }),
      ]),
    ).rejects.toMatchObject({
      name: "LLMProviderError",
      message: expect.stringContaining("caller cancelled"),
    });
    hanging.resolvePhysical(okChatResponse());
    await Promise.resolve();

    expect(settlements).toBe(1);
    expect(hanging.settleCount()).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  test("a completed response wins a race against a later timeout and cleans listeners", async () => {
    const controller = new AbortController();
    const provider = new OllamaProvider({ model: "llama3.3" });
    const chat = vi.fn(async (
      _params: Record<string, unknown>,
      options?: { readonly signal?: AbortSignal },
    ) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.signal?.aborted).toBe(false);
      return okChatResponse();
    });
    setClient(provider, { chat });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { signal: controller.signal, timeoutMs: 60_000, singleWireAttempt: true },
    );

    expect(response.content).toBe("ok");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[1]).toEqual({ signal: expect.any(AbortSignal) });
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    controller.abort(new Error("late cancel"));
    await Promise.resolve();
    expect(response.content).toBe("ok");
  });

  test("streaming chat remains abortable through the existing client.abort path", async () => {
    vi.useFakeTimers();
    const { stream, abortSpy } = hangingStreamAfterFirstChunk();
    const chat = vi.fn(async () => stream);
    const provider = new OllamaProvider({ model: "llama3.3" });
    setClient(provider, {
      chat,
      abort: abortSpy,
      list: vi.fn().mockResolvedValue({ models: [] }),
    });
    const controller = new AbortController();

    const running = provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => {},
      { signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("caller cancelled"));
    await vi.advanceTimersByTimeAsync(0);

    expect(chat.mock.calls[0]).toHaveLength(1);
    expect(abortSpy).toHaveBeenCalled();
    await expect(running).resolves.toMatchObject({
      content: "hel",
      partial: true,
      finishReason: "error",
    });
  });

  test("successful non-streaming chat still returns content when the fake settles", async () => {
    const chat = vi.fn(async (
      _params: Record<string, unknown>,
      options?: { readonly signal?: AbortSignal },
    ) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return okChatResponse();
    });
    const provider = new OllamaProvider({ model: "llama3.3" });
    setClient(provider, { chat });

    const response = await provider.chat([{ role: "user", content: "hello" }]);
    expect(response.content).toBe("ok");
    expect(chat.mock.calls[0]).toHaveLength(2);
  });
});
