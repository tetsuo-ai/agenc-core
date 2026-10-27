import { spawn as realSpawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "node:child_process";
import {
  captureProcessTreeDescendants,
  isProcessTreeAlive,
  terminateProcessTreeAndReport,
} from "../../src/utils/supervisedProcess.js";

// On Darwin (and every POSIX host without a cgroup or subreaper boundary) a
// process-table snapshot is a synchronous `ps -axo` over every process, about
// 20 ms each. Exec settlement used to take two of them after each command had
// exited, then discard both: a reaped leader that was never observed has no
// identities a snapshot could extend. These tests pin that no snapshot is taken
// in that state, and that a live leader still gets one.

const posixOnly = process.platform === "win32" ? describe.skip : describe;
const originalPlatform = process.platform;

function psSnapshots(): number {
  return vi
    .mocked(spawnSync)
    .mock.calls.filter(([command]) => command === "/bin/ps").length;
}

/** A pid no process holds: an exited, reaped leader that was never observed. */
function reapedNeverObservedLeader() {
  return {
    pid: 2_147_483_646,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(() => true),
  };
}

posixOnly("process-table snapshots for exited commands", () => {
  beforeEach(() => {
    // Route snapshots through the Darwin `ps` reader on every POSIX host.
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.mocked(spawnSync).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("settles a reaped, never-observed leader without a ps snapshot", async () => {
    const handle = reapedNeverObservedLeader();

    const outcome = await terminateProcessTreeAndReport(handle, {
      terminateGraceMs: 50,
      killGraceMs: 50,
      label: "exited command",
    });

    expect(outcome.residualProcessesTerminated).toBe(false);
    expect(handle.kill).not.toHaveBeenCalled();
    expect(psSnapshots()).toBe(0);
  });

  it("answers liveness for a reaped, never-observed leader without a ps snapshot", () => {
    const handle = reapedNeverObservedLeader();

    captureProcessTreeDescendants(handle);
    expect(isProcessTreeAlive(handle)).toBe(false);
    expect(psSnapshots()).toBe(0);
  });

  it("still snapshots a live leader so its descendants are recorded", async () => {
    const child = realSpawn("/bin/sleep", ["5"], { detached: true, stdio: "ignore" });
    try {
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
      captureProcessTreeDescendants(child);
      expect(psSnapshots()).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
