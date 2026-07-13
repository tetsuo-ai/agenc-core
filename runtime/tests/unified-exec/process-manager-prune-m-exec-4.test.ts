import { afterEach, describe, expect, it } from "vitest";

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

// M-EXEC-4 (core-todo.md): execCommand called pruneExitedProcesses() at its start,
// which released ANY exited process. A background command that had exited but not yet
// been polled was therefore evicted the moment the model issued the next exec_command
// (the normal start -> do other work -> poll workflow), so the subsequent poll threw
// UnifiedExecError('unknown_process') and the final output + exit code were lost.

let manager: UnifiedExecProcessManager | undefined;

afterEach(async () => {
  await manager?.closeAll?.();
  manager = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("UnifiedExecProcessManager — M-EXEC-4 exited process survives a later exec", () => {
  it("still returns a background process's output after an intervening exec_command", async () => {
    manager = new UnifiedExecProcessManager({ cwd: process.cwd() });

    // Outlives the first yield (>= MIN_YIELD 250ms) -> returns a process_id while
    // still running.
    const started = await manager.execCommand({
      cmd: "node -e \"setTimeout(()=>console.log('BACKGROUND_OUT'), 500)\"",
      yield_time_ms: 250,
    });
    expect(started.process_id).toEqual(expect.any(Number));

    // Let it finish in the background (exitState is set by the child 'exit' event).
    await sleep(700);

    // The intervening exec_command triggers pruneExitedProcesses — which must NOT
    // evict the still-un-polled, exited background process.
    const other = await manager.execCommand({
      cmd: "node -e \"console.log('OTHER')\"",
      yield_time_ms: 2_000,
    });
    expect(other.stdout).toContain("OTHER");

    // Poll the original process — its buffered output + exit code must still be here.
    const polled = await manager.writeStdin({
      session_id: started.process_id!,
      chars: "",
      yield_time_ms: 2_000,
    });
    expect(polled.stdout).toContain("BACKGROUND_OUT");
    expect(polled.exitCode).toBe(0);
  }, 15_000);
});
