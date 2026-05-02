import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { AgenCShutdownSignal } from "../lifecycle/index.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import {
  createAgenCJsonLineDaemonRequestClient,
} from "./agent-cli.js";
import {
  defaultAgenCDaemonPidPath,
  ensureAgenCDaemonCookie,
  parseAgenCDaemonCliArgs,
  readAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSnapshotPath,
  resolveAgenCDaemonSocketPath,
  runAgenCDaemonCli,
  writeAgenCDaemonPid,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
} from "./daemon-cli.js";

function createIo(): AgenCDaemonCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function createHost(agencHome: string): AgenCDaemonCliHost & {
  readonly runningPids: Set<number>;
  readonly terminatedPids: number[];
} {
  let nextPid = 4200;
  const runningPids = new Set<number>();
  const terminatedPids: number[] = [];
  return {
    env: { AGENC_HOME: agencHome },
    userHome: "/home/test",
    entrypointPath: "/opt/agenc/bin/agenc.js",
    execPath: "/usr/bin/node",
    pid: 4100,
    runningPids,
    terminatedPids,
    spawnDetachedDaemon: () => {
      nextPid += 1;
      runningPids.add(nextPid);
      return nextPid;
    },
    isPidRunning: (pid) => runningPids.has(pid),
    terminatePid: (pid) => {
      terminatedPids.push(pid);
      runningPids.delete(pid);
    },
    sleep: async () => {},
  };
}

function createSignalProcess() {
  const listeners = new Map<AgenCShutdownSignal, Set<() => void>>();
  return {
    once: (signal: AgenCShutdownSignal, listener: () => void) => {
      let set = listeners.get(signal);
      if (set === undefined) {
        set = new Set();
        listeners.set(signal, set);
      }
      set.add(listener);
    },
    removeListener: (signal: AgenCShutdownSignal, listener: () => void) => {
      listeners.get(signal)?.delete(listener);
    },
    emit(signal: AgenCShutdownSignal): void {
      for (const listener of [...(listeners.get(signal) ?? [])]) {
        listener();
      }
    },
  };
}

async function tempAgencHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-daemon-cli-"));
}

async function waitForPid(pidPath: string): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const pid = await readAgenCDaemonPid(pidPath);
    if (pid !== null) return pid;
    await delay(10);
  }
  throw new Error("timed out waiting for daemon pid");
}

describe("AgenC daemon CLI", () => {
  it("resolves the required pid file path", () => {
    expect(defaultAgenCDaemonPidPath("/home/test")).toBe(
      "/home/test/.agenc/daemon.pid",
    );
    expect(resolveAgenCDaemonPidPath({}, "/home/test")).toBe(
      "/home/test/.agenc/daemon.pid",
    );
    expect(resolveAgenCDaemonPidPath({ AGENC_HOME: "/tmp/agenc-home" })).toBe(
      "/tmp/agenc-home/daemon.pid",
    );
    expect(resolveAgenCDaemonSocketPath({}, "/home/test")).toBe(
      "/home/test/.agenc/daemon.sock",
    );
    expect(resolveAgenCDaemonSocketPath({ AGENC_HOME: "/tmp/agenc-home" })).toBe(
      "/tmp/agenc-home/daemon.sock",
    );
    expect(resolveAgenCDaemonCookiePath({}, "/home/test")).toBe(
      "/home/test/.agenc/daemon.cookie",
    );
    expect(resolveAgenCDaemonCookiePath({ AGENC_HOME: "/tmp/agenc-home" })).toBe(
      "/tmp/agenc-home/daemon.cookie",
    );
    expect(resolveAgenCDaemonSnapshotPath({}, "/home/test")).toBe(
      "/home/test/.agenc/daemon-snapshot.json",
    );
    expect(resolveAgenCDaemonSnapshotPath({ AGENC_HOME: "/tmp/agenc-home" })).toBe(
      "/tmp/agenc-home/daemon-snapshot.json",
    );
  });

  it("creates a private daemon cookie and reuses it", async () => {
    const agencHome = await tempAgencHome();
    const cookiePath = resolveAgenCDaemonCookiePath(
      { AGENC_HOME: agencHome },
      "/home/test",
    );

    const first = await ensureAgenCDaemonCookie(cookiePath);
    const second = await ensureAgenCDaemonCookie(cookiePath);
    const mode = (await stat(cookiePath)).mode & 0o777;

    expect(first).toHaveLength(64);
    expect(second).toBe(first);
    expect(mode).toBe(0o600);

    await rm(agencHome, { recursive: true, force: true });
  });

  it("parses daemon subcommands without claiming normal prompts", () => {
    expect(parseAgenCDaemonCliArgs(["hello"])).toBeNull();
    expect(parseAgenCDaemonCliArgs(["daemon", "start"])).toEqual({
      kind: "command",
      action: "start",
    });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart"])).toEqual({
      kind: "command",
      action: "restart",
    });
    expect(parseAgenCDaemonCliArgs(["daemon", "bogus"])).toEqual({
      kind: "error",
      message: "unknown daemon command: bogus",
    });
  });

  it("starts once, writes daemon.pid, and reports running status", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);

    await expect(
      runAgenCDaemonCli({ kind: "command", action: "start" }, { host, io }),
    ).resolves.toBe(0);
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(4201);
    expect(io.stdoutText()).toContain("AgenC daemon started (pid 4201)");

    await expect(
      runAgenCDaemonCli({ kind: "command", action: "status" }, { host, io }),
    ).resolves.toBe(0);
    expect(io.stdoutText()).toContain("AgenC daemon running (pid 4201)");

    await expect(
      runAgenCDaemonCli({ kind: "command", action: "start" }, { host, io }),
    ).resolves.toBe(0);
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(4201);
    expect(host.runningPids).toEqual(new Set([4201]));

    await rm(agencHome, { recursive: true, force: true });
  });

  it("starts with remote auth backend before remote key vending is configured", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    await writeFile(join(agencHome, "config.toml"), "[auth]\nbackend = \"remote\"\n");

    await expect(
      runAgenCDaemonCli({ kind: "command", action: "start" }, { host, io }),
    ).resolves.toBe(0);

    await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(4201);
    expect(host.runningPids).toEqual(new Set([4201]));
    expect(io.stdoutText()).toContain("AgenC daemon started (pid 4201)");
    expect(io.stderrText()).toBe("");

    await rm(agencHome, { recursive: true, force: true });
  });

  it("stops a running daemon and removes the pid file", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    host.runningPids.add(4300);
    await writeAgenCDaemonPid(pidPath, 4300);

    await expect(
      runAgenCDaemonCli({ kind: "command", action: "stop" }, { host, io }),
    ).resolves.toBe(0);
    expect(host.terminatedPids).toEqual([4300]);
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBeNull();
    expect(io.stdoutText()).toContain("AgenC daemon stopped (pid 4300)");

    await expect(
      runAgenCDaemonCli({ kind: "command", action: "status" }, { host, io }),
    ).resolves.toBe(1);
    expect(io.stdoutText()).toContain("AgenC daemon stopped");

    await rm(agencHome, { recursive: true, force: true });
  });

  it("restart tolerates a stopped daemon and starts a fresh pid", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);

    await expect(
      runAgenCDaemonCli({ kind: "command", action: "restart" }, { host, io }),
    ).resolves.toBe(0);
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(4201);
    expect(io.stdoutText()).toContain("AgenC daemon started (pid 4201)");

    await rm(agencHome, { recursive: true, force: true });
  });

  it("foreground daemon routes SIGHUP through cleanup and removes daemon.pid", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const signalProcess = createSignalProcess();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io, signalProcess },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);

    signalProcess.emit("SIGHUP");

    await expect(running).resolves.toBe(130);
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBeNull();
    await expect(
      readFile(resolveAgenCDaemonSnapshotPath(host.env, host.userHome), "utf8"),
    ).resolves.toContain('"agents": []');
    expect(io.stderrText()).toContain(
      "AgenC daemon received SIGHUP; treating terminal loss as shutdown",
    );

    await rm(agencHome, { recursive: true, force: true });
  });

  it("foreground daemon instantiates AuthBackend for auth requests", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const signalProcess = createSignalProcess();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
    const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io, signalProcess },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);

    const authCookie = (await readFile(cookiePath, "utf8")).trim();
    const client = createAgenCJsonLineDaemonRequestClient({
      socketPath,
      authCookie,
      timeoutMs: 1000,
    });
    await expect(client.request("auth.whoami")).resolves.toEqual({
      authenticated: false,
    });
    await expect(client.request("auth.login")).resolves.toMatchObject({
      authenticated: true,
      provider: "local",
    });
    await expect(readFile(join(agencHome, "auth.json"), "utf8")).resolves.toContain(
      '"token"',
    );
    await expect(client.request("auth.whoami")).resolves.toMatchObject({
      authenticated: true,
      provider: "local",
    });

    signalProcess.emit("SIGTERM");
    await expect(running).resolves.toBe(0);

    await rm(agencHome, { recursive: true, force: true });
  });

  it("foreground daemon does not advertise running after startup signal", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const signalProcess = createSignalProcess();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      {
        host,
        io,
        signalProcess,
        beforeDaemonReady: () => signalProcess.emit("SIGHUP"),
      },
    );

    await expect(running).resolves.toBe(130);
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBeNull();
    expect(io.stdoutText()).not.toContain("AgenC daemon running");

    await rm(agencHome, { recursive: true, force: true });
  });

  it("foreground daemon starts with remote auth backend before remote login flow lands", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const signalProcess = createSignalProcess();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    await writeFile(join(agencHome, "config.toml"), "[auth]\nbackend = \"remote\"\n");

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io, signalProcess },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);

    expect(io.stdoutText()).toContain("AgenC daemon running");
    signalProcess.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBeNull();

    await rm(agencHome, { recursive: true, force: true });
  });

  it("foreground daemon runs restart recovery before advertising readiness", async () => {
    const agencHome = await tempAgencHome();
    const otherCwd = await mkdtemp(join(tmpdir(), "agenc-daemon-other-cwd-"));
    await mkdir(join(otherCwd, ".git"));
    const host = createHost(agencHome);
    const io = createIo();
    const signalProcess = createSignalProcess();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
    seedRecoverableDaemonState(agencHome, {
      cwd: process.cwd(),
      runId: "run-restart",
      sessionId: "session-restart",
      toolCallId: "tool-restart",
    });
    seedRecoverableDaemonState(agencHome, {
      cwd: otherCwd,
      runId: "run-other",
      sessionId: "session-other",
      toolCallId: "tool-other",
      status: "blocked",
    });

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io, signalProcess },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);

    expect(io.stderrText()).toContain(
      "daemon recovery loaded 2 agent run(s) from state",
    );
    expect(io.stderrText()).toContain(
      "daemon recovery marked 2 stale in-flight tool call(s) failed",
    );
    const authCookie = (await readFile(cookiePath, "utf8")).trim();
    const client = createAgenCJsonLineDaemonRequestClient({
      socketPath: resolveAgenCDaemonSocketPath(host.env, host.userHome),
      authCookie,
      timeoutMs: 1000,
    });
    const agentList = await client.request("agent.list", {});
    expect(agentList.agents.map((agent) => agent.agentId)).toEqual([
      "run-other",
      "run-restart",
    ]);
    expect(agentList.agents[1]).toMatchObject({
      agentId: "run-restart",
      objective: "recover daemon state",
      status: "idle",
      activeSessionIds: ["session-restart"],
      metadata: {
        recovery: {
          runStatus: "running",
          runnable: false,
          runtimeRestore: "unavailable",
          toolRecoveryMode: "mark_failed",
          snapshot: {
            sessionId: "session-restart",
            toolState: { pending: ["tool-restart"] },
            failedToolCalls: [
              {
                toolCallId: "tool-restart",
                statusAfter: "failed",
              },
            ],
          },
        },
      },
    });
    expect(agentList.agents[0]).toMatchObject({
      agentId: "run-other",
      status: "idle",
      metadata: {
        recovery: {
          runStatus: "blocked",
          runnable: false,
        },
      },
    });
    await expect(
      client.request("agent.attach", {
        agentId: "run-restart",
        clientId: "client-restart",
      }),
    ).resolves.toMatchObject({
      agentId: "run-restart",
      sessionIds: ["session-restart"],
      sessions: [
        {
          sessionId: "session-restart",
          agentId: "run-restart",
          status: "waiting",
          metadata: {
            recovery: {
              snapshot: {
                failedToolCalls: [
                  {
                    toolCallId: "tool-restart",
                    statusAfter: "failed",
                  },
                ],
              },
            },
          },
        },
      ],
    });
    await expect(
      client.request("message.stream", {
        sessionId: "session-restart",
        content: "continue",
      }),
    ).rejects.toThrow(
      "AgenC daemon agent recovered without a live runtime: run-restart",
    );

    signalProcess.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
    expect(readRecoveredToolStatus(agencHome, process.cwd(), "tool-restart")).toBe(
      "failed",
    );
    expect(readRecoveredToolStatus(agencHome, otherCwd, "tool-other")).toBe(
      "failed",
    );

    await rm(otherCwd, { recursive: true, force: true });
    await rm(agencHome, { recursive: true, force: true });
  });

  it("foreground daemon reports cleanup failures and keeps cleaning up", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const signalProcess = createSignalProcess();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    await mkdir(resolveAgenCDaemonSnapshotPath(host.env, host.userHome), {
      recursive: true,
    });

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io, signalProcess },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);

    signalProcess.emit("SIGTERM");

    await expect(running).resolves.toBe(1);
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBeNull();
    expect(io.stderrText()).toContain("cleanup[daemon-snapshots] failed");

    await rm(agencHome, { recursive: true, force: true });
  });
});

function seedRecoverableDaemonState(
  agencHome: string,
  params: {
    readonly cwd: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly status?: string;
  },
): void {
  const driver = openStateDatabases({
    cwd: params.cwd,
    agencHome,
  });
  try {
    driver
      .prepareState(
        `INSERT INTO agent_runs (
          id,
          objective,
          status,
          started_at,
          last_active_at,
          current_session_id,
          created_by_client,
          last_snapshot_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.runId,
        "recover daemon state",
        params.status ?? "running",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:05:00.000Z",
        params.sessionId,
        "client-1",
        "2026-05-01T00:06:00.000Z",
      );
    driver
      .prepareState(
        `INSERT INTO session_state_snapshots (
          session_id,
          snapshot_at,
          conversation_json,
          tool_state_json,
          mcp_connection_state_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.sessionId,
        "2026-05-01T00:06:00.000Z",
        JSON.stringify([{ role: "assistant", content: "state" }]),
        JSON.stringify({ pending: [params.toolCallId] }),
        JSON.stringify({ connected: true }),
      );
    driver
      .prepareState(
        `INSERT INTO in_flight_tool_calls (
          session_id,
          tool_call_id,
          tool_name,
          args_json,
          status,
          output_partial,
          started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sessionId,
        params.toolCallId,
        "FileWrite",
        JSON.stringify({ path: "a.txt" }),
        "running",
        null,
        "2026-05-01T00:05:00.000Z",
      );
  } finally {
    driver.close();
  }
}

function readRecoveredToolStatus(
  agencHome: string,
  cwd: string,
  toolCallId: string,
): string | undefined {
  const driver = openStateDatabases({
    cwd,
    agencHome,
  });
  try {
    return driver
      .prepareState<[string], { status: string }>(
        `SELECT status
         FROM in_flight_tool_calls
         WHERE tool_call_id = ?`,
      )
      .get(toolCallId)?.status;
  } finally {
    driver.close();
  }
}
