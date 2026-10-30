import { afterEach, describe, expect, it } from "vitest";

import { managerPool, startBackgroundSession, waitForSessionExit } from "./helpers/background-sessions.js";
import { formatSessionEndNotice } from "../../src/tools/system/exec-result-format.js";

// A background session that ends while nothing is showing it is reported to
// its owner once: exit code, signal, and an out-of-memory kill when the
// cgroup says so. Terminal-Bench (AgenC 0.19.19) runs polled dead sessions
// for minutes because nothing said they had ended.

const pool = managerPool();
const manager = pool.create;

afterEach(async () => {
  await pool.closeAll();
});

describe("session end notices", () => {
  it("reports a background session that ended on its own once, to its owner only", async () => {
    const processes = manager();
    const sessionId = await startBackgroundSession(processes, "sleep 0.6; exit 3", "owner-a");
    await waitForSessionExit(processes, "owner-a", sessionId);

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
    const polled = await startBackgroundSession(processes, "sleep 0.5; echo done", "owner-c");
    const stopped = await startBackgroundSession(processes, "sleep 30", "owner-c");
    const result = await processes.writeStdin({
      session_id: polled, chars: "", yield_time_ms: 5_000, ownerId: "owner-c",
    });
    expect(result.exit_code).toBe(0);
    expect(processes.terminateProcess({ processId: stopped, ownerId: "owner-c" })).toEqual({ terminated: true });
    await waitForSessionExit(processes, "owner-c", stopped);
    expect(processes.takeSessionEndNotices({ ownerId: "owner-c" })).toEqual([]);
  });
});
