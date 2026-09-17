import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { UnifiedExecProcessManager } from "./process-manager.js";
import { UnifiedExecError } from "./types.js";

/**
 * Recovery through owned process identity (#2477).
 *
 * The Terminal-Bench trial that motivated this: `kill_process(44)` returned
 * `terminated:true`, later calls for 62 and 67 returned `terminated:false`
 * (already exited), and sessions 83, 86 and 87 were still live when the
 * model decided to "clean up" by matching task filenames against
 * `/proc/*\/cmdline` and SIGKILLing the matches — which included the AgenC
 * CLI and its process brokers. These tests pin the managed alternative: the
 * owner enumerates and stops exactly its own live work by session id, a
 * stale id is harmless, another agent's session is refused, and nothing
 * here reads the process table.
 *
 * What this does NOT claim: in full-access mode a shell or Python process
 * the model runs can still signal any same-UID process. That is an OS
 * permission boundary the manager cannot enforce; see
 * docs/reference/tools-permissions-sandbox.md, "Recovering background work".
 */

const managers: UnifiedExecProcessManager[] = [];
function manager(): UnifiedExecProcessManager {
  const instance = new UnifiedExecProcessManager({ maxTimeoutMs: 60_000 });
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.closeAll()));
});

async function yielded(
  processes: UnifiedExecProcessManager,
  cmd: string,
  ownerId: string,
): Promise<number> {
  const result = await processes.execCommand({ cmd, yield_time_ms: 250, ownerId });
  const sessionId = result.session_id;
  if (sessionId === undefined) throw new Error(`command did not yield: ${cmd}`);
  return sessionId;
}

function statusOf(processes: UnifiedExecProcessManager, ownerId: string, sessionId: number) {
  return processes.listOwnedProcesses({ ownerId }).find((view) => view.sessionId === sessionId)?.status;
}

describe.skipIf(process.platform === "win32")("owned process recovery (#2477)", () => {
  it(
    "enumerates and stops only the owner's live work; stale ids are harmless and foreign sessions are refused",
    async () => {
      const processes = manager();
      const agent = "conv-agent";
      const other = "conv-other-agent";

      // 44 → true: an early managed cancellation that worked.
      const early = await yielded(processes, "sleep 30", agent);
      expect(processes.terminateProcess({ processId: early, ownerId: agent })).toEqual({
        terminated: true,
      });

      // 62 / 67 → false: sessions that yielded and then finished on their own.
      const finishedA = await yielded(processes, "sleep 0.4", agent);
      const finishedB = await yielded(processes, "sleep 0.4", agent);
      await expect.poll(() => statusOf(processes, agent, finishedA)).toBe("completed");
      await expect.poll(() => statusOf(processes, agent, finishedB)).toBe("completed");
      expect(processes.terminateProcess({ processId: finishedA, ownerId: agent })).toEqual({
        terminated: false,
      });
      expect(processes.terminateProcess({ processId: finishedB, ownerId: agent })).toEqual({
        terminated: false,
      });

      // 83 / 86 / 87: the live handles the model later had to recover, plus
      // another agent's session sharing the same manager.
      const live = [
        await yielded(processes, "sleep 30", agent),
        await yielded(processes, "sleep 30", agent),
        await yielded(processes, "sleep 30", agent),
      ];
      const foreign = await yielded(processes, "sleep 30", other);
      await expect.poll(() => statusOf(processes, agent, early)).toBe("killed");

      // The owner-scoped inventory answers "what of mine is still running?"
      // from manager identity. It carries the finished sessions with their
      // outcome (so terminated:false is explained), never the other agent's.
      const inventory = processes.listOwnedProcesses({ ownerId: agent });
      expect(inventory.map((view) => [view.sessionId, view.status])).toEqual([
        [early, "killed"],
        [finishedA, "completed"],
        [finishedB, "completed"],
        [live[0], "running"],
        [live[1], "running"],
        [live[2], "running"],
      ]);
      expect(inventory.find((view) => view.sessionId === finishedA)).toMatchObject({
        exitCode: 0,
        endedAt: expect.any(Number),
        command: "sleep 0.4",
      });
      expect(inventory.some((view) => view.sessionId === foreign)).toBe(false);
      expect(processes.listOwnedProcesses({ ownerId: other }).map((view) => view.sessionId)).toEqual([
        foreign,
      ]);
      // No owner context sees no owned work at all, rather than everyone's.
      expect(processes.listOwnedProcesses({})).toEqual([]);

      // A batch that names another agent's session is refused whole, before
      // any signal: the owner's own named session is still running.
      expect(() =>
        processes.terminateOwnedProcesses({ ownerId: agent, processIds: [live[0], foreign] }),
      ).toThrow(UnifiedExecError);
      expect(statusOf(processes, agent, live[0])).toBe("running");
      expect(statusOf(processes, other, foreign)).toBe("running");
      expect(() =>
        processes.terminateProcess({ processId: foreign, ownerId: agent }),
      ).toThrow(/owned by another/);

      // Stale, unknown and live ids in one batch: the stale ones are harmless.
      expect(
        processes.terminateOwnedProcesses({
          ownerId: agent,
          processIds: [finishedA, 9_999, live[1]],
        }),
      ).toEqual({
        results: [
          { sessionId: finishedA, terminated: false },
          { sessionId: 9_999, terminated: false },
          { sessionId: live[1], terminated: true },
        ],
      });
      await expect.poll(() => statusOf(processes, agent, live[1])).toBe("killed");

      // Bulk stop without ids reaches exactly the owner's remaining live work.
      expect(processes.terminateOwnedProcesses({ ownerId: agent })).toEqual({
        results: [
          { sessionId: live[0], terminated: true },
          { sessionId: live[2], terminated: true },
        ],
      });
      await expect.poll(() => statusOf(processes, agent, live[0])).toBe("killed");
      await expect.poll(() => statusOf(processes, agent, live[2])).toBe("killed");
      expect(processes.listOwnedProcesses({ ownerId: agent }).filter((view) => view.status === "running")).toEqual([]);
      expect(statusOf(processes, other, foreign)).toBe("running");
      expect(processes.terminateOwnedProcesses({ ownerId: agent })).toEqual({ results: [] });

      // The other agent's session is still reachable by its owner afterwards.
      expect(processes.terminateProcess({ processId: foreign, ownerId: other })).toEqual({
        terminated: true,
      });
    },
    30_000,
  );

  it("reports a signalled-but-not-yet-exited session as stopping, not as finished", async () => {
    const processes = manager();
    // A child that ignores SIGTERM keeps running until the manager's SIGKILL
    // escalation; in between, the inventory must not claim it is gone.
    const stubborn = await yielded(processes, "trap '' TERM; sleep 30", "conv-agent");
    expect(processes.terminateOwnedProcesses({ ownerId: "conv-agent" })).toEqual({
      results: [{ sessionId: stubborn, terminated: true }],
    });
    const immediate = statusOf(processes, "conv-agent", stubborn);
    expect(["stopping", "killed"]).toContain(immediate);
    await expect.poll(() => statusOf(processes, "conv-agent", stubborn), { timeout: 5_000 }).toBe("killed");
  }, 15_000);

  /**
   * The residual boundary, stated as a test so the docs cannot drift: the
   * ownership rules above govern the manager's API only. A command the
   * model runs without an OS sandbox is an ordinary same-UID process and can
   * signal anything the UID may signal — including, in a real session, the
   * AgenC CLI, the daemon, and the process brokers. The stand-in here is a
   * disposable `sleep` owned by this test; nothing else is signalled.
   */
  it("does not prevent a full-access command from signalling a same-UID process outside the manager", async () => {
    const processes = manager();
    const standIn = spawn("sleep", ["30"], { stdio: "ignore" });
    const standInExit = new Promise<string | null>((resolveExit) => {
      standIn.once("exit", (_code, signal) => resolveExit(signal));
    });
    try {
      const result = await processes.execCommand({
        cmd: `kill -TERM ${standIn.pid}`,
        yield_time_ms: 250,
        ownerId: "conv-agent",
      });
      expect(result.exitCode).toBe(0);
      expect(await standInExit).toBe("SIGTERM");
    } finally {
      if (standIn.exitCode === null && standIn.signalCode === null) standIn.kill("SIGKILL");
    }
  }, 15_000);

  it("keeps unowned legacy entries addressable by id but out of every owner's inventory", async () => {
    const processes = manager();
    const unowned = await processes.execCommand({ cmd: "sleep 30", yield_time_ms: 250 });
    const legacy = unowned.session_id!;
    expect(processes.listOwnedProcesses({ ownerId: "conv-agent" })).toEqual([]);
    expect(processes.listOwnedProcesses({}).map((view) => view.sessionId)).toEqual([legacy]);
    expect(processes.terminateOwnedProcesses({ ownerId: "conv-agent" })).toEqual({ results: [] });
    expect(processes.terminateProcess({ processId: legacy, ownerId: "conv-agent" })).toEqual({
      terminated: true,
    });
  }, 15_000);
});
