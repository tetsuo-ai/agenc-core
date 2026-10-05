import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import {
  spawnContainedProcess,
  terminateProcessTreeAndReport,
  waitForContainedProcessSettlement,
} from "../../src/utils/supervisedProcess.js";

function fakeChild(): ChildProcessWithoutNullStreams {
  const stdio = Array.from({ length: 5 }, () => new PassThrough());
  return Object.assign(new EventEmitter(), {
    pid: 2_147_483_647,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(() => true),
    stdin: stdio[0],
    stdout: stdio[1],
    stderr: stdio[2],
    stdio,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function fakeBroker() {
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child);
  spawnContainedProcess(process.execPath, ["-e", "0"], {
    cwd: process.cwd(),
    env: process.env,
    linuxContainment: "subreaper",
  });
  const status = child.stdio[3] as PassThrough;
  return { child, status };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe.runIf(process.platform === "linux")("native settlement notification", () => {
  it.each([false, true])("waits for closed proof and preserves residue=%s", async (residual) => {
    const { child, status } = fakeBroker();
    vi.useFakeTimers();
    const settled = vi.fn();
    const waiting = waitForContainedProcessSettlement(child).then(settled);
    child.emit("exit", 0, null);
    status.emit("data", Buffer.from(residual ? "SRC" : "SC"));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    status.emit("end");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await waiting; // No clock advance: complete proof, not the fallback timer.
    expect(settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    await expect(terminateProcessTreeAndReport(child)).resolves.toEqual({
      residualProcessesTerminated: residual,
    });
    // A late subscriber must not miss the already consumed proof.
    await waitForContainedProcessSettlement(child);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["", "S", "C", "SCX", "SCC"])("keeps invalid proof %j fail-closed after fallback", async (proof) => {
    const { child, status } = fakeBroker();
    vi.useFakeTimers();
    const settled = vi.fn();
    const waiting = waitForContainedProcessSettlement(child).then(settled);
    status.emit("data", Buffer.from(proof));
    status.emit("end");
    child.emit("close", 0, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await waiting;
    expect(settled).toHaveBeenCalledTimes(1);
    await expect(terminateProcessTreeAndReport(child)).rejects.toThrow(/cleanup could not be verified/u);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("bounds absent proof and removes the listener before a late close", async () => {
    const { child, status } = fakeBroker();
    vi.useFakeTimers();
    const settled = vi.fn();
    const waiting = waitForContainedProcessSettlement(child).then(settled);
    await vi.advanceTimersByTimeAsync(20);
    await waiting;
    expect(child.listenerCount("close")).toBe(1); // Supervisor only.
    status.emit("data", Buffer.from("SC"));
    status.emit("end");
    child.emit("close", 0, null);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("retains the settlement window without a native boundary", async () => {
  const child = fakeChild();
  vi.useFakeTimers();
  const settled = vi.fn();
  const waiting = waitForContainedProcessSettlement(child).then(settled);
  child.emit("close", 0, null);
  await vi.advanceTimersByTimeAsync(19);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  expect(settled).toHaveBeenCalledTimes(1);
  expect(child.listenerCount("close")).toBe(0);
});
