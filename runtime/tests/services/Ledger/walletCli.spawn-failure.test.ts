import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createFailedSpawnChild,
  createPidStandIn,
} from "../../helpers/failed-spawn-child.js";

// runWalletCliProcess used to call child.kill("SIGTERM") for a signal that
// was already aborted, before the error listener existed. When that spawn had
// failed (EACCES on a noexec home, EAGAIN, EMFILE), the kill reached pid 0 and
// SIGTERMed the daemon's whole process group. The failed children here are
// stand-ins: a real one must never be signalled inside the test runner.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { runWalletCliProcess } = await import(
  "../../../src/services/Ledger/walletCli.js"
);
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
});

describe("runWalletCliProcess with a failed spawn", () => {
  test("returns a cancelled result without starting anything when the signal is already aborted", async () => {
    const failed = createFailedSpawnChild({
      code: "EACCES",
      command: "/managed/wallet-cli",
    });
    spawnMock.mockImplementation(() => failed);
    const controller = new AbortController();
    controller.abort();

    const result = await runWalletCliProcess("/managed/wallet-cli", ["--version"], {
      cwd: tmpdir(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(failed.groupSignals).toEqual([]);
    expect(result).toEqual({
      stdout: "",
      stderr: "wallet-cli was cancelled before it started",
      code: null,
      timedOut: false,
    });
  });

  test("an abort in the same tick as a failed spawn never signals the pid-less child", async () => {
    const failed = createFailedSpawnChild({
      code: "EMFILE",
      command: "/managed/wallet-cli",
    });
    spawnMock.mockImplementation(() => failed);
    const controller = new AbortController();

    const running = runWalletCliProcess("/managed/wallet-cli", ["--version"], {
      cwd: tmpdir(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;
    await failed.reported;

    expect(failed.groupSignals).toEqual([]);
    expect(failed.uncaught).toEqual([]);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("EMFILE");
  });

  test("a spawn failure is reported as a result, not an uncaught error", async () => {
    const failed = createFailedSpawnChild({
      code: "ENOENT",
      command: "/managed/wallet-cli",
    });
    spawnMock.mockImplementation(() => failed);

    const result = await runWalletCliProcess("/managed/wallet-cli", ["--version"], {
      cwd: tmpdir(),
    });
    await failed.reported;

    expect(failed.uncaught).toEqual([]);
    expect(result).toMatchObject({ code: -1, timedOut: false });
    expect(result.stderr).toContain("ENOENT");
  });
});

describe("runWalletCliProcess with a handle reporting an unsafe pid", () => {
  // Only a pid above 1 is signalled: 0 is this process's group, -1 every
  // process of the user, 1 init.
  test.each([0, -1, 1])("an abort never signals a child whose pid is %s", async (pid) => {
    const child = createPidStandIn(pid);
    spawnMock.mockImplementation(() => child as never);
    const controller = new AbortController();

    const running = runWalletCliProcess("/managed/wallet-cli", ["--version"], {
      cwd: tmpdir(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    child.emit("close", 0);
    await running;

    expect(child.signals).toEqual([]);
  });
});
