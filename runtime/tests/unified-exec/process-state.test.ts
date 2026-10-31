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

  it("counts the members it does not name", async () => {
    const table = new Map<number, ProcessSample>([
      [700, sample(700, 1, 700, "bash")],
      [701, sample(701, 700, 700, "make -j1", "sleeping", 2)],
      [702, sample(702, 701, 700, "cc1 a.c", "running", 9)],
      [703, sample(703, 701, 700, "as a.s")],
      [704, sample(704, 700, 700, "tee build.log")],
    ]);
    const report = await checkSessionProcesses(700, undefined, { platform: "linux", table });
    expect(formatSessionProcessReport(report!, 61_000)).toBe(
      "[no output for 1m01s; 5 processes: cc1 running (9s cpu), make sleeping (2s cpu), bash sleeping, 2 more.]",
    );
  });

  it("says nothing when the root is gone or the platform has no reader", async () => {
    const table = new Map([[800, sample(800, 1, 800, "other")]]);
    expect(await checkSessionProcesses(700, undefined, { platform: "linux", table })).toBeUndefined();
    expect(await checkSessionProcesses(700, undefined, { platform: "win32" })).toBeUndefined();
    expect(await checkSessionProcesses(undefined, undefined)).toBeUndefined();
  });
});

describe("AgenC's own containment processes", () => {
  // Linux E2E on the PC (sandboxed agenc -p in a one-CPU container): the
  // session root is the process broker, then bubblewrap and the session
  // sandbox executor, then the command's shell. A quiet poll of
  // `sleep 70 & sleep 301; wait` read "5 processes: agenc-process-broker
  // sleeping, bwrap sleeping, agenc-session-sandbox sleeping, ...." and never
  // named the sleep 301 that was still running.
  function sandboxedTree(withSleep70: boolean): Map<number, ProcessSample> {
    const rows: ProcessSample[] = [
      sample(92, 40, 92, "agenc-process-broker --bootstrap-v2"),
      sample(93, 92, 93, "bwrap --new-session --die-with-parent --ro-bi..."),
      sample(94, 93, 94, "agenc-session-sandbox --session-executor-v1"),
      sample(95, 94, 95, "bash -c sleep 70 & sleep 301; wait"),
      ...(withSleep70 ? [sample(96, 95, 95, "sleep 70")] : []),
      sample(97, 95, 95, "sleep 301"),
    ];
    return new Map(rows.map((row) => [row.pid, row]));
  }

  it("leaves the broker, bubblewrap and the session sandbox out of a quiet poll's line", async () => {
    const first = await checkSessionProcesses(92, undefined, { platform: "linux", table: sandboxedTree(true) });
    expect(formatSessionProcessReport(first!, 66_000)).toBe(
      "[no output for 1m06s; 3 processes: sleep x2 sleeping, bash sleeping.]",
    );
    const second = await checkSessionProcesses(92, first!.check, { platform: "linux", table: sandboxedTree(false) });
    expect(formatSessionProcessReport(second!, 75_000)).toBe(
      "[no output for 1m15s; 2 processes: bash sleeping, sleep sleeping." +
        " CPU since the last check: 0s. Exited since then: sleep 70 (pid 96).]",
    );
  });

  it("keeps a bwrap that the command started itself", async () => {
    const table = new Map<number, ProcessSample>([
      [92, sample(92, 40, 92, "agenc-process-broker --bootstrap-v2")],
      [95, sample(95, 92, 95, "bash -c bwrap --ro-bind / / sleep 30; true")],
      [96, sample(96, 95, 95, "bwrap --ro-bind / / sleep 30")],
    ]);
    const report = await checkSessionProcesses(92, undefined, { platform: "linux", table });
    expect(formatSessionProcessReport(report!, 61_000)).toBe(
      "[no output for 1m01s; 2 processes: bash sleeping, bwrap sleeping.]",
    );
  });

  it("says so when only containment processes are left", async () => {
    const table = new Map<number, ProcessSample>([
      [92, sample(92, 40, 92, "agenc-process-broker --bootstrap-v2")],
      [93, sample(93, 92, 93, "bwrap --new-session")],
    ]);
    const report = await checkSessionProcesses(92, undefined, { platform: "linux", table });
    expect(formatSessionProcessReport(report!, 61_000)).toBe(
      "[no output for 1m01s; no process of the command is running.]",
    );
  });
});
