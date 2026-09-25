import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isProcessTreeAlive,
  signalProcessTree,
  terminateProcessTreeAndReport,
} from "../../src/utils/supervisedProcess.js";
import {
  processIsRunning,
  spawnShellBackedPty,
  type ShellBackedPty,
} from "../helpers/shell-backed-pty.js";

// Once a leader has been reaped (Node set exitCode or signalCode), the
// kernel may hand its pid to an unrelated process. A handle that still
// carries the old pid then reached that process: the process-table walk
// adopted it as the tree root and killed its children, and -pid reached its
// whole process group. Here the "unrelated process" is a detached shell
// group the test owns, so a wrong signal only reaches the test's own
// processes.

const posixOnly = process.platform === "win32" ? it.skip : it;
const trees: ShellBackedPty[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) tree.cleanup();
});

/** A handle whose leader was reaped and whose pid another group now holds. */
async function reusedPidHandle() {
  const other = spawnShellBackedPty();
  trees.push(other);
  const otherChild = await other.descendantPid;
  const handle = {
    pid: other.shellPid,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(() => true),
  };
  return { other, otherChild, handle };
}

async function stillRunningAfter(ms: number, ...pids: number[]): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return pids.every(processIsRunning);
}

describe("a handle whose pid was reused after its leader was reaped", () => {
  posixOnly("signalProcessTree reaches neither the pid's new owner nor its group", async () => {
    const { other, otherChild, handle } = await reusedPidHandle();

    signalProcessTree(handle, "SIGKILL");

    expect(await stillRunningAfter(300, other.shellPid, otherChild)).toBe(true);
    expect(handle.kill).not.toHaveBeenCalled();
  });

  posixOnly("the new owner's group does not count as the tree being alive", async () => {
    const { handle } = await reusedPidHandle();

    expect(isProcessTreeAlive(handle)).toBe(false);
  });

  posixOnly("termination reports the tree gone and signals nothing", async () => {
    const { other, otherChild, handle } = await reusedPidHandle();

    const outcome = await terminateProcessTreeAndReport(handle, {
      terminateGraceMs: 100,
      killGraceMs: 100,
      label: "reused pid",
    });

    expect(outcome.residualProcessesTerminated).toBe(false);
    expect(await stillRunningAfter(300, other.shellPid, otherChild)).toBe(true);
    expect(handle.kill).not.toHaveBeenCalled();
  });
});
