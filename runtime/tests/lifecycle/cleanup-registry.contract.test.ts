import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AgenCCleanupRegistry } from "./cleanup-registry.js";
import {
  exitCodeForSignal,
  installAgenCShutdownSignalHandlers,
  type AgenCShutdownSignal,
} from "./signal-handlers.js";
import { summarizeAgenCShutdown } from "./shutdown-message.js";

function createSignalProcess() {
  const listeners = new Map<AgenCShutdownSignal, Set<() => void>>();
  return {
    on: vi.fn((signal: AgenCShutdownSignal, listener: () => void) => {
      let set = listeners.get(signal);
      if (set === undefined) {
        set = new Set();
        listeners.set(signal, set);
      }
      set.add(listener);
    }),
    removeListener: vi.fn(
      (signal: AgenCShutdownSignal, listener: () => void) => {
        listeners.get(signal)?.delete(listener);
      },
    ),
    emit(signal: AgenCShutdownSignal): void {
      for (const listener of [...(listeners.get(signal) ?? [])]) {
        listener();
      }
    },
    listenerCount(signal: AgenCShutdownSignal): number {
      return listeners.get(signal)?.size ?? 0;
    },
  };
}

describe("AgenC lifecycle cleanup registry", () => {
  it("runs cleanup tasks in reverse registration order exactly once", async () => {
    const registry = new AgenCCleanupRegistry();
    const calls: string[] = [];

    registry.register("first", () => {
      calls.push("first");
    });
    registry.register("second", async () => {
      calls.push("second");
    });

    await expect(
      registry.run({ reason: "daemon_shutdown" }),
    ).resolves.toMatchObject([
      { name: "second", ok: true },
      { name: "first", ok: true },
    ]);
    await registry.run({ reason: "daemon_shutdown" });

    expect(calls).toEqual(["second", "first"]);
  });

  it("records cleanup failures without skipping later tasks", async () => {
    const registry = new AgenCCleanupRegistry();
    const calls: string[] = [];

    registry.register("tail", () => {
      calls.push("tail");
    });
    registry.register("failing", () => {
      calls.push("failing");
      throw new Error("cleanup failed");
    });

    const results = await registry.run({ reason: "daemon_shutdown" });

    expect(calls).toEqual(["failing", "tail"]);
    expect(results).toMatchObject([
      { name: "failing", ok: false },
      { name: "tail", ok: true },
    ]);
  });

  // #2232: a cancelled daemon startup bounds each cleanup task so one hung
  // task cannot keep the process alive.
  it("records a task that outlives the per-task timeout and keeps going", async () => {
    const registry = new AgenCCleanupRegistry();
    const calls: string[] = [];
    registry.register("first", () => {
      calls.push("first");
    });
    registry.register("hangs", () => new Promise<void>(() => {}));
    registry.register("last", () => {
      calls.push("last");
    });
    const started = Date.now();
    const results = await registry.run(
      { reason: "daemon_shutdown" },
      { taskTimeoutMs: 20 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toEqual(["last", "first"]);
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["last", true],
      ["hangs", false],
      ["first", true],
    ]);
    expect(String(results[1]?.error)).toContain(
      'cleanup task "hangs" did not finish within 20 ms',
    );
  });

  it("does not bound tasks when no timeout is given", async () => {
    const registry = new AgenCCleanupRegistry();
    registry.register("slow", () => new Promise<void>((resolve) => setTimeout(resolve, 30)));
    const results = await registry.run({ reason: "daemon_shutdown" });
    expect(results).toEqual([{ name: "slow", ok: true }]);
  });

  it("unregisters cleanup tasks before shutdown starts", async () => {
    const registry = new AgenCCleanupRegistry();
    const cleanup = vi.fn();
    const unregister = registry.register("optional", cleanup);
    unregister();

    await registry.run({ reason: "daemon_shutdown" });

    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe("AgenC lifecycle signal handlers", () => {
  it.each(["throw", "reject"] as const)(
    "completes the shutdown signal when its callback %ss",
    async (mode) => {
      const proc = new EventEmitter();
      const handle = installAgenCShutdownSignalHandlers(() => {
        const error = new Error("signal callback failed");
        if (mode === "throw") throw error;
        return Promise.reject(error);
      }, proc);
      try {
        expect(() => proc.emit("SIGTERM")).not.toThrow();
        await expect(handle.completed).resolves.toMatchObject({ signal: "SIGTERM" });
      } finally {
        handle.dispose();
      }
    },
  );

  it("retains signal ownership until cleanup explicitly disposes the handle", async () => {
    const proc = new EventEmitter();
    const seen = vi.fn();
    const handle = installAgenCShutdownSignalHandlers(seen, proc);
    try {
      proc.emit("SIGTERM");
      await handle.completed;
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        expect(proc.listenerCount(signal)).toBe(1);
        proc.emit(signal);
      }
      expect(seen).toHaveBeenCalledOnce();
    } finally {
      handle.dispose();
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(proc.listenerCount(signal)).toBe(0);
    }
  });

  it("maps daemon shutdown signals to cleanup events and exit codes", async () => {
    const proc = createSignalProcess();
    const seen: unknown[] = [];
    const handle = installAgenCShutdownSignalHandlers((event) => {
      seen.push(event);
    }, proc);

    proc.emit("SIGTERM");
    await expect(handle.completed).resolves.toMatchObject({
      reason: "signal",
      signal: "SIGTERM",
      exitCode: 0,
    });

    expect(seen).toMatchObject([
      { reason: "signal", signal: "SIGTERM", exitCode: 0 },
    ]);
    handle.dispose();
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("SIGHUP")).toBe(0);
  });

  it("ignores later signals once shutdown has started", async () => {
    const proc = createSignalProcess();
    const seen: unknown[] = [];
    const handle = installAgenCShutdownSignalHandlers((event) => {
      seen.push(event);
    }, proc);

    proc.emit("SIGINT");
    proc.emit("SIGHUP");
    await handle.completed;

    expect(seen).toMatchObject([
      { reason: "signal", signal: "SIGINT", exitCode: 130 },
    ]);
    handle.dispose();
  });

  it("summarizes shutdown signals without UI dependencies", () => {
    expect(exitCodeForSignal("SIGHUP")).toBe(130);
    expect(
      summarizeAgenCShutdown({
        reason: "signal",
        signal: "SIGHUP",
        exitCode: 130,
      }),
    ).toBe("AgenC daemon received SIGHUP; treating terminal loss as shutdown");
  });
});
