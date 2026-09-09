import { EventEmitter, getEventListeners, once } from "node:events";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { connect } from "../../../packages/agenc-sdk/src/socket.js";
import { StartupDeadline } from "../../../packages/agenc-sdk/src/startup-deadline.js";
import { waitForStartupChild } from "../../../packages/agenc-sdk/src/startup-child.js";

const homes: string[] = [];

class Starter extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];
  closeOn: NodeJS.Signals | null = "SIGTERM";

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === this.closeOn) {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    }
    return true;
  }
}

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), "agenc-sdk-startup-deadline-"));
  homes.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SDK startup deadline", () => {
  test("bounds a starter that never exits", async () => {
    const child = new Starter();
    const started = connect({
      env: { AGENC_HOME: home() }, readyTimeoutMs: 10, spawn: () => child,
    });
    const result = started.then(() => ({ connected: true }), (error: unknown) => ({ error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        result,
        new Promise<{ pending: true }>((resolve) => {
          timer = setTimeout(() => resolve({ pending: true }), 300);
        }),
      ]);
      expect(outcome).not.toEqual({ pending: true });
      expect(outcome).toMatchObject({ error: expect.objectContaining({
        message: expect.stringMatching(/timeout|timed out|within.*ms/iu),
      }) });
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(child.eventNames()).toEqual([]);
      expect(child.stderr.eventNames()).toEqual([]);
    } finally {
      clearTimeout(timer);
      child.emit("exit", 1);
      child.emit("close", 1, null);
      await result;
    }
  });

  test("autostart opt-out rejects without invoking a spawner", async () => {
    await expect(connect({
      env: { AGENC_HOME: home() }, autostart: false, readyTimeoutMs: 10,
      spawn: () => { throw new Error("disabled startup spawned a child"); },
    })).rejects.toThrow("autostart is disabled");
  });

  test("reaps a real starter before rejecting the connection", async () => {
    let child: ChildProcess | undefined;
    let closed = false;
    try {
      await expect(connect({
        env: { AGENC_HOME: home() }, readyTimeoutMs: 150,
        spawn: () => {
          child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          child.once("close", () => { closed = true; });
          return child;
        },
      })).rejects.toThrow(/within 150ms/);
      expect(closed).toBe(true);
      expect(child?.pid).toBeTypeOf("number");
      expect(() => process.kill(child!.pid!, 0)).toThrow();
    } finally {
      if (child !== undefined && !closed) {
        const reaped = once(child, "close");
        child.kill("SIGKILL");
        await reaped;
      }
    }
  });

  test("passes only the remaining budget to the nested starter", async () => {
    const child = new Starter();
    const env = { AGENC_HOME: home(), AGENC_DAEMON_READY_TIMEOUT_MS: "9000" };
    let nestedBudget = 0;
    await expect(connect({
      env, readyTimeoutMs: 60,
      spawn: (_command, _args, options) => {
        nestedBudget = Number(options.env.AGENC_DAEMON_READY_TIMEOUT_MS);
        setTimeout(() => child.emit("close", 0, null), 40);
        return child;
      },
    })).rejects.toThrow(/within 60ms/);
    expect(nestedBudget).toBeGreaterThan(0);
    expect(nestedBudget).toBeLessThanOrEqual(60);
    expect(child.signals).toEqual([]);
    expect(env.AGENC_DAEMON_READY_TIMEOUT_MS).toBe("9000");
  });

  test("preserves cancellation that occurs inside a spawner", async () => {
    const controller = new AbortController();
    const reason = { stopped: "by caller" };
    const child = new Starter();
    await expect(connect({
      env: { AGENC_HOME: home() }, readyTimeoutMs: 500, signal: controller.signal,
      spawn: () => { controller.abort(reason); return child; },
    })).rejects.toBe(reason);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("does not spawn for an already cancelled caller", async () => {
    const reason = new Error("cancel before startup");
    const spawn = vi.fn(() => new Starter());
    await expect(connect({ env: { AGENC_HOME: home() }, signal: AbortSignal.abort(reason), spawn }))
      .rejects.toBe(reason);
    expect(spawn).not.toHaveBeenCalled();
  });

  test("escalates termination and waits for close rather than exit", async () => {
    vi.useFakeTimers();
    const child = new Starter();
    child.closeOn = "SIGKILL";
    const controller = new AbortController();
    const reason = new Error("cancel starter");
    const result = waitForStartupChild(child, controller.signal, () => {});
    const rejected = expect(result).rejects.toBe(reason);
    controller.abort(reason);
    child.emit("exit", null, "SIGTERM");
    expect(child.listenerCount("close")).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.eventNames()).toEqual([]);
    expect(child.stderr.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("reports cleanup failure instead of claiming an unresponsive child was reaped", async () => {
    vi.useFakeTimers();
    const child = new Starter();
    child.closeOn = null;
    const reason = new Error("stop now");
    const result = waitForStartupChild(child, AbortSignal.abort(reason), () => {});
    const rejected = expect(result).rejects.toMatchObject({
      name: "AggregateError", cause: reason, message: expect.stringContaining("did not close"),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(child.eventNames()).toEqual([]);
    expect(child.stderr.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("successful close wins once and removes cancellation and stderr listeners", async () => {
    const child = new Starter();
    const controller = new AbortController();
    const result = waitForStartupChild(child, controller.signal, () => {});
    child.emit("close", 0, null);
    controller.abort(new Error("late cancellation"));
    child.emit("close", 1, null);
    await expect(result).resolves.toBe(0);
    expect(child.signals).toEqual([]);
    expect(child.eventNames()).toEqual([]);
    expect(child.stderr.eventNames()).toEqual([]);
  });

  test("deadline removes listeners when a late operation fails", async () => {
    const deadline = new StartupDeadline(10, "startup timed out");
    let rejectOperation: (reason: unknown) => void = () => {};
    try {
      await expect(deadline.run(() => new Promise((_resolve, reject) => { rejectOperation = reject; })))
        .rejects.toThrow("startup timed out");
      rejectOperation(new Error("late failure"));
      await Promise.resolve();
      expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
    } finally {
      deadline.dispose();
    }
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects invalid readiness duration %s", async (readyTimeoutMs) => {
    const spawn = vi.fn(() => new Starter());
    await expect(connect({ env: { AGENC_HOME: home() }, readyTimeoutMs, spawn })).rejects.toThrow(/readyTimeoutMs/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
