import { afterEach, describe, expect, it } from "vitest";

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { formatSessionEndNotice } from "../../src/tools/system/exec-result-format.js";

// A background session that ends while nothing is showing it is reported to
// its owner once: exit code, signal, and an out-of-memory kill when the
// cgroup says so. Terminal-Bench (AgenC 0.19.19) runs polled dead sessions
// for minutes because nothing said they had ended.

const managers: UnifiedExecProcessManager[] = [];
function manager(): UnifiedExecProcessManager {
  const instance = new UnifiedExecProcessManager();
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.closeAll("test_cleanup")));
});

async function backgroundSession(
  processes: UnifiedExecProcessManager,
  cmd: string,
  ownerId: string,
): Promise<number> {
  const started = await processes.execCommand({ cmd, yield_time_ms: 250, ownerId });
  expect(started.session_id).toEqual(expect.any(Number));
  return started.session_id!;
}

async function waitForExit(processes: UnifiedExecProcessManager, ownerId: string, sessionId: number) {
  await expect.poll(
    () => processes.listOwnedProcesses({ ownerId }).find((view) => view.sessionId === sessionId)?.status,
    { timeout: 10_000 },
  ).not.toBe("running");
}

describe("session end notices", () => {
  it("reports a background session that ended on its own once, to its owner only", async () => {
    const processes = manager();
    const sessionId = await backgroundSession(processes, "sleep 0.6; exit 3", "owner-a");
    await waitForExit(processes, "owner-a", sessionId);

    expect(processes.takeSessionEndNotices({ ownerId: "owner-b" })).toEqual([]);
    const [notice, ...rest] = processes.takeSessionEndNotices({ ownerId: "owner-a" });
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ sessionId, exitCode: 3, command: "sleep 0.6; exit 3" });
    expect(notice!.signal).toBeUndefined();
    expect(notice!.outOfMemory).toBeUndefined();
    expect(notice!.durationMs).toBeGreaterThanOrEqual(500);
    expect(formatSessionEndNotice(notice!)).toMatch(
      new RegExp(`^\\[session ${sessionId} ended after \\d+s: exit 3 \\(\`sleep 0.6; exit 3\`\\)\\. write_stdin session_id=${sessionId} returns its remaining output\\.\\]$`),
    );
    expect(processes.takeSessionEndNotices({ ownerId: "owner-a" })).toEqual([]);
  });

  it("gives no notice when a poll showed the exit or the session was stopped", async () => {
    const processes = manager();
    const polled = await backgroundSession(processes, "sleep 0.5; echo done", "owner-c");
    const stopped = await backgroundSession(processes, "sleep 30", "owner-c");
    const result = await processes.writeStdin({
      session_id: polled, chars: "", yield_time_ms: 5_000, ownerId: "owner-c",
    });
    expect(result.exit_code).toBe(0);
    expect(processes.terminateProcess({ processId: stopped, ownerId: "owner-c" })).toEqual({ terminated: true });
    await waitForExit(processes, "owner-c", stopped);
    expect(processes.takeSessionEndNotices({ ownerId: "owner-c" })).toEqual([]);
  });
});
