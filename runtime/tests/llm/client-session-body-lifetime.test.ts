import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ProviderHttpClientSession,
  ProviderHttpError,
} from "../../src/llm/client-session.js";
import { LLMCaptivePortalError } from "../../src/llm/errors.js";
import {
  createControlledPromise,
  drainMicrotasks,
  settleWithinMicrotasks,
} from "../helpers/controlled-async.js";

type RequestMode = "json" | "text" | "stream";

function createBodyFixture(options: {
  status?: number;
  contentType?: string;
  cancel?: () => Promise<void>;
} = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(options.cancel ?? (() => undefined));
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel,
  });
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.signal) signals.push(init.signal);
    return new Response(body, {
      status: options.status ?? 200,
      headers: { "content-type": options.contentType ?? "application/json" },
    });
  });
  const session = new ProviderHttpClientSession({
    providerName: "fixture",
    baseURL: "https://fixture.invalid",
    wireApi: "chat_completions",
    timeoutMs: 50,
    requestRetry: { maxRetries: 2 },
    streamRetry: { maxRetries: 2 },
    fetchImpl,
  });
  return {
    body, controller, cancel, signals, fetchImpl, session,
    dispose: () => controller.error(new Error("fixture cleanup")),
  };
}

function startRequest(
  session: ProviderHttpClientSession,
  mode: RequestMode,
  signal?: AbortSignal,
): Promise<unknown> {
  if (mode === "text") return session.requestText({ signal });
  if (mode === "stream") return session.requestStream({ signal });
  return session.requestJson({ signal });
}

function expectCancelledBody(fixture: ReturnType<typeof createBodyFixture>, caller: AbortController): void {
  expect(fixture.signals[0]?.aborted).toBe(true);
  expect(fixture.cancel).toHaveBeenCalledTimes(1);
  expect(fixture.body.locked).toBe(false);
  expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
}

const stalledCases: Array<{ mode: RequestMode; status: number }> = [
  { mode: "json", status: 200 },
  { mode: "text", status: 200 },
  { mode: "json", status: 503 },
  { mode: "stream", status: 503 },
];

describe("provider response body lifetime", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test.each(stalledCases)("times out stalled $mode/$status bodies without replay", async ({ mode, status }) => {
    const fixture = createBodyFixture({ status });
    const caller = new AbortController();
    const observed = startRequest(fixture.session, mode, caller.signal).catch(error => error);
    try {
      await drainMicrotasks(20);
      expect(fixture.body.locked).toBe(true);
      vi.advanceTimersByTime(50);
      expect(await settleWithinMicrotasks(observed)).toMatchObject({
        status: "fulfilled", value: { message: expect.stringContaining("timed out") },
      });
      expectCancelledBody(fixture, caller);
    } finally {
      caller.abort(new DOMException("fixture cleanup", "AbortError"));
      fixture.dispose();
      await observed;
    }
  });

  test.each(stalledCases)("cancels stalled $mode/$status bodies after headers", async ({ mode, status }) => {
    const fixture = createBodyFixture({ status });
    const caller = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    const observed = startRequest(fixture.session, mode, caller.signal).catch(error => error);
    try {
      await drainMicrotasks(20);
      caller.abort(reason);
      expect(await settleWithinMicrotasks(observed)).toMatchObject({ status: "fulfilled", value: reason });
      expectCancelledBody(fixture, caller);
    } finally {
      caller.abort(new DOMException("fixture cleanup", "AbortError"));
      fixture.dispose();
      await observed;
    }
  });

  test.each(["json", "text"] as const)("releases %s body timers and listeners after success", async mode => {
    const fixture = createBodyFixture();
    const caller = new AbortController();
    const pending = startRequest(fixture.session, mode, caller.signal).catch(error => error);
    const encoded = new TextEncoder().encode('{"value":"café"}');
    try {
      await drainMicrotasks(20);
      vi.advanceTimersByTime(49);
      fixture.controller.enqueue(encoded.slice(0, 14));
      fixture.controller.enqueue(encoded.slice(14));
      fixture.controller.close();
      await expect(pending).resolves.toMatchObject({
        data: mode === "json" ? { value: "café" } : '{"value":"café"}',
      });
      expect(fixture.cancel).not.toHaveBeenCalled();
      expect(fixture.body.locked).toBe(false);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(100);
      expect(fixture.signals[0]?.aborted).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  test.each(["json", "stream"] as const)("releases %s error-body resources after a complete response", async mode => {
    const fixture = createBodyFixture({ status: 401 });
    const caller = new AbortController();
    const observed = startRequest(fixture.session, mode, caller.signal).catch(error => error);
    try {
      await drainMicrotasks(20);
      fixture.controller.enqueue(new TextEncoder().encode('{"error":{"message":"expired"}}'));
      fixture.controller.close();
      expect(await observed).toMatchObject({
        name: "ProviderHttpError", status: 401, message: "expired",
      });
      expect(fixture.cancel).not.toHaveBeenCalled();
      expect(fixture.body.locked).toBe(false);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  test.each(["json", "stream"] as const)("cancels an unread %s HTML body on early rejection", async mode => {
    const fixture = createBodyFixture({ contentType: "text/html" });
    const caller = new AbortController();
    try {
      await expect(startRequest(fixture.session, mode, caller.signal)).rejects.toBeInstanceOf(LLMCaptivePortalError);
      expect(fixture.cancel).toHaveBeenCalledTimes(1);
      expect(fixture.body.locked).toBe(false);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  test("does not wait for a stalled body cancellation callback", async () => {
    const cancellationGate = createControlledPromise<void>();
    const fixture = createBodyFixture({ cancel: () => cancellationGate.promise });
    const caller = new AbortController();
    const observed = fixture.session.requestJson({ signal: caller.signal }).catch(error => error);
    try {
      await drainMicrotasks(20);
      caller.abort(new DOMException("caller cancelled", "AbortError"));
      expect(await settleWithinMicrotasks(observed)).toMatchObject({
        status: "fulfilled", value: { name: "AbortError" },
      });
      expect(fixture.cancel).toHaveBeenCalledTimes(1);
      expect(fixture.body.locked).toBe(false);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cancellationGate.resolve();
      fixture.dispose();
      await observed;
    }
  });

  test("does not replay a successful response after its body fails", async () => {
    const fixture = createBodyFixture();
    const caller = new AbortController();
    const failure = new Error("body socket ECONNRESET");
    const observed = fixture.session.requestJson({ signal: caller.signal }).catch(error => error);
    await drainMicrotasks(20);
    fixture.controller.error(failure);
    expect(await observed).toBe(failure);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fixture.body.locked).toBe(false);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("preserves HTTP errors when a non-abort error body fails", async () => {
    const fixture = createBodyFixture({ status: 401 });
    const observed = fixture.session.requestJson({}).catch(error => error);
    await drainMicrotasks(20);
    fixture.controller.error(new Error("error body socket ECONNRESET"));
    expect(await observed).toBeInstanceOf(ProviderHttpError);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fixture.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
