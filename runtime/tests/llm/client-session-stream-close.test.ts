import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderHttpClientSession } from "../../src/llm/client-session.js";
import { createControlledPromise, drainMicrotasks, settleWithinMicrotasks } from "../helpers/controlled-async.js";

function fixture(cancelImpl: () => void | Promise<void> = () => undefined) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(cancelImpl);
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel });
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.signal) signals.push(init.signal);
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const caller = new AbortController();
  const session = new ProviderHttpClientSession({
    providerName: "fixture", baseURL: "https://fixture.invalid", wireApi: "chat_completions",
    streamIdleTimeoutMs: 50, streamRetry: { maxRetries: 2 }, fetchImpl,
  });
  return { body, controller, cancel, signals, fetchImpl, caller, session };
}

function clean(f: ReturnType<typeof fixture>) {
  expect(f.body.locked).toBe(false);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(getEventListeners(f.caller.signal, "abort")).toHaveLength(0);
  for (const signal of f.signals) expect(getEventListeners(signal, "abort")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe("successful stream iterator ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test.each(["return", "break", "consumer throw"])("cancels unread body on %s", async mode => {
    const f = fixture();
    const reason = new Error("consumer failure");
    f.controller.enqueue(new Uint8Array([1]));
    const response = await f.session.requestStream({ signal: f.caller.signal });
    if (mode === "return") {
      const iterator = response[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
    } else {
      const consume = async () => {
        for await (const _chunk of response) {
          if (mode === "consumer throw") throw reason;
          break;
        }
      };
      if (mode === "consumer throw") await expect(consume()).rejects.toBe(reason);
      else await consume();
    }
    expect(f.cancel).toHaveBeenCalledTimes(1);
    clean(f);
  });

  test.each(["throw", "reject", "stall"])("does not await %s cancellation", async mode => {
    const gate = createControlledPromise<void>();
    const f = fixture(() => {
      if (mode === "throw") throw new Error("cancel failure");
      return mode === "reject" ? Promise.reject(new Error("cancel failure")) : gate.promise;
    });
    f.controller.enqueue(new Uint8Array([1]));
    const response = await f.session.requestStream({ signal: f.caller.signal });
    const iterator = response[Symbol.asyncIterator]();
    try {
      await iterator.next();
      expect(await settleWithinMicrotasks(iterator.return!())).toMatchObject({ status: "fulfilled" });
      expect(f.cancel).toHaveBeenCalledTimes(1);
      clean(f);
    } finally { gate.resolve(); }
  });

  test.each([new Error("socket hang up"), null, undefined])("preserves injected consumer failure without replay: %s", async reason => {
    const f = fixture(() => Promise.reject(new Error("cancel failure")));
    f.controller.enqueue(new Uint8Array([1]));
    const response = await f.session.requestStream({ signal: f.caller.signal });
    const iterator = response[Symbol.asyncIterator]();
    await iterator.next();
    const result = await settleWithinMicrotasks(iterator.throw!(reason));
    expect(result).toMatchObject({ status: "rejected", reason });
    if (result.status === "rejected") expect(result.reason).toBe(reason);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    clean(f);
  });

  test("caller cancellation with transport-shaped reason is not retried", async () => {
    const f = fixture();
    const reason = new Error("socket hang up");
    const response = await f.session.requestStream({ signal: f.caller.signal });
    const observed = response[Symbol.asyncIterator]().next().catch(error => error);
    await drainMicrotasks(20);
    f.caller.abort(reason);
    expect(await settleWithinMicrotasks(observed)).toMatchObject({ status: "fulfilled", value: reason });
    expect(await observed).toBe(reason);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    clean(f);
  });

  test("configured request deadline cancels the body and cleans up", async () => {
    const f = fixture();
    const response = await f.session.requestStream({ signal: f.caller.signal, timeoutMs: 25 });
    const observed = response[Symbol.asyncIterator]().next().catch(error => error);
    await drainMicrotasks(20);
    vi.advanceTimersByTime(25);
    expect(await settleWithinMicrotasks(observed)).toMatchObject({
      status: "fulfilled", value: { message: expect.stringContaining("timed out") },
    });
    expect(f.cancel).toHaveBeenCalledTimes(1);
    clean(f);
  });

  test("physical EOF releases without cancellation", async () => {
    const f = fixture();
    f.controller.enqueue(new Uint8Array([1]));
    f.controller.close();
    const response = await f.session.requestStream({ signal: f.caller.signal });
    const values = [];
    for await (const chunk of response) values.push(chunk.value);
    expect(values).toHaveLength(1);
    expect(f.cancel).not.toHaveBeenCalled();
    clean(f);
  });

  test.each(["caller", "idle"])("cancels stalled successful body on %s abort", async mode => {
    const f = fixture(() => new Promise<void>(() => {}));
    const reason = new DOMException("caller cancelled", "AbortError");
    const response = await f.session.requestStream({ signal: f.caller.signal });
    const pending = response[Symbol.asyncIterator]().next();
    const observed = pending.catch(error => error);
    try {
      await drainMicrotasks(20);
      if (mode === "caller") f.caller.abort(reason);
      else vi.advanceTimersByTime(50);
      const result = await settleWithinMicrotasks(observed);
      expect(result).toMatchObject({ status: "fulfilled", value: mode === "caller" ? reason : { message: "fixture stream idle for 50ms" } });
      expect(f.cancel).toHaveBeenCalledTimes(1);
      clean(f);
    } finally {
      f.caller.abort(reason);
      f.controller.error(reason);
      await observed;
    }
  });

  test("read error after yielded bytes retains failure and never retries", async () => {
    const f = fixture();
    const reason = new Error("socket hang up");
    f.controller.enqueue(new Uint8Array([1]));
    const response = await f.session.requestStream({ signal: f.caller.signal });
    const iterator = response[Symbol.asyncIterator]();
    await iterator.next();
    f.controller.error(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    // Native ReadableStream.cancel on an already errored body rejects without invoking its source hook.
    expect(f.cancel).not.toHaveBeenCalled();
    clean(f);
  });
});
