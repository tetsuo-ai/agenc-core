import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPidStandIn, failingSpawn } from "../helpers/failed-spawn-child.js";

// commandExec.start with an already-aborted signal terminates the session in
// the same tick as the spawn. When that spawn had failed, terminateSession
// fell back to child.kill("SIGTERM") on the pid-less child, whose open handle
// sends it to pid 0: the daemon's own process group. The children here are
// stand-ins that only record the signal.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { AgenCCommandExecService } = await import(
  "../../src/app-server/command-exec.js"
);
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
});

describe("commandExec with a failed spawn", () => {
  it("an already-aborted start never signals the pid-less child", async () => {
    const failures = failingSpawn({ code: "EAGAIN" });
    spawnMock.mockImplementation(failures.spawn as never);
    const controller = new AbortController();
    controller.abort();
    const service = new AgenCCommandExecService();

    await expect(
      service.start(
        {
          command: ["/usr/bin/true"],
          timeoutMs: 2_000,
          permissionProfile: ":danger-full-access",
        },
        { connectionId: "aborted-spawn", signal: controller.signal },
      ),
    ).rejects.toThrow(/failed to spawn command: .*EAGAIN/u);
    // Past the 500 ms SIGKILL escalation.
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.groupSignals).toEqual([]);
    expect(failures.children[0]!.uncaught).toEqual([]);
  });
});

describe("commandExec with a handle reporting an unsafe pid", () => {
  // A handle reporting 0 made terminateSession call process.kill(-0), this
  // process's own group, and -1 made it call process.kill(1), init. Real
  // children never report these; the check must not depend on that.
  it.each([0, -1])("terminate never signals a child whose pid is %s", async (pid) => {
    const child = createPidStandIn(pid);
    spawnMock.mockImplementation((() => child) as never);
    // Never calls through: a real kill with these pids is the hazard.
    const osKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = new AbortController();
    controller.abort();
    const service = new AgenCCommandExecService();
    try {
      const started = service.start(
        {
          command: ["/usr/bin/true"],
          timeoutMs: 2_000,
          permissionProfile: ":danger-full-access",
        },
        { connectionId: `unsafe-pid-${pid}`, signal: controller.signal },
      );
      // Past the 500 ms SIGKILL escalation, then let the stand-in exit.
      await new Promise((resolve) => setTimeout(resolve, 700));
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      await started.catch(() => undefined);

      expect(osKill).not.toHaveBeenCalled();
      expect(child.signals).toEqual([]);
    } finally {
      osKill.mockRestore();
    }
  }, 10_000);
});
