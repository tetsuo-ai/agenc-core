import { describe, expect, it, vi } from "vitest";
import { selfTerminationRisk, type SelfTerminationProbe } from "../../src/permissions/self-termination.js";

function probe(matches: number[]): SelfTerminationProbe {
  return { pid: 30, processes: () => [
    { pid: 20, ppid: 1, name: "node" }, { pid: 30, ppid: 20, name: "agenc" },
    { pid: 40, ppid: 1, name: "agenc-launcher" }, { pid: 50, ppid: 30, name: "python" },
  ], matchingPids: vi.fn(() => matches) };
}

describe("shell self-termination prevention", () => {
  it.each(["pkill -f worker.py", "pkill -9 -f 'worker[.]py'", "sh -c 'pkill -f worker.py'",
    "true; /usr/bin/pkill -f worker.py", "env LANG=C pkill -f worker.py"])("refuses a self-matching %s without running it", command => {
    const fixture = probe([20, 40, 50]);
    expect(selfTerminationRisk(command, fixture)).toContain("Refused a kill command");
    expect(fixture.matchingPids).toHaveBeenCalledOnce();
  });
  it("allows a pattern matching only an owned worker", () => {
    expect(selfTerminationRisk("pkill -f worker.py", probe([50]))).toBeNull();
  });
  it("protects runtime siblings and explicit ancestor PIDs", () => {
    expect(selfTerminationRisk("pkill -f agenc", probe([40]))).toContain("pid 40");
    expect(selfTerminationRisk("kill -TERM 20", probe([]))).toContain("pid 20");
    expect(selfTerminationRisk("kill 50", probe([]))).toBeNull();
    expect(selfTerminationRisk("killall agenc", probe([30]))).toContain("pid 30");
    expect(selfTerminationRisk("kill -0 30", probe([]))).toBeNull();
    expect(selfTerminationRisk("pkill --signal 0 -f agenc", probe([30]))).toBeNull();
    expect(selfTerminationRisk("kill 1", { ...probe([]), pid: 1 })).toContain("pid 1");
  });
  it("does not interpret quoted prose as a kill command", () => {
    const fixture = probe([30]);
    expect(selfTerminationRisk("printf '%s' 'pkill -f agenc'", fixture)).toBeNull();
    expect(fixture.matchingPids).not.toHaveBeenCalled();
  });
  it("does not invent a denial if the process inventory is unavailable", () => {
    expect(selfTerminationRisk("pkill -f worker.py", { ...probe([]), processes: () => { throw new Error("unavailable"); } })).toBeNull();
  });
  it("does not interpret substitutions, unknown flags, or extra operands as a target", () => {
    const fixture = probe([30]);
    expect(selfTerminationRisk("kill $PPID", fixture)).toBeNull();
    expect(selfTerminationRisk("kill `pgrep agenc`", fixture)).toBeNull();
    expect(selfTerminationRisk("pkill -u root -f agenc", fixture)).toBeNull();
    expect(selfTerminationRisk("killall agenc extra", fixture)).toBeNull();
    expect(fixture.matchingPids).not.toHaveBeenCalled();
  });
});
