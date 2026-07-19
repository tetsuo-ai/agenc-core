import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_LIFECYCLE_SHUTDOWN_BUDGET_MS,
  shutdownSessionLifecycle,
} from "./lifecycle.js";

function stubSession() {
  return {
    abortController: { signal: { aborted: false }, abort: vi.fn() },
    eventLog: {
      emit: (e: unknown) => e,
    },
    nextInternalSubId: () => "sub-1",
    abortAllTasks: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof shutdownSessionLifecycle>[0]["session"];
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shutdownSessionLifecycle", () => {
  it("aborts the session controller first (I-7 quiesce)", async () => {
    const session = stubSession();
    await shutdownSessionLifecycle({ session });
    expect(session.abortController.abort).toHaveBeenCalledWith("session_shutdown");
  });

  it("cascades agentControl.shutdownAll before inner shutdown (I-33 ordering)", async () => {
    const order: string[] = [];
    const session = stubSession();
    (session.shutdown as any) = vi
      .fn()
      .mockImplementation(async () => order.push("session"));
    const agentControl = {
      shutdownAll: vi.fn().mockImplementation(async () => order.push("agents")),
    };
    await shutdownSessionLifecycle({
      session,
      agentControl: agentControl as any,
    });
    expect(order).toEqual(["agents", "session"]);
  });

  it("drains the active task before Session runs its close-boundary finalizer", async () => {
    const order: string[] = [];
    let releaseAbort!: () => void;
    const session = stubSession();
    (session.abortAllTasks as any) = vi.fn(async () => {
      order.push("abort_started");
      await new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      order.push("abort_drained");
    });
    (session.shutdown as any) = vi.fn(async () => {
      order.push("terminal_finalizer");
    });

    const shutdown = shutdownSessionLifecycle({ session });
    await vi.waitFor(() => expect(order).toEqual(["abort_started"]));
    releaseAbort();
    await shutdown;

    expect(order).toEqual([
      "abort_started",
      "abort_drained",
      "terminal_finalizer",
    ]);
  });

  it("stops MCP manager last (I-6 fail-soft)", async () => {
    const order: string[] = [];
    const session = stubSession();
    (session.shutdown as any) = vi
      .fn()
      .mockImplementation(async () => order.push("session"));
    const mcp = {
      stop: vi.fn().mockImplementation(async () => order.push("mcp")),
    };
    await shutdownSessionLifecycle({
      session,
      mcpManager: mcp as any,
    });
    expect(order).toEqual(["session", "mcp"]);
  });

  it("I-87: outer budget caps the full lifecycle", async () => {
    const session = stubSession();
    // Never-resolving inner shutdown.
    (session.shutdown as any) = vi
      .fn()
      .mockImplementation(() => new Promise<never>(() => {}));
    const started = performance.now();
    await shutdownSessionLifecycle({
      session,
      shutdownBudgetMs: 50,
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(500);
  });

  it("I-82: later shutdown steps use monotonic remaining budget after a wall-clock jump", async () => {
    vi.useFakeTimers();
    let wallClockMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => wallClockMs);

    const session = stubSession();
    (session.shutdown as any) = vi
      .fn()
      .mockImplementation(() => new Promise<never>(() => {}));

    const agentControl = {
      shutdownAll: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              wallClockMs -= 5_000;
              resolve();
            }, 30);
          }),
      ),
    };

    let settled = false;
    const shutdown = shutdownSessionLifecycle({
      session,
      agentControl: agentControl as any,
      shutdownBudgetMs: 50,
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(25);
    await shutdown;

    expect(settled).toBe(true);
  });

  it("MCP stop failure does not propagate", async () => {
    const session = stubSession();
    const mcp = {
      stop: vi.fn().mockRejectedValue(new Error("mcp stop failed")),
    };
    await expect(
      shutdownSessionLifecycle({ session, mcpManager: mcp as any }),
    ).resolves.toBeUndefined();
  });

  it("default budget is 5000ms", () => {
    expect(SESSION_LIFECYCLE_SHUTDOWN_BUDGET_MS).toBe(5000);
  });
});
