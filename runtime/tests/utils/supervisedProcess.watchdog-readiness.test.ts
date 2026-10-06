import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// A contained command waits at its gate until the owner watchdog reports
// ready. The deadline for that report was a plain 2 s timer, and two things
// beat it on a loaded Mac: a watchdog (a fresh Node process that snapshots
// the process table) that took longer than 2 s, and this event loop blocked
// past the deadline, after which libuv ran the expired timer before it read
// the reply that had arrived meanwhile. Either way the gate was killed before
// the command ran, and the result looked like a command killed with no
// output: a Goal's worktree step then said its base commit did not resolve.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { runSupervisedProcess, setContainedWatchdogReadyTimeoutForTesting, spawnContainedProcess } =
  await import("../../src/utils/supervisedProcess.js");
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

let restoreDeadline: (() => void) | undefined;
let scratch: string | undefined;

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
  restoreDeadline?.();
  restoreDeadline = undefined;
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function scratchDir(): string {
  scratch = mkdtempSync(join(tmpdir(), "agenc-watchdog-ready-"));
  return scratch;
}

/** Block this event loop the way a busy daemon does: synchronously, no I/O. */
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A child stand-in whose spawn succeeded; kill() is a spy that signals nothing. */
function startedChild() {
  const stdio = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  return Object.assign(new EventEmitter(), {
    pid: 424_242,
    exitCode: null,
    signalCode: null,
    stdio,
    stdin: stdio[0],
    stdout: stdio[1],
    stderr: stdio[2],
    kill: vi.fn(() => true),
    ref() {},
    unref() {},
  });
}

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("contained process watchdog readiness", () => {
  it("runs the command when this event loop was blocked past the readiness deadline", async () => {
    restoreDeadline = setContainedWatchdogReadyTimeoutForTesting(200);
    const pending = runSupervisedProcess(
      { program: process.execPath, args: ["-e", "process.stdout.write('ran')"], cwd: scratchDir(), env },
      { timeoutMs: 30_000, maxOutputBytes: 1024 },
    );
    // The gate and the watchdog are already spawned and the deadline is
    // armed. The watchdog answers during this block, and the deadline
    // expires during it too: the expired timer runs before the reply is read.
    blockEventLoop(2_500);
    const result = await pending;

    expect(result.error?.message).toBeUndefined();
    expect(result.stopReason).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("ran");
  });

  it.runIf(process.platform === "darwin")(
    "reports a launch abandoned before its watchdog was ready as a command that did not start",
    async () => {
      // Keep the watchdog silent so readiness cannot race the deadline.
      const watchdog = startedChild();
      spawnMock
        .mockImplementationOnce(actualSpawn)
        .mockImplementationOnce(() => watchdog as never);
      restoreDeadline = setContainedWatchdogReadyTimeoutForTesting(1);
      const marker = join(scratchDir(), "ran");
      const result = await runSupervisedProcess(
        {
          program: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
          cwd: scratch!,
          env,
        },
        { timeoutMs: 30_000, maxOutputBytes: 1024 },
      );

      expect(result.stopReason).toBe("spawn_error");
      expect(result.error?.message).toMatch(
        /^the command did not start: its process watchdog was not ready within 1 ms$/,
      );
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin")(
    "starts the command for a watchdog that answers after the old 2 s deadline",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"] });
      const gate = startedChild();
      const watchdog = startedChild();
      spawnMock
        .mockImplementationOnce(() => gate as never)
        .mockImplementationOnce(() => watchdog as never);
      spawnContainedProcess(process.execPath, ["-e", "0"], { cwd: tmpdir(), env: {} });

      vi.advanceTimersByTime(2_500);
      const handoff = new Promise<void>((resolve) => {
        gate.stdio[3]!.on("finish", () => resolve());
      });
      watchdog.stdio[3]!.write("ready\n");
      await handoff;
      vi.runOnlyPendingTimers();

      expect(gate.kill).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "darwin")(
    "lets a reply that arrives in the same turn as an expired deadline start the command",
    async () => {
      // The ordering a blocked loop produces, forced: the deadline callback
      // runs first, the reply is read after it, before the next check phase.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"] });
      restoreDeadline = setContainedWatchdogReadyTimeoutForTesting(200);
      const gate = startedChild();
      const watchdog = startedChild();
      spawnMock
        .mockImplementationOnce(() => gate as never)
        .mockImplementationOnce(() => watchdog as never);
      spawnContainedProcess(process.execPath, ["-e", "0"], { cwd: tmpdir(), env: {} });

      // Fire only the deadline itself; anything it schedules waits for the next turn.
      vi.advanceTimersToNextTimer();
      const handoff = new Promise<void>((resolve) => {
        gate.stdio[3]!.on("finish", () => resolve());
      });
      watchdog.stdio[3]!.write("ready\n");
      await handoff;
      vi.runOnlyPendingTimers();

      expect(gate.kill).not.toHaveBeenCalled();
    },
  );
});
