import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { selfTerminationRisk, type SelfTerminationProbe } from "../../src/permissions/self-termination.js";
import {
  cliBootstrapSource,
  launcherBootstrapSource,
  startIdleNodeChild,
  watchdogBootstrapSource,
  watchdogScript,
} from "../helpers/agenc-process-bootstrap.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { itWhen } from "../helpers/platform-registration.js";

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
  it("recognizes untitled macOS AgenC processes by their command line", () => {
    // macOS AgenC processes keep their real argv, so their name is the Node binary.
    const darwinProbe: SelfTerminationProbe = { pid: 30, matchingPids: vi.fn(() => []), processes: () => [
      { pid: 30, ppid: 1, name: "node", command: "/r/.agenc-node/bin/node /r/node_modules/@tetsuo-ai/runtime/bin/agenc daemon start --foreground" },
      { pid: 61, ppid: 1, name: "node", command: "/usr/local/bin/node /Users/Jo Doe/agenc-core/runtime/dist/bin/agenc.js --light" },
      { pid: 62, ppid: 1, name: "node", command: "node /usr/local/lib/node_modules/@tetsuo-ai/agenc/bin/agenc -p hi" },
      { pid: 63, ppid: 30, name: "node", command: "/r/.agenc-node/bin/node -e \\012'use strict';\\012// agenc-process-owner-watchdog" },
      { pid: 64, ppid: 1, name: "agenc-node", command: "/Users/jo/.agenc/bin/agenc-node /Users/jo/.agenc/runtime/1.0.0/t/bin/agenc --light" },
      { pid: 70, ppid: 30, name: "node", command: "node /work/bin/agency.js" },
      { pid: 71, ppid: 30, name: "node", command: "node /work/bin/agenc-tools.js serve" },
      { pid: 72, ppid: 30, name: "node", command: "node /work/scripts/agenc.js" },
    ] };
    for (const pid of [61, 62, 63, 64]) expect(selfTerminationRisk(`kill ${pid}`, darwinProbe) ?? "allowed").toContain(`pid ${pid}`);
    for (const pid of [70, 71, 72]) expect(selfTerminationRisk(`kill ${pid}`, darwinProbe)).toBeNull();
  });
  it("protects the owner watchdog marker the macOS rule relies on", () => {
    // The macOS rule finds the watchdog by this text in its `node -e` script.
    expect(watchdogScript).toContain("agenc-process-owner-watchdog");
  });
  itWhen(process.platform === "linux" || process.platform === "darwin")(
    "reads live AgenC siblings from the real process list",
    async () => {
      const directory = mkdtempSync(join(canonicalTmpdir(), "agenc-self-termination-"));
      // Linux finds these by their native title, macOS by entry script or watchdog script.
      const children = [
        await startIdleNodeChild({ source: cliBootstrapSource, env: {}, file: join(directory, "runtime/dist/bin/agenc.js") }),
        await startIdleNodeChild({ source: launcherBootstrapSource, env: {}, file: join(directory, "agenc/bin/agenc") }),
        await startIdleNodeChild({ source: watchdogBootstrapSource, env: {} }),
      ];
      const worker = await startIdleNodeChild({ source: "", env: {}, file: join(directory, "work/bin/worker.js") });
      try {
        for (const child of children) expect(selfTerminationRisk(`kill ${child.pid}`) ?? "allowed").toContain(`pid ${child.pid}`);
        expect(selfTerminationRisk(`kill ${worker.pid}`)).toBeNull();
      } finally {
        for (const child of [...children, worker]) await child.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
