import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFailedSpawnChild } from "../helpers/failed-spawn-child.js";

// The POSIX owner watchdog read watchdog.stdio[3] before any error listener
// existed. EMFILE and ENFILE leave a failed child's stdio undefined, so that
// threw a TypeError and the spawn error Node reports on the next tick was an
// uncaught exception in the daemon. Every child here is a stand-in; nothing
// is ever signalled.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { spawnContainedProcess } = await import(
  "../../src/utils/supervisedProcess.js"
);
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
});

/** A gate child whose spawn succeeded; kill() is a spy that signals nothing. */
function startedGate() {
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

describe("contained process owner watchdog", () => {
  it.runIf(process.platform === "darwin")(
    "starts the watchdog in /, not in the command's working directory",
    async () => {
      // A command directory removed between the gate spawn and the watchdog
      // spawn failed the watchdog, and the command that never ran was then
      // reported as SIGKILLed. The watchdog only uses absolute paths.
      const gate = startedGate();
      const watchdog = startedGate();
      spawnMock
        .mockImplementationOnce(() => gate as never)
        .mockImplementationOnce(() => watchdog as never);
      const commandDirectory = tmpdir();

      spawnContainedProcess(process.execPath, ["-e", "0"], {
        cwd: commandDirectory,
        env: {},
      });

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock.mock.calls[0]![2]).toMatchObject({ cwd: commandDirectory });
      expect(spawnMock.mock.calls[1]![2]).toMatchObject({ cwd: "/" });
      // Let the launch finish: the watchdog reports ready, the gate gets its
      // payload. Nothing runs; both children are stand-ins.
      const gateHandoff = new Promise<void>((resolve) => {
        gate.stdio[3]!.on("finish", () => resolve());
      });
      watchdog.stdio[3]!.write("ready\n");
      await gateHandoff;
      expect(gate.kill).not.toHaveBeenCalled();
    },
  );


  it.runIf(process.platform === "darwin")(
    "a watchdog spawn that left no stdio fails the launch without an uncaught error",
    async () => {
      const gate = startedGate();
      const watchdog = createFailedSpawnChild({
        code: "EMFILE",
        command: process.execPath,
      });
      spawnMock
        .mockImplementationOnce(() => gate as never)
        .mockImplementationOnce(() => watchdog);

      expect(() =>
        spawnContainedProcess(process.execPath, ["-e", "0"], {
          cwd: tmpdir(),
          env: {},
        }),
      ).toThrow("contained process watchdog readiness FD is unavailable");
      await watchdog.reported;

      expect(watchdog.uncaught).toEqual([]);
      expect(watchdog.groupSignals).toEqual([]);
      // The gate never received its launch payload; it is stopped unrun.
      expect(gate.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );
});
