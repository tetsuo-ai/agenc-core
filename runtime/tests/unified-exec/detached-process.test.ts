import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")(
  "UnifiedExecProcessManager.startDetachedProcess",
  () => {
    const pids: number[] = [];
    let sessionTempRoot = "";

    beforeEach(async () => {
      sessionTempRoot = await mkdtemp(join(tmpdir(), "agenc-detached-"));
    });

    afterEach(async () => {
      for (const pid of pids.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(sessionTempRoot, { recursive: true, force: true });
    });

    function manager(): UnifiedExecProcessManager {
      return new UnifiedExecProcessManager({
        cwd: process.cwd(),
        sessionTempRoot,
        shellPath: "/bin/sh",
      });
    }

    test("a detached service survives the command returning and closeAll", async () => {
      const exec = manager();
      const result = await exec.startDetachedProcess({
        cmd: "echo booting; sleep 30",
        yield_time_ms: 400,
      });

      expect(result.detached).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.pid).toBeTypeOf("number");
      pids.push(result.pid!);
      expect(result.stdout).toContain("booting");
      expect(result.log_path).toContain(join(sessionTempRoot, "detached"));
      // Not tracked: no session_id, nothing for kill_process or closeAll.
      expect(result.process_id).toBeUndefined();
      expect(exec.listBackgroundProcesses()).toEqual([]);

      await exec.closeAll("session_shutdown");

      expect(processIsRunning(result.pid!)).toBe(true);
    });

    test("a detached command that exits inside the window reports its exit code and both streams", async () => {
      const result = await manager().startDetachedProcess({
        cmd: "echo hello; echo oops >&2; exit 3",
        yield_time_ms: 2_000,
      });

      expect(result.detached).toBe(true);
      expect(result.exitCode).toBe(3);
      expect(result.pid).toBeUndefined();
      expect(result.stdout).toContain("hello");
      expect(result.stdout).toContain("oops");
    });

    test("the service keeps writing to its log after the tool returned", async () => {
      // A pipe the manager stopped reading would end the service with
      // SIGPIPE on its next write; the log file must not.
      const result = await manager().startDetachedProcess({
        cmd: "sleep 0.7; echo later; sleep 30",
        yield_time_ms: 300,
      });
      pids.push(result.pid!);

      await delay(1_400);

      expect(processIsRunning(result.pid!)).toBe(true);
      expect(await readFile(result.log_path!, "utf8")).toContain("later");
    });

    test("an empty command is refused before anything spawns", async () => {
      await expect(
        manager().startDetachedProcess({ cmd: "   " }),
      ).rejects.toMatchObject({ code: "missing_command" });
    });
  },
);

describe.skipIf(process.platform !== "linux")("residual process reporting", () => {
  test("a command that leaves a background job behind is told so", async () => {
    const sessionTempRoot = await mkdtemp(join(tmpdir(), "agenc-residue-"));
    const exec = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      sessionTempRoot,
      shellPath: "/bin/sh",
    });
    try {
      const result = await exec.execCommand({
        cmd: "sleep 30 & echo started",
        yield_time_ms: 10_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("started");
      expect(result.residual_processes_terminated).toBe(true);

      const clean = await exec.execCommand({ cmd: "echo alone", yield_time_ms: 10_000 });
      expect(clean.residual_processes_terminated).toBeUndefined();
    } finally {
      await exec.closeAll("test_cleanup");
      await rm(sessionTempRoot, { recursive: true, force: true });
    }
  });
});
