import { describe, expect, it, vi } from "vitest";
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
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof shutdownSessionLifecycle>[0]["session"];
}

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
    const started = Date.now();
    await shutdownSessionLifecycle({
      session,
      shutdownBudgetMs: 50,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(500);
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
