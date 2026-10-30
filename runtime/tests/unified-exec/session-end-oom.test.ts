import { afterEach, describe, expect, it, vi } from "vitest";

// The cgroup OOM-kill counter (Linux only in production) is driven by the
// test, so the out-of-memory flag of a session end notice is checked on
// every platform with a real process that dies by SIGKILL.
const oomKills = vi.hoisted(() => ({ count: 0 as number | undefined }));
vi.mock("../../src/utils/resource-limits.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/resource-limits.js")>()),
  readOomKillCount: () => oomKills.count,
}));

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { formatSessionEndNotice } from "../../src/tools/system/exec-result-format.js";

const managers: UnifiedExecProcessManager[] = [];
function manager(): UnifiedExecProcessManager {
  const instance = new UnifiedExecProcessManager();
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  oomKills.count = 0;
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

describe("session end notices: out of memory", () => {
  it("names the signal and flags an out-of-memory kill the cgroup counted", async () => {
    const processes = manager();
    oomKills.count = 4;
    // The shell kills itself with SIGKILL, as the kernel OOM killer would.
    const sessionId = await backgroundSession(processes, "sleep 0.5; kill -9 $$", "owner-d");
    oomKills.count = 5;
    await waitForExit(processes, "owner-d", sessionId);
    const [notice] = processes.takeSessionEndNotices({ ownerId: "owner-d" });
    expect(notice).toMatchObject({ sessionId, signal: "SIGKILL", outOfMemory: true });
    // "killed by SIGKILL" where the shell died by the signal (Darwin gate, Linux
    // cgroup leaf); "exit 137 (SIGKILL)" where a broker reports the status.
    expect(formatSessionEndNotice(notice!)).toMatch(
      /: (?:killed by SIGKILL|exit 137 \(SIGKILL\)), likely out of memory \(the cgroup OOM killer fired while it ran\) /u,
    );
  });

  it("does not flag a SIGKILL as out of memory when the cgroup counted no OOM kill", async () => {
    const processes = manager();
    oomKills.count = 2;
    const sessionId = await backgroundSession(processes, "sleep 0.5; kill -9 $$", "owner-e");
    await waitForExit(processes, "owner-e", sessionId);
    const [notice] = processes.takeSessionEndNotices({ ownerId: "owner-e" });
    expect(notice).toMatchObject({ sessionId, signal: "SIGKILL" });
    expect(notice!.outOfMemory).toBeUndefined();
  });
});
