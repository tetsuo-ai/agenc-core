import { afterEach, describe, expect, it } from "vitest";

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

// wait33: a model that gets a session_id back for a command that is still
// working almost always spends its next model call, with the whole
// conversation resent, polling it (the Superyat run on 0.19.32: 45 polls,
// 16.6M of 98.4M input tokens). With waitWhileBusy, a wait whose yield passes
// while the command's processes still use CPU continues until the command
// exits, stops using CPU, or the wait ceiling passes. Real processes on Linux
// (/proc) and Darwin (ps); other platforms have no process reader and keep
// the yield.

/** A command that keeps one core busy for `seconds`, then prints `done`. */
function busyFor(seconds: number): string {
  const script = `const end = Date.now() + ${seconds * 1000}; let x = 0; while (Date.now() < end) x++; console.log("done");`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

if (process.platform === "linux" || process.platform === "darwin") {

describe("waits that continue while the command is busy", () => {
  const managers: UnifiedExecProcessManager[] = [];
  const manager = (options: ConstructorParameters<typeof UnifiedExecProcessManager>[0] = {}) => {
    const created = new UnifiedExecProcessManager({ busyWaitCheckMs: 250, ...options });
    managers.push(created);
    return created;
  };
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((instance) => instance.closeAll("test_cleanup")));
  });

  it("returns a busy command's exit instead of a session_id", async () => {
    const processes = manager();
    const started = Date.now();
    const result = await processes.execCommand({ cmd: busyFor(2.5), yield_time_ms: 500, waitWhileBusy: true });
    expect(result.session_id).toBeUndefined();
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("done");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  }, 20_000);

  it("keeps the yield without waitWhileBusy", async () => {
    const processes = manager();
    const result = await processes.execCommand({ cmd: busyFor(5), yield_time_ms: 500 });
    expect(result.session_id).toEqual(expect.any(Number));
    expect(result.output).not.toContain("done");
  }, 20_000);

  it("returns at the yield when the command is not using CPU", async () => {
    const processes = manager();
    const started = Date.now();
    const result = await processes.execCommand({ cmd: "sleep 20", yield_time_ms: 500, waitWhileBusy: true });
    expect(result.session_id).toEqual(expect.any(Number));
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("ends at the wait ceiling and leaves the command running as a session", async () => {
    const processes = manager({ busyWaitMaxMs: 1_500 });
    const started = Date.now();
    const result = await processes.execCommand({ cmd: busyFor(20), yield_time_ms: 300, waitWhileBusy: true });
    const waited = Date.now() - started;
    expect(result.session_id).toEqual(expect.any(Number));
    expect(waited).toBeGreaterThanOrEqual(1_400);
    expect(waited).toBeLessThan(8_000);
  }, 30_000);

  it("ends at the command's time limit, which leaves it running", async () => {
    const processes = manager();
    const started = Date.now();
    const result = await processes.execCommand({
      cmd: busyFor(20), yield_time_ms: 300, timeoutMs: 1_500, onTimeout: "background", waitWhileBusy: true,
    });
    expect(result.session_id).toEqual(expect.any(Number));
    expect(result.timeout_backgrounded_ms).toBe(1_500);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 30_000);

  it("ends when the command stops using CPU", async () => {
    const processes = manager();
    const started = Date.now();
    // Busy for about two seconds, then idle while it still runs.
    const result = await processes.execCommand({
      cmd: `${busyFor(2)}; sleep 20`, yield_time_ms: 500, waitWhileBusy: true,
    });
    const waited = Date.now() - started;
    expect(result.session_id).toEqual(expect.any(Number));
    expect(result.output).toContain("done");
    expect(waited).toBeGreaterThanOrEqual(1_800);
    expect(waited).toBeLessThan(10_000);
  }, 30_000);

  it("is stopped by an interrupt like a yield, and the command with it", async () => {
    const processes = manager();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const started = Date.now();
    const result = await processes.execCommand({
      cmd: busyFor(20), yield_time_ms: 300, waitWhileBusy: true, __abortSignal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.session_id).toBeUndefined();
    expect(result.output).not.toContain("done");
    expect(processes.listOwnedProcesses().filter((view) => view.status === "running")).toEqual([]);
  }, 30_000);

  it("does not hold a background start", async () => {
    const processes = manager();
    const started = Date.now();
    const result = await processes.execCommand({
      cmd: busyFor(10), yield_time_ms: 300, startInBackground: true, waitWhileBusy: true,
    });
    expect(result.session_id).toEqual(expect.any(Number));
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it("lets an empty poll wait for a busy session's exit, and an idle session keeps the poll's yield", async () => {
    const processes = manager();
    const busy = await processes.execCommand({ cmd: busyFor(7), yield_time_ms: 300 });
    expect(busy.session_id).toEqual(expect.any(Number));
    // The shortest empty poll is 5 s; the command needs about 7 s.
    const finished = await processes.writeStdin({
      session_id: busy.session_id!, chars: "", yield_time_ms: 5_000, waitWhileBusy: true,
    });
    expect(finished.session_id).toBeUndefined();
    expect(finished.exit_code).toBe(0);
    expect(finished.output).toContain("done");

    const idle = await processes.execCommand({ cmd: "sleep 30", yield_time_ms: 300 });
    const started = Date.now();
    const polled = await processes.writeStdin({
      session_id: idle.session_id!, chars: "", yield_time_ms: 5_000, waitWhileBusy: true,
    });
    expect(polled.session_id).toBe(idle.session_id);
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 40_000);

  it("keeps an empty poll's yield without waitWhileBusy", async () => {
    const processes = manager();
    const busy = await processes.execCommand({ cmd: busyFor(12), yield_time_ms: 300 });
    const polled = await processes.writeStdin({ session_id: busy.session_id!, chars: "", yield_time_ms: 5_000 });
    expect(polled.session_id).toBe(busy.session_id);
    expect(polled.output).not.toContain("done");
  }, 40_000);
});
}
