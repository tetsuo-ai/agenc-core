/**
 * Regression test (ihunt) for the Monitor background-process kill bug.
 *
 * Bug: Monitor passed a 30-minute hard timeout to unified exec. The
 * command yielded after the manager's ~30-second streaming window but
 * was then terminated in the background when that hidden deadline
 * elapsed.
 *
 * Fix: Monitor owns the short foreground yield but supplies no process
 * timeout. The process remains alive until it exits, is explicitly
 * stopped, the turn is cancelled, or the daemon shuts down.
 *
 * Each assertion below FAILS if the fix is reverted:
 *   1. `resolveTimeoutMs(tool, args)` must be `null` (the executor will
 *      arm NO timeout).
 *   2. `tool.timeoutBehavior === "tool"`.
 *   3. The unified-exec request contains no `timeoutMs`.
 */
import { describe, expect, test } from "vitest";

import { resolveTimeoutMs } from "../../../src/tools/execution.js";
import { createMonitorTool } from "../../../src/tools/system/monitor.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import type {
  ExecCommandRequest,
  UnifiedExecProcessManagerLike,
} from "../../../src/unified-exec/types.js";

function stubManager(
  requests: ExecCommandRequest[] = [],
): UnifiedExecProcessManagerLike {
  return {
    maxTimeoutMs: 1,
    execCommand: async (request) => {
      requests.push(request);
      return {
        output: "",
        stdout: "",
        stderr: "",
        exitCode: null,
        exit_code: null,
        process_id: 42,
        session_id: 42,
        durationMs: 30_000,
        wall_time_seconds: 30,
        timedOut: false,
        truncated: false,
        original_token_count: 0,
      };
    },
    writeStdin: async () => {
      throw new Error("not called in this test");
    },
    closeAll: async () => {},
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

    const resolved = resolveTimeoutMs(tool, {
      command: "npm run dev",
      description: "watch dev server",
    });

    expect(resolved).toBeNull();
  });

  test("starts the process with a bounded yield and no hard runtime deadline", async () => {
    const requests: ExecCommandRequest[] = [];
    const tool = bindExplicitDangerBoundary(
      createMonitorTool({
        cwd: process.cwd(),
        unifiedExecManager: stubManager(requests),
      }),
    );

    await tool.execute({
      command: "npm run dev",
      description: "watch dev server",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.yield_time_ms).toBe(30_000);
    expect(requests[0]).not.toHaveProperty("timeoutMs");
  });
});
