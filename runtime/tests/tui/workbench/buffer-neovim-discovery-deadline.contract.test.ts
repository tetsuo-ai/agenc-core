import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({
  spawnContainedProcess: vi.fn(),
  terminateProcessTreeAndWait: vi.fn(async () => {}),
}));

vi.mock("../../../src/utils/supervisedProcess.js", () => processMocks);

import { discoverNeovim } from "../../../src/tui/workbench/buffer/neovim/NeovimDiscovery.js";

describe("embedded Neovim discovery deadline", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("retains the deadline after leader exit when an inherited pipe never closes", async () => {
    const child = fakeContainedProcess();
    processMocks.spawnContainedProcess.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write("NVIM v0.12.1\n");
        setChildExitCode(child, 0);
        child.emit("exit", 0, null);
        // Deliberately do not end stdout/stderr or emit `close`: this models a
        // Darwin descendant which inherited the pipe and escaped the observed
        // PPID tree before the leader exited.
      });
      return child;
    });

    const discovery = discoverNeovim({
      executable: "/fake/nvim",
      timeoutMs: 20,
    });
    const result = await Promise.race([
      discovery,
      new Promise<"hung">((resolve) => {
        setTimeout(() => resolve("hung"), 250);
      }),
    ]);

    expect(result).not.toBe("hung");
    expect(result).toMatchObject({
      usable: false,
      reasonCode: "probe-timeout",
    });
    expect(processMocks.terminateProcessTreeAndWait).toHaveBeenCalledWith(
      child,
      {
        terminateGraceMs: 50,
        killGraceMs: 1_000,
        label: "Neovim version probe",
      },
    );
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});

function fakeContainedProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [],
    pid: 4242,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
  });
  return child;
}

function setChildExitCode(
  child: ChildProcessWithoutNullStreams,
  exitCode: number,
): void {
  Object.defineProperty(child, "exitCode", {
    configurable: true,
    value: exitCode,
  });
}
