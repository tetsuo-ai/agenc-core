import { afterEach, describe, expect, it } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

// A poll of a session that printed nothing for a while carries one line on
// what its processes are doing (state, CPU time, members that exited since
// the last check). Terminal-Bench (AgenC 0.19.19): a model polled
// `python3 analysis.py 2>&1 | tail -40` for 1240 s after the python parent
// had died. Real processes on Linux (/proc) and Darwin (ps).

describe("quiet polls", () => {
  const managers: UnifiedExecProcessManager[] = [];
  afterEach(async () => {
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

  it("leave a session that printed recently alone", async () => {
    const processes = new UnifiedExecProcessManager({ quietProcessStateAfterMs: 60_000 });
    managers.push(processes);
    const started = await processes.execCommand({ cmd: "echo hi; sleep 30", yield_time_ms: 300 });
    expect(started.output).toContain("hi");
    expect(started.process_state).toBeUndefined();
  });
});
