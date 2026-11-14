import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Lets a test replace the next process checks; otherwise the real sampler runs. */
const sampling = vi.hoisted(() => ({ missingChecks: 0, emptyChecks: 0, startupCpuSeconds: 0 }));
vi.mock("../../src/unified-exec/process-state.js", async (original) => {
  const actual = await original<typeof import("../../src/unified-exec/process-state.js")>();
  return {
    ...actual,
    checkSessionProcesses: vi.fn(async (...args: Parameters<typeof actual.checkSessionProcesses>) => {
      if (sampling.missingChecks > 0) {
        sampling.missingChecks -= 1;
        return undefined;
      }
      if (sampling.emptyChecks > 0) {
        // As in the persistent sandbox or the reusable command server after
        // the command exited: the root (the executor) is listed, no process
        // of the command is.
        sampling.emptyChecks -= 1;
        return { groups: [], memberCount: 0, cpuSeconds: 0, cpuDeltaSeconds: 0, exited: [],
          check: { cpuSeconds: 0, members: new Map() } };
      }
      const report = await actual.checkSessionProcesses(...args);
      // Reproduce Darwin's startup charge without relying on machine speed.
      return report !== undefined && args[1]?.members.size === 0 && sampling.startupCpuSeconds > 0
        ? { ...report, cpuDeltaSeconds: (report.cpuDeltaSeconds ?? 0) + sampling.startupCpuSeconds }
        : report;
    }),
  };
});

const { UnifiedExecProcessManager } = await import("../../src/unified-exec/process-manager.js");

// wait33 review rv1: what a busy wait does when a check finds the session's
// root gone, which clock bounds it, and the diagnostics line each busy wait
// writes for the A/B (AGENC_DIAGNOSTICS_FILE only).

function busyFor(seconds: number): string {
  const script = `const end = Date.now() + ${seconds * 1000}; let x = 0; while (Date.now() < end) x++; console.log("done");`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

if (process.platform === "linux" || process.platform === "darwin") {

describe("busy waits", () => {
  const managers: InstanceType<typeof UnifiedExecProcessManager>[] = [];
  const restoreDiagnostics = process.env.AGENC_DIAGNOSTICS_FILE;
  afterEach(async () => {
    sampling.missingChecks = 0;
    sampling.emptyChecks = 0;
    sampling.startupCpuSeconds = 0;
    vi.restoreAllMocks();
    if (restoreDiagnostics === undefined) delete process.env.AGENC_DIAGNOSTICS_FILE;
    else process.env.AGENC_DIAGNOSTICS_FILE = restoreDiagnostics;
    await Promise.all(managers.splice(0).map((instance) => instance.closeAll("test_cleanup")));
  });
  const manager = (options: ConstructorParameters<typeof UnifiedExecProcessManager>[0] = {}) => {
    const created = new UnifiedExecProcessManager({ busyWaitCheckMs: 250, ...options });
    managers.push(created);
    return created;
  };

  it("wait briefly for the exit when a check finds the root gone", async () => {
    const processes = manager();
    // The first check at the yield finds no root, as right after an exit.
    sampling.missingChecks = 1;
    const result = await processes.execCommand({ cmd: "sleep 1; echo finished", yield_time_ms: 300, waitWhileBusy: true });
    expect(result.session_id).toBeUndefined();
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("finished");
  }, 20_000);

  it("wait briefly for the exit when a check finds no process of the command left under a live root", async () => {
    const processes = manager();
    sampling.emptyChecks = 1;
    const result = await processes.execCommand({ cmd: "sleep 1; echo finished", yield_time_ms: 300, waitWhileBusy: true });
    expect(result.session_id).toBeUndefined();
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("finished");
  }, 20_000);

  it("are bounded by a monotonic clock: a wall-clock jump does not end one", async () => {
    const processes = manager({ busyWaitMaxMs: 60_000 });
    const realNow = Date.now.bind(Date);
    setTimeout(() => vi.spyOn(Date, "now").mockImplementation(() => realNow() + 3_600_000), 1_000);
    const result = await processes.execCommand({ cmd: busyFor(3), yield_time_ms: 300, waitWhileBusy: true });
    expect(result.session_id).toBeUndefined();
    expect(result.output).toContain("done");
  }, 20_000);

  it("each write one diagnostics line with how they ended and the CPU they measured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wait33-diag-"));
    try {
      const file = join(dir, "diagnostics.jsonl");
      process.env.AGENC_DIAGNOSTICS_FILE = file;
      const processes = manager();
      sampling.startupCpuSeconds = 1;
      await processes.execCommand({ cmd: busyFor(2), yield_time_ms: 300, waitWhileBusy: true });
      // Poll an already-started sleeper. Its baseline includes startup CPU,
      // so the idle interval measures only the sleep on both Darwin and Linux.
      const sleeper = await processes.execCommand({ cmd: "sleep 10", yield_time_ms: 300 });
      await processes.writeStdin({ session_id: sleeper.session_id!, chars: "", yield_time_ms: 300, waitWhileBusy: true });
      await processes.execCommand({ cmd: busyFor(1), yield_time_ms: 300 });
      const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
        event: string; data: { kind: string; end: string; busy_ms: number; wait_ms: number; checks: number; cpu_shares: number[] };
      }).filter((line) => line.event === "exec_busy_wait");
      expect(lines.map((line) => [line.data.kind, line.data.end])).toEqual([["exec", "exit"], ["poll", "idle"]]);
      const [busy, idle] = lines.map((line) => line.data);
      expect(busy!.checks).toBeGreaterThanOrEqual(1);
      expect(Math.min(...busy!.cpu_shares)).toBeGreaterThanOrEqual(0.25);
      expect(busy!.wait_ms).toBeGreaterThanOrEqual(1_500);
      expect(idle!.checks).toBe(1);
      expect(idle!.cpu_shares[0]).toBeLessThan(0.25);
      expect(idle!.busy_ms).toBeLessThan(2_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
}
