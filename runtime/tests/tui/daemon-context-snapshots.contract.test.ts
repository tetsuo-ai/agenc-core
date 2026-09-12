import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionSnapshotResult } from "../../src/app-server/protocol/index.js";
import { projectResidentContextUsage } from "../../src/session/resident-context-usage.js";
import { startDaemonWorkerTaskPolling } from "../../src/tui/state/daemonWorkerTasks.js";
import { getDefaultAppState } from "../../src/tui/state/AppStateStore.js";
import { drainMicrotasks } from "../helpers/controlled-async.js";

function snapshot(messageTokens = 50_000, effectiveWindowTokens = 500_000) {
  return {
    sessionId: "session-alias", turnCount: 5,
    tokenUsage: { inputTokens: 900_000, outputTokens: 1_000, totalTokens: 901_000, costUsd: 1 },
    cacheStats: { requestCount: 10, cacheReadInputTokens: 8_000, cacheCreationInputTokens: 0, cacheTotalInputTokens: 10_000, hitRate: 0.8 },
    contextBreakdown: {
      windowTokens: 2_000_000, effectiveWindowTokens, messageTokens, systemPromptTokens: 3_000,
      systemToolTokens: 1_000, systemToolCount: 1, mcpToolTokens: 300, mcpToolCount: 1,
      memoryFileTokens: 24, memoryFileCount: 1, deferredToolTokens: 500_000, deferredToolCount: 10,
    },
  } satisfies SessionSnapshotResult;
}

function fixture() {
  vi.useFakeTimers();
  let state = getDefaultAppState();
  const listeners = new Set<(event: unknown) => void>();
  const read = vi.fn(async () => snapshot());
  const session = {
    conversationId: "conversation", getDaemonSessionSnapshot: read,
    subscribeToEvents: (cb: (event: unknown) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  const observed = vi.fn();
  const error = vi.fn();
  const close = startDaemonWorkerTaskPolling(session, update => { state = update(state); }, error, observed);
  return { session, read, observed, error, close, emit: (type: string) => { for (const cb of listeners) cb({ type, payload: {} }); } };
}
afterEach(() => vi.useRealTimers());

describe("resident context on the existing daemon snapshot stream", () => {
  test("publishes without native worker support and refreshes after clear and model reconfiguration", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      expect(f.read).toHaveBeenCalledTimes(1);
      expect(projectResidentContextUsage(f.observed.mock.calls.at(-1)![0].contextBreakdown, { providerEnvironment: {} })).toMatchObject({ totalUsed: 54_324, hardLimit: 500_000, usedPercentage: 11 });
      f.read.mockResolvedValue(snapshot(0));
      f.emit("history_replaced");
      await vi.advanceTimersByTimeAsync(250);
      expect(projectResidentContextUsage(f.observed.mock.calls.at(-1)![0].contextBreakdown, { providerEnvironment: {} })).toMatchObject({ totalUsed: 4_324, usedPercentage: 1 });
      f.read.mockResolvedValue(snapshot(10_000, 100_000));
      f.emit("session_configured");
      f.emit("token_count");
      await vi.advanceTimersByTimeAsync(250);
      expect(f.read).toHaveBeenCalledTimes(3);
      expect(projectResidentContextUsage(f.observed.mock.calls.at(-1)![0].contextBreakdown, { providerEnvironment: {} })).toMatchObject({ hardLimit: 100_000, usedPercentage: 14 });
    } finally { f.close(); }
  });

  test.each(["history_replaced", "history_cleared", "context_compacted", "session_configured"])("drops a pending stale context overtaken by %s", async eventType => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      const old = Promise.withResolvers<ReturnType<typeof snapshot>>();
      f.read.mockReturnValueOnce(old.promise);
      await vi.advanceTimersByTimeAsync(5_000);
      f.emit(eventType);
      old.resolve(snapshot(450_000));
      await drainMicrotasks(20);
      expect(f.observed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(f.observed).toHaveBeenCalledTimes(2);
      expect(f.observed.mock.calls.at(-1)![0].contextBreakdown.messageTokens).toBe(50_000);
    } finally { f.close(); }
  });

  test.each(["unmount", "replacement"])("does not publish a pending snapshot after %s", async mode => {
    const f = fixture();
    await drainMicrotasks(20);
    const old = Promise.withResolvers<ReturnType<typeof snapshot>>();
    f.read.mockReturnValueOnce(old.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    if (mode === "unmount") f.close(); else f.session.conversationId = "replacement";
    old.resolve(snapshot(450_000));
    await drainMicrotasks(20);
    expect(f.observed).toHaveBeenCalledTimes(1);
    f.close();
  });
});
