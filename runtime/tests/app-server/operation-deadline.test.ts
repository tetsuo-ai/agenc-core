import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DAEMON_AGENT_CREATE_TIMEOUT_MS,
  DAEMON_AGENT_HARD_STOP_TIMEOUT_MS,
  DAEMON_AGENT_STOP_TIMEOUT_MS,
  DaemonOperationScope,
  DaemonOperationTimeoutError,
} from "../../src/app-server/operation-deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("DaemonOperationScope", () => {
  it.each([
    { label: "zero", timeoutMs: 0 },
    { label: "negative", timeoutMs: -1 },
    { label: "fractional", timeoutMs: 1.5 },
    { label: "NaN", timeoutMs: Number.NaN },
    { label: "above signed 32-bit", timeoutMs: 2_147_483_648 },
  ])("rejects a $label timeout before starting a timer", ({ timeoutMs }) => {
    expect(() => new DaemonOperationScope("agent.create", timeoutMs)).toThrow(
      RangeError,
    );
    expect(() => new DaemonOperationScope("agent.create", timeoutMs)).toThrow(
      "daemon operation timeout must be a positive timer interval",
    );
  });

  it("resolves wait before the deadline and still reports the later timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scope = new DaemonOperationScope("agent.create", 1_000);
    try {
      await expect(scope.wait(async () => "ready")).resolves.toBe("ready");
      const timedOut = scope.wait(async () => new Promise(() => {}));
      const outcome = timedOut.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(DaemonOperationTimeoutError);
      expect(error).toMatchObject({
        name: "DaemonOperationTimeoutError",
        code: "DAEMON_OPERATION_TIMEOUT",
        operation: "agent.create",
        timeoutMs: 1_000,
        message: "agent.create exceeded 1000ms",
      });
    } finally {
      scope.dispose();
    }
  });

  it("aborts from an already-cancelled parent before the first wait", async () => {
    const parent = new AbortController();
    parent.abort(new Error("caller cancelled"));
    const scope = new DaemonOperationScope(
      "agent.create",
      30_000,
      parent.signal,
    );
    try {
      expect(scope.signal.aborted).toBe(true);
      await expect(scope.wait(async () => "ready")).rejects.toThrow(
        "caller cancelled",
      );
    } finally {
      scope.dispose();
    }
  });

  it("propagates a parent abort that arrives while wait is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const parent = new AbortController();
    const scope = new DaemonOperationScope(
      "agent.stop",
      30_000,
      parent.signal,
    );
    try {
      const pending = scope.wait(async () => new Promise(() => {}));
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      parent.abort(new Error("user stop"));
      expect(scope.signal.aborted).toBe(true);
      expect(await outcome).toMatchObject({ message: "user stop" });
    } finally {
      scope.dispose();
    }
  });

  it("dispose clears the timer so a later tick cannot abort the scope", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scope = new DaemonOperationScope("agent.create", 5_000);
    scope.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scope.signal.aborted).toBe(false);
    await expect(scope.wait(async () => "still open")).resolves.toBe(
      "still open",
    );
  });
});

describe("daemon operation timeout constants", () => {
  it("keeps the production create and stop bounds", () => {
    expect(DAEMON_AGENT_CREATE_TIMEOUT_MS).toBe(120_000);
    expect(DAEMON_AGENT_STOP_TIMEOUT_MS).toBe(30_000);
    expect(DAEMON_AGENT_HARD_STOP_TIMEOUT_MS).toBe(5_000);
  });
});
