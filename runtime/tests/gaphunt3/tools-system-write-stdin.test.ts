import { describe, expect, test, vi } from "vitest";

import { createWriteStdinTool } from "src/tools/system/write-stdin";
import type {
  ExecCommandToolOutput,
  UnifiedExecProcessManagerLike,
} from "src/unified-exec/types";
import { bindExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";

// gaphunt3 #4: write_stdin must report an error when the underlying PTY
// process was killed by a signal (exitCode === null, no process_id) instead
// of silently reporting success. Mirrors the exec-command discriminator
// (process_id !== undefined => still-alive yielded process; otherwise the
// null exitCode means the process terminated and the call is an error).

function baseOutput(
  overrides: Partial<ExecCommandToolOutput>,
): ExecCommandToolOutput {
  return {
    output: "",
    stdout: "",
    stderr: "",
    exitCode: null,
    exit_code: null,
    durationMs: 1,
    wall_time_seconds: 0.001,
    timedOut: false,
    truncated: false,
    original_token_count: 0,
    ...overrides,
  };
}

function makeManager(
  output: ExecCommandToolOutput,
): UnifiedExecProcessManagerLike {
  return {
    maxTimeoutMs: 30_000,
    execCommand: vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
      async () => output,
    ),
    writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
      async () => output,
    ),
    closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
  };
}

describe("write_stdin isError on signal kill (gaphunt3 #4)", () => {
  test("flags a signal-killed process (exitCode null, no process_id) as isError", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({
          exitCode: null,
          exit_code: null,
          // No process_id => process is gone, not yielded.
          process_id: undefined,
          timedOut: false,
        }),
      ),
    }));

    const result = await tool.execute({ session_id: 1, chars: "" });

    // Before the fix this was `undefined` (silent success); after, true.
    expect(result.isError).toBe(true);
  });

  test("flags a timed-out kill (exitCode null, no process_id, timedOut) as isError", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({
          exitCode: null,
          exit_code: null,
          process_id: undefined,
          timedOut: true,
        }),
      ),
    }));

    const result = await tool.execute({ session_id: 1, chars: "" });

    expect(result.isError).toBe(true);
  });

  test("does NOT flag a still-alive yielded process (exitCode null, process_id set)", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({
          exitCode: null,
          exit_code: null,
          // process_id present => still alive, can resume via write_stdin.
          process_id: 7,
          timedOut: false,
        }),
      ),
    }));

    const result = await tool.execute({ session_id: 7, chars: "" });

    expect(result.isError).toBeUndefined();
  });

  test("does NOT flag a clean completion (exitCode 0)", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({ exitCode: 0, exit_code: 0 }),
      ),
    }));

    const result = await tool.execute({ session_id: 1, chars: "" });

    expect(result.isError).toBeUndefined();
  });

  test("flags a non-zero exit code as isError", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({ exitCode: 1, exit_code: 1 }),
      ),
    }));

    const result = await tool.execute({ session_id: 1, chars: "" });

    expect(result.isError).toBe(true);
  });
});
