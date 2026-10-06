import { afterEach, describe, expect, it, vi } from "vitest";

import { drainAgenCTransportRequests } from "../../src/app-server/transport/request-drain.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("drainAgenCTransportRequests", () => {
  it("waits for every pending handler when no drain deadline is set", async () => {
    const settled = Promise.withResolvers<void>();
    const rejected = Promise.withResolvers<void>();
    const drain = drainAgenCTransportRequests(
      [settled.promise, rejected.promise],
      {},
    );
    settled.resolve();
    rejected.reject(new Error("handler failed"));
    await expect(drain).resolves.toBeUndefined();
  });

  it("resolves once pending work finishes inside the deadline", async () => {
    await expect(
      drainAgenCTransportRequests([Promise.resolve(), Promise.resolve()], {
        drainTimeoutMs: 50,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when the drain deadline elapses and clears the timer", async () => {
    vi.useFakeTimers();
    const hung = new Promise<void>(() => {});
    const drain = drainAgenCTransportRequests([hung], { drainTimeoutMs: 20 });
    const expectation = expect(drain).rejects.toThrow(
      "daemon transport request drain exceeded 20 ms",
    );
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive integer drain timeout (%s)",
    async (drainTimeoutMs) => {
      await expect(
        drainAgenCTransportRequests([], { drainTimeoutMs }),
      ).rejects.toThrow(TypeError);
      await expect(
        drainAgenCTransportRequests([], { drainTimeoutMs }),
      ).rejects.toThrow("daemon transport drain timeout must be a positive integer");
    },
  );
});
