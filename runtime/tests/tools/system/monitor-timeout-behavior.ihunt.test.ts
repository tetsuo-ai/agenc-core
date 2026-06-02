/**
 * Regression test (ihunt) for the Monitor background-process kill bug.
 *
 * Bug: the Monitor tool drives `unifiedExecManager.execCommand` with
 * `yield_time_ms`/`timeoutMs = MONITOR_TIMEOUT_MS` (30 min) so the
 * monitored process stays alive in the background and yields a
 * `process_id`. The unified-exec yield window is clamped to
 * `MAX_YIELD_TIME_MS = 30_000`, so `execCommand` resolves at ~30s with
 * the process still running. But the Monitor Tool definition declared
 * neither `timeoutMs` nor `timeoutBehavior: "tool"`, so the generic
 * executor's `resolveTimeoutMs` returned `DEFAULT_TOOL_TIMEOUT_MS`
 * (30_000) and `withTimeoutAndAbort` armed a 30s timer that, on fire,
 * aborts the SAME AbortController forwarded into `execCommand` as
 * `__abortSignal`. The process manager terminates (SIGTERM/SIGKILL) the
 * monitored process on that abort and the tool returns a
 * `ToolTimeoutError` instead of the "Monitor task started" yield.
 *
 * Fix: the tool sets `timeoutBehavior: "tool"` (and an explicit
 * `timeoutMs`) so `resolveTimeoutMs` returns `null` and the executor no
 * longer imposes the 30s deadline on a tool that owns its own
 * yield/timeout semantics.
 *
 * Each assertion below FAILS if the fix is reverted:
 *   1. `resolveTimeoutMs(tool, args)` must be `null` (the executor will
 *      arm NO timeout). Reverting → returns DEFAULT_TOOL_TIMEOUT_MS.
 *   2. `tool.timeoutBehavior === "tool"`.
 */
import { describe, expect, test } from "vitest";

import {
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveTimeoutMs,
} from "../../../src/tools/execution.js";
import { createMonitorTool } from "../../../src/tools/system/monitor.js";
import type { UnifiedExecProcessManagerLike } from "../../../src/unified-exec/types.js";

// Minimal stub: the test only inspects the tool *definition* and the
// executor's timeout resolution, never actually executes a command.
function stubManager(): UnifiedExecProcessManagerLike {
  return {
    execCommand: async () => {
      throw new Error("not called in this test");
    },
  } as unknown as UnifiedExecProcessManagerLike;
}

describe("Monitor timeout ownership (ihunt regression)", () => {
  test("tool declares timeoutBehavior:\"tool\" so the executor owns no deadline", () => {
    const tool = createMonitorTool({
      cwd: process.cwd(),
      unifiedExecManager: stubManager(),
    });

    // Reverting the fix flips this back to "executor"/undefined.
    expect(tool.timeoutBehavior).toBe("tool");
  });

  test("resolveTimeoutMs returns null for Monitor (no 30s executor abort)", () => {
    const tool = createMonitorTool({
      cwd: process.cwd(),
      unifiedExecManager: stubManager(),
    });

    // The model only ever passes {command, description}; no per-call
    // timeoutMs is supplied, so the ONLY thing that prevents the
    // executor from arming a DEFAULT_TOOL_TIMEOUT_MS timer (which aborts
    // the shared controller forwarded into execCommand and kills the
    // backgrounded process) is timeoutBehavior:"tool".
    const resolved = resolveTimeoutMs(tool, {
      command: "npm run dev",
      description: "watch dev server",
    });

    // Revert-sensitive: without the fix resolveTimeoutMs returns
    // DEFAULT_TOOL_TIMEOUT_MS (30_000), so the executor would arm a 30s
    // timer that races/wins the clamped 30s yield and SIGTERMs the
    // monitored process.
    expect(resolved).toBeNull();
    expect(resolved).not.toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });
});
