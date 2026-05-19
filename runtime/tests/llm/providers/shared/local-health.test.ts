import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runLocalProviderHealthSidecar } from "./local-health.js";

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
});
