import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

/** How long the next process sample takes; on macOS it runs `ps`, which is asynchronous. */
const sampling = vi.hoisted(() => ({ delayMs: 0 }));
vi.mock("../../src/unified-exec/process-state.js", async (original) => {
  const actual = await original<typeof import("../../src/unified-exec/process-state.js")>();
  return {
    ...actual,
    checkSessionProcesses: vi.fn(async (...args: Parameters<typeof actual.checkSessionProcesses>) => {
      if (sampling.delayMs > 0) await delay(sampling.delayMs);
      return actual.checkSessionProcesses(...args);
    }),
  };
});

const { UnifiedExecProcessManager } = await import("../../src/unified-exec/process-manager.js");

// A poll of a session that printed nothing for a while carries one line on
// what its processes are doing (state, CPU time, members that exited since
// the last check). Terminal-Bench (AgenC 0.19.19): a model polled
// `python3 analysis.py 2>&1 | tail -40` for 1240 s after the python parent
// had died. Real processes on Linux (/proc) and Darwin (ps).

describe("quiet polls", () => {
  const managers: InstanceType<typeof UnifiedExecProcessManager>[] = [];
  afterEach(async () => {
    sampling.delayMs = 0;
    await Promise.all(managers.splice(0).map((instance) => instance.closeAll("test_cleanup")));
  });

  it("carry the state of a quiet session's processes and the members that exited", async () => {
    const processes = new UnifiedExecProcessManager({ quietProcessStateAfterMs: 200 });
    managers.push(processes);
    const started = await processes.execCommand({
      cmd: "sleep 0.8 & sleep 30; wait",
      yield_time_ms: 400,
    });
    expect(started.session_id).toEqual(expect.any(Number));
    // The yield itself was quiet long enough: the first report has no delta yet.
    expect(started.process_state).toMatch(/^\[no output for \ds; \d processes: .*sleep x2 sleeping/u);

    const later = await processes.writeStdin({
      session_id: started.session_id!, chars: "", yield_time_ms: 5_000,
    });
    expect(later.session_id).toBe(started.session_id);
    expect(later.process_state).toContain("CPU since the last check:");
    expect(later.process_state).toContain("Exited since then: sleep 0.8 (pid ");
  }, 20_000);

  it("keep the output and the exit that arrive while the processes are sampled", async () => {
    const processes = new UnifiedExecProcessManager({ quietProcessStateAfterMs: 0 });
    managers.push(processes);
    // The command prints its last line and exits during the sample.
    sampling.delayMs = 1_500;
    const result = await processes.execCommand({ cmd: "sleep 0.5; echo final-line", yield_time_ms: 200 });
    expect(result.output).toContain("final-line");
    expect(result.exit_code).toBe(0);
    // The wait ended with the exit, not at the yield: no timed_out on a clean exit.
    expect(result.timedOut).toBe(false);
    expect(result.session_id).toBeUndefined();
    expect(result.process_state).toBeUndefined();
  }, 20_000);

  it("leave a session that printed recently alone", async () => {
    const processes = new UnifiedExecProcessManager({ quietProcessStateAfterMs: 60_000 });
    managers.push(processes);
    const started = await processes.execCommand({ cmd: "echo hi; sleep 30", yield_time_ms: 300 });
    expect(started.output).toContain("hi");
    expect(started.process_state).toBeUndefined();
  });
});
