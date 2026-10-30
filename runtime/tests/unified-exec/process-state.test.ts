import { describe, expect, it } from "vitest";
import {
  checkSessionProcesses,
  formatSessionProcessReport,
  parsePsCpuTime,
  parsePsProcessTable,
  processLabel,
  sessionMembers,
  type ProcessSample,
} from "../../src/unified-exec/process-state.js";

// A poll of a session that printed nothing for a while carries one line on
// what its processes are doing. Terminal-Bench (AgenC 0.19.19): a model
// polled `python3 analysis.py 2>&1 | tail -40` for 1240 s after the python
// parent had died, and another read `wall_time=521s` as "finished" while its
// training ran starved on one CPU.

function sample(pid: number, ppid: number, pgid: number, label: string, state: ProcessSample["state"] = "sleeping", cpuSeconds = 0): ProcessSample {
  return { pid, ppid, pgid, label, state, cpuSeconds, startToken: `t${pid}` };
}

describe("process table parsing", () => {
  it("reads ps cputime in its Darwin and Linux forms", () => {
    expect(parsePsCpuTime("0:00.03")).toBeCloseTo(0.03);
    expect(parsePsCpuTime("15:15.93")).toBeCloseTo(915.93);
    expect(parsePsCpuTime("01:02:03")).toBe(3723);
    expect(parsePsCpuTime("2-01:00:00")).toBe(176_400);
    expect(parsePsCpuTime("n/a")).toBeUndefined();
  });

  it("parses ps rows with a five-word start time and arguments with spaces", () => {
    const table = parsePsProcessTable([
      "  700     1   700 Ss     0:00.02 Fri Oct 30 00:33:17 2026     /bin/bash -c python3 train.py --epochs 3",
      "  701   700   700 R+    12:00.50 Fri Oct 30 00:33:18 2026     /usr/bin/python3 train.py --epochs 3",
      "  702   701   700 Z      0:00.00 Fri Oct 30 00:33:19 2026     (python3)",
      "garbage line",
    ].join("\n"));
    expect([...table.keys()]).toEqual([700, 701, 702]);
    expect(table.get(701)).toMatchObject({ ppid: 700, pgid: 700, state: "running", label: "python3 train.py --epochs 3" });
    expect(table.get(701)!.cpuSeconds).toBeCloseTo(720.5);
    expect(table.get(702)!.state).toBe("zombie");
    expect(table.get(700)!.startToken).toBe("ps:Fri Oct 30 00:33:17 2026");
  });

  it("labels a process by program basename and arguments, bounded", () => {
    expect(processLabel(["/usr/bin/python3", "/tmp/exp.py", "A"])).toBe("python3 /tmp/exp.py A");
    expect(processLabel(["sleep", "", "5"])).toBe("sleep 5");
    expect(processLabel(["node", "x".repeat(80)])).toHaveLength(48);
  });
});

describe("session membership", () => {
  it("covers the root, its process group and their descendants, including reparented orphans", () => {
    const table = new Map<number, ProcessSample>([
      [1, sample(1, 0, 1, "init")],
      [700, sample(700, 1, 700, "bash")],
      [701, sample(701, 700, 700, "tail -40")],
      // The python parent died; its sampler chains were reparented to init but kept the group.
      [710, sample(710, 1, 700, "python3 chain", "running", 300)],
      [711, sample(711, 710, 711, "helper")], // own group, child of a member
      [800, sample(800, 1, 800, "unrelated")],
    ]);
    expect(sessionMembers(table, 700).map((member) => member.pid).sort()).toEqual([700, 701, 710, 711]);
    expect(sessionMembers(table, 1)).toEqual([]);
    expect(sessionMembers(table, 0)).toEqual([]);
  });

  it("reports state groups, CPU since the last check and members that exited", async () => {
    const first = new Map<number, ProcessSample>([
      [700, sample(700, 1, 700, "bash")],
      [701, sample(701, 700, 700, "tail -40")],
      [705, sample(705, 700, 700, "python3 pystan_analysis.py", "sleeping", 50)],
      [710, sample(710, 705, 700, "python3 chain", "running", 100)],
      [711, sample(711, 705, 700, "python3 chain", "running", 100)],
    ]);
    const before = await checkSessionProcesses(700, undefined, { platform: "linux", table: first });
    expect(before!.cpuDeltaSeconds).toBeUndefined();
    expect(before!.exited).toEqual([]);
    const second = new Map(first);
    second.delete(705);
    second.set(710, sample(710, 1, 700, "python3 chain", "running", 400));
    second.set(711, sample(711, 1, 700, "python3 chain", "running", 400));
    const after = await checkSessionProcesses(700, before!.check, { platform: "linux", table: second });
    // The chains' own 600 s, not the sum's 550: the exited parent took its 50 s along.
    expect(after!.cpuDeltaSeconds).toBeCloseTo(600);
    expect(after!.exited).toEqual(["python3 pystan_analysis.py (pid 705)"]);
    expect(formatSessionProcessReport(after!, 312_000)).toBe(
      "[no output for 5m12s; 4 processes: python3 x2 running (800s cpu), bash sleeping, tail sleeping." +
        " CPU since the last check: 600s. Exited since then: python3 pystan_analysis.py (pid 705).]",
    );
  });

  it("says nothing when the root is gone or the platform has no reader", async () => {
    const table = new Map([[800, sample(800, 1, 800, "other")]]);
    expect(await checkSessionProcesses(700, undefined, { platform: "linux", table })).toBeUndefined();
    expect(await checkSessionProcesses(700, undefined, { platform: "win32" })).toBeUndefined();
    expect(await checkSessionProcesses(undefined, undefined)).toBeUndefined();
  });
});
