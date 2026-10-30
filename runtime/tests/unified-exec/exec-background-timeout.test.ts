import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { UnifiedExecError } from "../../src/unified-exec/types.js";

// A command that reaches exec_command's timeoutMs keeps running as a tracked
// session instead of being killed (Terminal-Bench, AgenC 0.19.19: 9 hard
// timeout kills in 6 trials threw away 1710 s of work). Only the owner's
// background-session limit turns the time limit back into a kill.

const managers: UnifiedExecProcessManager[] = [];
const dirs: string[] = [];
function manager(options: ConstructorParameters<typeof UnifiedExecProcessManager>[0] = {}) {
  const instance = new UnifiedExecProcessManager(options);
  managers.push(instance);
  return instance;
}
function workdir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "exec-bg-timeout-")));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.closeAll("test_cleanup")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("onTimeout: background", () => {
  it("returns the command as a live session at its time limit and lets it finish", async () => {
    const processes = manager();
    const startedAt = Date.now();
    const result = await processes.execCommand({
      cmd: "sleep 1; echo finished-after-limit",
      timeoutMs: 300,
      onTimeout: "background",
      yield_time_ms: 10_000,
      ownerId: "owner-a",
    });
    // The wait ended at the limit, not at the 10 s yield, and nothing was killed.
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(result.exit_code).toBeNull();
    expect(result.session_id).toEqual(expect.any(Number));
    expect(result.timeout_backgrounded_ms).toBe(300);
    expect(processes.listOwnedProcesses({ ownerId: "owner-a" })).toMatchObject([{ status: "running" }]);

    const polled = await processes.writeStdin({
      session_id: result.session_id!, chars: "", yield_time_ms: 5_000, ownerId: "owner-a",
    });
    expect(polled.output).toContain("finished-after-limit");
    expect(polled.exit_code).toBe(0);
    // The time limit is reported once; the poll that shows the exit does not repeat it.
    expect(polled.timeout_backgrounded_ms).toBeUndefined();
  });

  it("ends a poll in progress at the time limit and keeps the command running", async () => {
    const processes = manager();
    const started = await processes.execCommand({
      cmd: "sleep 2; echo still-alive",
      timeoutMs: 1_000,
      onTimeout: "background",
      yield_time_ms: 250,
    });
    expect(started.session_id).toEqual(expect.any(Number));
    expect(started.timeout_backgrounded_ms).toBeUndefined();

    const pollStarted = Date.now();
    const atLimit = await processes.writeStdin({
      session_id: started.session_id!, chars: "", yield_time_ms: 30_000,
    });
    expect(Date.now() - pollStarted).toBeLessThan(5_000);
    expect(atLimit.exit_code).toBeNull();
    expect(atLimit.session_id).toBe(started.session_id);
    expect(atLimit.timedOut).toBe(true);
    expect(atLimit.timeout_backgrounded_ms).toBe(1_000);

    const finished = await processes.writeStdin({
      session_id: started.session_id!, chars: "", yield_time_ms: 10_000,
    });
    expect(finished.output).toContain("still-alive");
    expect(finished.exit_code).toBe(0);
  });

  it("stops the command at its time limit when the owner holds the background-session limit", async () => {
    const processes = manager({ maxBackgroundSessions: 1 });
    const job = await processes.execCommand({
      cmd: "sleep 30", startInBackground: true, yield_time_ms: 250, ownerId: "owner-b",
    });
    expect(job.session_id).toEqual(expect.any(Number));

    const limited = await processes.execCommand({
      cmd: "sleep 30",
      timeoutMs: 300,
      onTimeout: "background",
      yield_time_ms: 10_000,
      ownerId: "owner-b",
    });
    expect(limited.session_id).toBeUndefined();
    expect(limited.timedOut).toBe(true);
    expect(limited.timeout_stopped_at_session_limit).toBe(1);
    // Another owner's sessions do not count against this one.
    const other = await processes.execCommand({
      cmd: "sleep 30", timeoutMs: 300, onTimeout: "background", yield_time_ms: 10_000, ownerId: "owner-c",
    });
    expect(other.session_id).toEqual(expect.any(Number));
    expect(other.timeout_backgrounded_ms).toBe(300);
  });

  it("refuses a background start at the limit before anything runs", async () => {
    const cwd = workdir();
    const processes = manager({ cwd, maxBackgroundSessions: 1 });
    await processes.execCommand({
      cmd: "sleep 30", startInBackground: true, yield_time_ms: 250, ownerId: "owner-d",
    });
    const refused = processes.execCommand({
      cmd: "touch started-anyway; sleep 30", startInBackground: true, yield_time_ms: 250, ownerId: "owner-d",
    });
    await expect(refused).rejects.toBeInstanceOf(UnifiedExecError);
    await expect(refused).rejects.toMatchObject({
      code: "process_limit",
      message: expect.stringContaining("has not started"),
    });
    await delay(300);
    expect(existsSync(join(cwd, "started-anyway"))).toBe(false);
  });

  it("keeps the default: without onTimeout the time limit still stops the command", async () => {
    const processes = manager();
    const result = await processes.execCommand({
      cmd: "sleep 30", timeoutMs: 300, yield_time_ms: 10_000,
    });
    expect(result.session_id).toBeUndefined();
    expect(result.timedOut).toBe(true);
    expect(result.timeout_backgrounded_ms).toBeUndefined();
  });
});
