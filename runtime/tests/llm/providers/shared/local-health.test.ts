import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runLocalProviderHealthSidecar } from "./local-health.js";

function signalThatAbortsBeforeListenerAttaches(
  controller: AbortController,
  reason: unknown,
): AbortSignal {
  return new Proxy(controller.signal, {
    get(target, prop, receiver) {
      if (prop === "addEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (type === "abort" && !target.aborted) {
            controller.abort(reason);
          }
          return target.addEventListener(type, listener, options);
        };
      }
      if (prop === "removeEventListener") {
        return target.removeEventListener.bind(target);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("runLocalProviderHealthSidecar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("does not abort on a single probe failure (regression: previously aborted on first)", async () => {
    // The previous implementation aborted the operation as soon as
    // `healthCheck()` returned false once. A transient blip — a brief
    // restart of lmstudio between turns, a probe firing during a busy
    // window — would kill the user's in-flight stream. The fix
    // requires N consecutive failures before aborting.
    const probeResults = [false]; // one failure, then never probed again
    let probeIndex = 0;
    const healthCheck = vi.fn(async () => {
      const result = probeResults[probeIndex] ?? true;
      probeIndex += 1;
      return result;
    });

    let receivedSignal: AbortSignal | undefined;
    const operation = vi.fn(async (signal: AbortSignal) => {
      receivedSignal = signal;
      // Simulate a streamed operation that takes ~25s. Probe fires
      // every 100ms in this test, so the single failure happens at
      // t=100ms. Operation should complete successfully because one
      // failure is below the threshold (default 2).
      await vi.advanceTimersByTimeAsync(250);
      return "ok";
    });

    const promise = runLocalProviderHealthSidecar({
      providerLabel: "test",
      operation,
      healthCheck,
      intervalMs: 100,
    });

    const result = await promise;
    expect(result).toBe("ok");
    expect(receivedSignal?.aborted).toBe(false);
  });

  test("aborts on N consecutive failures (default threshold = 2)", async () => {
    const healthCheck = vi.fn(async () => false); // every probe fails

    let receivedSignal: AbortSignal | undefined;
    let abortReason: unknown;
    const operation = vi.fn(async (signal: AbortSignal) => {
      receivedSignal = signal;
      signal.addEventListener("abort", () => {
        abortReason = signal.reason;
      });
      await vi.advanceTimersByTimeAsync(500);
      // The signal should have aborted by now (2 probes at 100ms = 200ms)
      if (signal.aborted) {
        const err = new Error("operation aborted");
        (err as { cause?: unknown }).cause = signal.reason;
        throw err;
      }
      return "ok";
    });

    await expect(
      runLocalProviderHealthSidecar({
        providerLabel: "test",
        operation,
        healthCheck,
        intervalMs: 100,
      }),
    ).rejects.toThrow(/local provider lost connection/);

    expect(receivedSignal?.aborted).toBe(true);
    expect(String(abortReason)).toMatch(/local provider lost connection/);
  });

  test("a successful probe between failures resets the counter", async () => {
    // failure → success → failure → success: never reaches 2
    // consecutive, so never aborts.
    const probeResults = [false, true, false, true, false, true, false, true];
    let probeIndex = 0;
    const healthCheck = vi.fn(async () => {
      const result = probeResults[probeIndex] ?? true;
      probeIndex += 1;
      return result;
    });

    const operation = vi.fn(async (signal: AbortSignal) => {
      await vi.advanceTimersByTimeAsync(900);
      if (signal.aborted) throw new Error("unexpected abort");
      return "ok";
    });

    const result = await runLocalProviderHealthSidecar({
      providerLabel: "test",
      operation,
      healthCheck,
      intervalMs: 100,
    });
    expect(result).toBe("ok");
  });

  test("custom threshold of 1 restores the prior abort-on-first-failure behavior", async () => {
    // Test that the consecutiveFailureThreshold parameter is honored —
    // operators or tests can opt back into the old behavior if they
    // need it.
    const healthCheck = vi.fn(async () => false);

    const operation = vi.fn(async (signal: AbortSignal) => {
      await vi.advanceTimersByTimeAsync(200);
      if (signal.aborted) throw new Error("aborted");
      return "ok";
    });

    await expect(
      runLocalProviderHealthSidecar({
        providerLabel: "test",
        operation,
        healthCheck,
        intervalMs: 50,
        consecutiveFailureThreshold: 1,
      }),
    ).rejects.toThrow(/aborted|local provider lost connection/);
  });

  test("ECONNREFUSED probe errors count as failures", async () => {
    const healthCheck = vi.fn(async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:1234");
      (err as { code?: string }).code = "ECONNREFUSED";
      throw err;
    });

    const operation = vi.fn(async (signal: AbortSignal) => {
      await vi.advanceTimersByTimeAsync(500);
      if (signal.aborted) throw new Error("aborted");
      return "ok";
    });

    await expect(
      runLocalProviderHealthSidecar({
        providerLabel: "test",
        operation,
        healthCheck,
        intervalMs: 100,
      }),
    ).rejects.toThrow(/aborted|local provider lost connection/);
  });

  test("non-ECONNREFUSED probe errors are swallowed and do not count as failures", async () => {
    // Other probe errors (e.g. transient DNS, TLS handshake) should
    // not trip the abort. The intent is to abort only on confirmed
    // server-down conditions, not on probe-machinery flakes.
    const healthCheck = vi.fn(async () => {
      throw new Error("AbortError"); // arbitrary non-ECONNREFUSED error
    });

    const operation = vi.fn(async (signal: AbortSignal) => {
      await vi.advanceTimersByTimeAsync(500);
      if (signal.aborted) throw new Error("unexpected abort");
      return "ok";
    });

    const result = await runLocalProviderHealthSidecar({
      providerLabel: "test",
      operation,
      healthCheck,
      intervalMs: 50,
    });
    expect(result).toBe("ok");
  });

  test("rejects a pre-aborted signal without starting provider work or a health timer", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before health sidecar");
    controller.abort(reason);

    const healthCheck = vi.fn(async () => true);
    const operation = vi.fn(async () => "should-not-run");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    await expect(
      runLocalProviderHealthSidecar({
        providerLabel: "test",
        operation,
        healthCheck,
        signal: controller.signal,
        intervalMs: 50,
      }),
    ).rejects.toBe(reason);

    expect(operation).not.toHaveBeenCalled();
    expect(healthCheck).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    intervalSpy.mockRestore();
  });

  test("does not lose an abort that arrives between setup and operation start", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during sidecar setup");
    const healthCheck = vi.fn(async () => true);
    const operation = vi.fn(async () => "should-not-run");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const signal = signalThatAbortsBeforeListenerAttaches(controller, reason);

    await expect(
      runLocalProviderHealthSidecar({
        providerLabel: "test",
        operation,
        healthCheck,
        signal,
        intervalMs: 50,
      }),
    ).rejects.toBe(reason);

    expect(operation).not.toHaveBeenCalled();
    expect(healthCheck).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    intervalSpy.mockRestore();
  });

  test("does not lose an abort that fires after the listener is attached and before the operation runs", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled after listen, before operation");
    const healthCheck = vi.fn(async () => true);
    const started = vi.fn();

    await expect(
      runLocalProviderHealthSidecar({
        providerLabel: "test",
        healthCheck,
        signal: controller.signal,
        intervalMs: 50,
        get operation() {
          controller.abort(reason);
          return async () => {
            started();
            return "should-not-run";
          };
        },
      }),
    ).rejects.toBe(reason);

    expect(started).not.toHaveBeenCalled();
    expect(healthCheck).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("propagates an in-flight caller abort through the derived signal and its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled mid-operation");
    const healthCheck = vi.fn(async () => true);
    let receivedSignal: AbortSignal | undefined;

    const operation = vi.fn(async (signal: AbortSignal) => {
      receivedSignal = signal;
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        controller.abort(reason);
      });
    });

    await expect(
      runLocalProviderHealthSidecar({
        providerLabel: "test",
        operation,
        healthCheck,
        signal: controller.signal,
        intervalMs: 10_000,
      }),
    ).rejects.toBe(reason);

    expect(operation).toHaveBeenCalledOnce();
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("completes normally and removes the abort listener when the caller signal stays live", async () => {
    const controller = new AbortController();
    const healthCheck = vi.fn(async () => true);
    const operation = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return "ok";
    });

    await expect(
      runLocalProviderHealthSidecar({
        providerLabel: "test",
        operation,
        healthCheck,
        signal: controller.signal,
        intervalMs: 50,
      }),
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledOnce();
    expect(healthCheck).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
