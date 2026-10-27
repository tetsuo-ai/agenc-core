import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readCgroupMemoryEvidence } from "../../src/app-server/daemon-memory-evidence.js";
import { readDaemonDisconnectEvidence } from "../../src/app-server/daemon-disconnect-evidence.js";
import { resolveAgenCDaemonHome } from "../../src/app-server/daemon-discovery.js";
import { awaitDaemonOneShotRun } from "../../src/bin/daemon-one-shot-cli.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("daemon disconnect evidence", () => {
  it("retains only numeric memory and OOM counters", () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/fixture\n",
      "/sys/fs/cgroup/fixture/memory.current": "1024\n",
      "/sys/fs/cgroup/fixture/memory.max": "4096\n",
      "/sys/fs/cgroup/fixture/memory.events": "oom 2\noom_kill 1\nhigh 8\nsecret synthetic-secret\n",
    };
    expect(readCgroupMemoryEvidence(path => { if (!(path in files)) throw new Error("absent"); return files[path]!; }))
      .toEqual({ currentBytes: 1024, limitBytes: 4096, oom: 2, oom_kill: 1, high: 8 });
    expect(readCgroupMemoryEvidence(() => { throw new Error("no procfs"); })).toBeUndefined();
  });

  function fixture() {
    const home = mkdtempSync(join(tmpdir(), "daemon-disconnect-")); homes.push(home);
    const env = { HOME: home, AGENC_HOME: home };
    const daemonHome = resolveAgenCDaemonHome(env, home); mkdirSync(daemonHome, { recursive: true });
    writeFileSync(join(daemonHome, "daemon-heartbeat.json"), JSON.stringify({ pid: 42, beat: 3,
      at: "2026-10-23T12:00:00Z", uptimeS: 10, rssMb: 200, heapUsedMb: 100, eventLoopLagMs: 0,
      cgroup: { oom_kill: 1, secret: "synthetic-secret" }, env: { API_KEY: "synthetic-secret" } }));
    writeFileSync(join(daemonHome, "daemon-exit.json"), JSON.stringify({ pid: 42, at: "2026-10-23T12:00:01Z",
      code: null, signal: "SIGKILL", secret: "synthetic-secret" }));
    return { env, daemonHome };
  }

  it("reports observed exit signals with memory and excludes arbitrary file fields", () => {
    const { env, daemonHome } = fixture();
    const evidence = readDaemonDisconnectEvidence(env);
    expect(evidence.exit).toMatchObject({ pid: 42, code: null, signal: "SIGKILL" });
    expect(evidence.heartbeat).toMatchObject({ rssMb: 200, cgroup: { oom_kill: 1 } });
    expect(JSON.stringify(evidence)).not.toContain("synthetic-secret");
    writeFileSync(join(daemonHome, "daemon-exit.json"), JSON.stringify({ pid: 41, at: "2026-10-23T12:00:01Z", code: 1, signal: null }));
    expect(readDaemonDisconnectEvidence(env).exit).toBeUndefined();
  });

  it("emits one failed JSON result on a mocked daemon loss instead of success", async () => {
    const { env } = fixture();
    let stdout = "", stderr = "";
    const client = {
      request: async () => ({}),
      subscribeToSessionEvents: () => () => {},
      subscribeToConnectionState: (listener: (state: { status: string }) => void) => {
        queueMicrotask(() => listener({ status: "disconnected" })); return () => {};
      },
    };
    await expect(awaitDaemonOneShotRun({ env,
      daemonClient: client as unknown as Parameters<typeof awaitDaemonOneShotRun>[0]["daemonClient"],
      io: { stdout: { write: (chunk: string) => { stdout += chunk; } }, stderr: { write: (chunk: string) => { stderr += chunk; } } },
      sessionId: "fixture", agentId: "fixture-agent", outputFormat: "json", signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
    })).rejects.toThrow(/connection closed/);
    expect(JSON.parse(stdout)).toMatchObject({ exitCode: 1, failureCode: "daemon_disconnected",
      usableFinalAnswer: false, durationMs: expect.any(Number), remainingDeadlineMs: expect.any(Number),
      daemonEvidence: { exit: { signal: "SIGKILL" }, heartbeat: { rssMb: 200 } } });
    expect(stderr).not.toContain("synthetic-secret");
  });
});
