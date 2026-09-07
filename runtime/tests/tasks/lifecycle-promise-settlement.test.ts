import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackgroundTaskError,
  BackgroundTaskLifecycle,
} from "../../src/tasks/lifecycle.js";
import { logError } from "../../src/utils/log.js";

vi.mock("../../src/utils/log.js", () => ({ logError: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function registerTask(): BackgroundTaskLifecycle {
  const lifecycle = new BackgroundTaskLifecycle();
  lifecycle.register({ id: "task", type: "generic", description: "map result" });
  return lifecycle;
}

describe("background task promise settlement", () => {
  it.each(["throw", "reject"] as const)(
    "marks a task failed when its fulfillment mapper %ss",
    async (mode) => {
      const lifecycle = registerTask();
      const onSnapshot = vi.fn();
      lifecycle.bindPromise("task", Promise.resolve("result"), {
        onFulfilled: () => {
          const error = new Error("fulfillment mapping failed");
          if (mode === "throw") throw error;
          return Promise.reject(error);
        },
        onSnapshot,
      });

      await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
      expect(lifecycle.get("task")).toMatchObject({
        status: "failed",
        error: "fulfillment mapping failed",
      });
      expect(lifecycle.drainNotifications().map(({ kind }) => kind)).toEqual([
        "started", "failed",
      ]);
    },
  );

  it.each(["throw", "reject"] as const)(
    "marks a task failed when its rejection mapper %ss",
    async (mode) => {
      const lifecycle = registerTask();
      const onSnapshot = vi.fn();
      lifecycle.bindPromise("task", Promise.reject(new Error("backing failure")), {
        onRejected: () => {
          const error = new Error("rejection mapping failed");
          if (mode === "throw") throw error;
          return Promise.reject(error);
        },
        onSnapshot,
      });

      await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
      expect(lifecycle.get("task")).toMatchObject({
        status: "failed",
        error: "rejection mapping failed",
      });
    },
  );

  it("awaits rejection mapping before publishing its output and metadata", async () => {
    const lifecycle = registerTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onSnapshot = vi.fn();
    const onRejected = vi.fn(async () => {
      await gate;
      return { error: "mapped failure", output: "partial output", metadata: { attempt: 2 } };
    });
    lifecycle.bindPromise("task", Promise.reject("backing failure"), {
      onRejected,
      onSnapshot,
    });

    try {
      await vi.waitFor(() => expect(onRejected).toHaveBeenCalledOnce());
      expect(lifecycle.get("task")?.status).toBe("running");
      expect(onSnapshot).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    expect(lifecycle.get("task")).toMatchObject({
      status: "failed", error: "mapped failure", metadata: { attempt: 2 },
    });
    expect(lifecycle.readOutput("task")).toBe("partial output");
  });

  it.each(["fulfill", "reject"] as const)(
    "ignores late %s settlement after eviction without an unhandled rejection",
    async (mode) => {
      const lifecycle = registerTask();
      let settle!: () => void;
      const promise = new Promise<void>((resolve, reject) => {
        settle = mode === "fulfill" ? resolve : () => reject(new Error("late"));
      });
      const onSnapshot = vi.fn();
      lifecycle.bindPromise("task", promise, { onSnapshot });
      lifecycle.complete("task");
      lifecycle.drainNotifications();
      expect(lifecycle.evictNotifiedTerminalTasks()).toEqual(["task"]);

      settle();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(lifecycle.get("task")).toBeUndefined();
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Error("transition failed"),
    new BackgroundTaskError("unexpected missing record", "not_found"),
  ])("reports an unexpected transition error: $message", async (error) => {
    const lifecycle = registerTask();
    vi.spyOn(lifecycle, "complete").mockImplementation(() => { throw error; });
    lifecycle.bindPromise("task", Promise.resolve());

    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(error));
  });

  it("reports binding a task that was never registered", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.bindPromise("missing", Promise.resolve());

    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "not_found" }),
    ));
  });

  it.each(["task", "alias"])(
    "does not let an evicted promise bound through %s finish a replacement task",
    async (binding) => {
      const lifecycle = new BackgroundTaskLifecycle();
      lifecycle.register({ id: "task", aliases: ["alias"], type: "generic", description: "old" });
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => { resolve = settle; });
      const onSnapshot = vi.fn();
      lifecycle.bindPromise(binding, promise, { onSnapshot });
      lifecycle.complete("task");
      lifecycle.drainNotifications();
      lifecycle.evictNotifiedTerminalTasks();
      lifecycle.register({ id: "task", aliases: ["alias"], type: "generic", description: "new" });

      resolve();
      await new Promise<void>((settle) => setImmediate(settle));
      expect(lifecycle.get("task")).toMatchObject({ status: "running", description: "new" });
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
    },
  );

  it("reports a snapshot callback rejection after terminal publication", async () => {
    const lifecycle = registerTask();
    const error = new BackgroundTaskError("callback failed", "not_found");
    lifecycle.bindPromise("task", Promise.resolve(), {
      onSnapshot: async () => { throw error; },
    });

    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(error));
    expect(lifecycle.get("task")?.status).toBe("completed");
  });

  it("treats a mapper's not_found error as a task failure", async () => {
    const lifecycle = registerTask();
    lifecycle.bindPromise("task", Promise.resolve(), {
      onFulfilled: () => { throw new BackgroundTaskError("mapper input missing", "not_found"); },
    });

    await vi.waitFor(() => expect(lifecycle.get("task")).toMatchObject({
      status: "failed", error: "mapper input missing",
    }));
  });

  it.each([
    new Error("mapper: " + "x".repeat(100_000)),
    { toString() { throw new Error("cannot stringify"); } },
  ])("bounds mapper error text and tolerates unprintable failures", async (error) => {
    const lifecycle = registerTask();
    lifecycle.bindPromise("task", Promise.resolve(), {
      onFulfilled: () => { throw error; },
    });

    await vi.waitFor(() => expect(lifecycle.get("task")?.status).toBe("failed"));
    const message = lifecycle.get("task")?.error;
    expect(message).toBeTruthy();
    expect(message!.length).toBeLessThanOrEqual(8192);
  });
});
