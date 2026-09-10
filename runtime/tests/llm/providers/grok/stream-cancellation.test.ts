import { getEventListeners } from "node:events";
import { Stream } from "openai/core/streaming";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GrokProvider } from "../../../../src/llm/providers/grok/adapter.js";
import { LLMTimeoutError } from "../../../../src/llm/errors.js";
import type { LLMChatOptions, LLMResponse, StreamProgressCallback } from "../../../../src/llm/types.js";

const cleanupStreams: Array<() => void> = [];
const pendingRequests: Promise<LLMResponse>[] = [];

function sdkStreamFixture(options: { delayAbortSettlement?: boolean } = {}) {
  const controller = new AbortController();
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(current) { bodyController = current; },
  });
  const release = () => bodyController.error(new DOMException("Fixture socket aborted", "AbortError"));
  controller.signal.addEventListener("abort", () => {
    if (options.delayAbortSettlement !== true) release();
  }, { once: true });
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  const stream = Stream.fromSSEResponse<Record<string, unknown>>(response, controller);
  const iterator = stream[Symbol.asyncIterator]();
  const next = vi.fn(() => iterator.next());
  const close = vi.fn(() => iterator.return!());
  stream[Symbol.asyncIterator] = () => ({ next, return: close });
  cleanupStreams.push(() => {
    controller.abort();
    release();
  });
  const send = (event: Record<string, unknown>) => {
    bodyController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  return {
    stream,
    controller,
    next,
    close,
    release,
    send,
    end: () => bodyController.close(),
    fail: (error: Error) => bodyController.error(error),
    request: { withResponse: async () => ({ data: stream, response, request_id: "fixture" }) },
  };
}

function providerFixture(streams: ReturnType<typeof sdkStreamFixture>[], timeoutMs?: number) {
  const provider = new GrokProvider({
    apiKey: "fixture-only",
    model: "grok-4-fast",
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  let nextStream = 0;
  const create = vi.fn(() => {
    const stream = streams[nextStream++];
    if (stream === undefined) throw new Error("Unexpected extra provider request");
    return stream.request;
  });
  Object.assign(provider, { client: { responses: { create } } });
  return { provider, create };
}

function startStream(
  provider: GrokProvider,
  options: LLMChatOptions = {},
  onChunk: StreamProgressCallback = () => {},
) {
  const request = provider.chatStream(
    [{ role: "user", content: "Fixture cancellation request" }],
    onChunk,
    { singleWireAttempt: true, ...options },
  );
  pendingRequests.push(request);
  let settled = false;
  void request.then(() => { settled = true; }, () => { settled = true; });
  return { request, settled: () => settled };
}

function completedEvent() {
  return {
    type: "response.completed",
    response: {
      id: "fixture-response",
      model: "grok-4-fast",
      status: "completed",
      output_text: "done",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanupStreams.splice(0)) cleanup();
  await Promise.allSettled(pendingRequests.splice(0));
  vi.restoreAllMocks();
});

describe("Grok SDK stream cancellation", () => {
  it.each([false, true])("aborts a pending physical SSE read after partial content=%s", async (partial) => {
    const fixture = sdkStreamFixture();
    const { provider } = providerFixture([fixture]);
    const caller = new AbortController();
    const running = startStream(provider, { signal: caller.signal });
    await vi.waitFor(() => expect(fixture.next).toHaveBeenCalledOnce());
    if (partial) {
      fixture.send({ type: "response.output_text.delta", delta: "partial" });
      await vi.waitFor(() => expect(fixture.next).toHaveBeenCalledTimes(2));
    }
    caller.abort("interrupted");
    await vi.waitFor(() => expect(fixture.controller.signal.aborted).toBe(true));
    if (partial) {
      await expect(running.request).resolves.toMatchObject({ content: "partial", finishReason: "error" });
    } else {
      await expect(running.request).rejects.toThrow();
    }
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("retains settlement until the aborted SDK reader physically finishes", async () => {
    const fixture = sdkStreamFixture({ delayAbortSettlement: true });
    const { provider } = providerFixture([fixture]);
    const caller = new AbortController();
    const running = startStream(provider, { signal: caller.signal });
    await vi.waitFor(() => expect(fixture.next).toHaveBeenCalledOnce());
    caller.abort("interrupted");
    await vi.waitFor(() => expect(fixture.controller.signal.aborted).toBe(true));
    expect(running.settled()).toBe(false);
    fixture.release();
    await expect(running.request).rejects.toThrow();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("aborts the physical SSE stream on an explicit idle timeout", async () => {
    const fixture = sdkStreamFixture();
    const { provider } = providerFixture([fixture], 100);
    const running = startStream(provider);
    await vi.waitFor(() => expect(fixture.controller.signal.aborted).toBe(true));
    await expect(running.request).rejects.toBeInstanceOf(LLMTimeoutError);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("closes an opened transport when cancelled before its first next call", async () => {
    const fixture = sdkStreamFixture();
    const { provider } = providerFixture([fixture]);
    const caller = new AbortController();
    fixture.stream[Symbol.asyncIterator] = () => {
      caller.abort("interrupted");
      return { next: fixture.next, return: fixture.close };
    };
    const running = startStream(provider, { signal: caller.signal });
    await expect(running.request).rejects.toThrow();
    expect(fixture.next).not.toHaveBeenCalled();
    expect(fixture.controller.signal.aborted).toBe(true);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("does not abort an independent concurrent stream", async () => {
    const first = sdkStreamFixture();
    const second = sdkStreamFixture();
    const { provider, create } = providerFixture([first, second]);
    const caller = new AbortController();
    const interrupted = startStream(provider, { signal: caller.signal });
    const continued = startStream(provider);
    await vi.waitFor(() => {
      expect(first.next).toHaveBeenCalledOnce();
      expect(second.next).toHaveBeenCalledOnce();
    });
    caller.abort("interrupted");
    await vi.waitFor(() => expect(first.controller.signal.aborted).toBe(true));
    await expect(interrupted.request).rejects.toThrow();
    expect(second.controller.signal.aborted).toBe(false);
    expect(continued.settled()).toBe(false);
    second.send(completedEvent());
    await expect(continued.request).resolves.toMatchObject({ content: "done", finishReason: "stop" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("keeps natural EOF distinct from cancellation and releases listeners", async () => {
    const fixture = sdkStreamFixture();
    const { provider } = providerFixture([fixture]);
    const caller = new AbortController();
    const running = startStream(provider, { signal: caller.signal });
    await vi.waitFor(() => expect(fixture.next).toHaveBeenCalledOnce());
    fixture.end();
    await expect(running.request).resolves.toMatchObject({ finishReason: "error" });
    expect(fixture.controller.signal.aborted).toBe(false);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    caller.abort("late interrupt");
    expect(fixture.controller.signal.aborted).toBe(false);
  });

  it("cleans up after a physical transport error", async () => {
    const fixture = sdkStreamFixture();
    const { provider } = providerFixture([fixture]);
    const caller = new AbortController();
    const running = startStream(provider, { signal: caller.signal });
    await vi.waitFor(() => expect(fixture.next).toHaveBeenCalledOnce());
    fixture.fail(new Error("Fixture transport failure"));
    await expect(running.request).rejects.toThrow("Fixture transport failure");
    expect(fixture.controller.signal.aborted).toBe(true);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });
});
