import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgenCShutdownSignal } from "../lifecycle/index.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import {
  createAgenCJsonLineDaemonRequestClient,
} from "./agent-cli.js";
import {
  defaultAgenCDaemonPidPath,
  ensureAgenCDaemonCookie,
  formatAgenCDaemonCliHelpText,
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
import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBackgroundAgentRunner,
  type AgenCBackgroundAgentSessionEventBinding,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
  type AgenCRunAgentFunction,
} from "./background-agent-runner.js";
import { AgentStatusTracker } from "../agents/status.js";
import { Mailbox } from "../agents/mailbox.js";
import { resolveAgentRole } from "../agents/role.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { LiveAgent } from "../agents/control.js";
import type { AgentMetadata } from "../agents/registry.js";

type ResumeAgentFromRolloutParams = {
  readonly rootThreadId: string;
  readonly parentPath: string;
  readonly metadata: AgentMetadata;
};

function restoredLiveAgent(
  agentId: string,
  agentPath = `/root/${agentId}`,
): LiveAgent {
  const metadata: AgentMetadata = {
    agentId,
    agentPath,
    agentNickname: agentId,
    agentRole: "default",
    depth: 1,
  };
  return {
    agentId,
    agentPath,
    role: resolveAgentRole(undefined),
    depth: 1,
    nickname: agentId,
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: agentId }),
    downInbox: new Mailbox({ threadId: `${agentId}-down` }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

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

async function waitForSnapshotCount(
  agencHome: string,
  cwd: string,
  sessionId: string,
  minimum: number,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const count = snapshotCount(agencHome, cwd, sessionId);
    if (count >= minimum) return count;
    await delay(10);
  }
  throw new Error(`timed out waiting for snapshots for ${sessionId}`);
}

function readSocketLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      cleanup();
      resolve(line);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("daemon socket closed before a full line was read"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function waitForSocketClose(socket: Socket): Promise<"closed" | "open"> {
  if (socket.closed || socket.destroyed) return "closed";
  return Promise.race([
    once(socket, "close").then(() => "closed" as const),
    delay(500).then(() => "open" as const),
  ]);
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
    expect(parseAgenCDaemonCliArgs(["daemon", "start", "--foreground"])).toEqual(
      {
        kind: "command",
        action: "run",
      },
    );
    expect(
      parseAgenCDaemonCliArgs(["daemon", "start", "--foreground", "--bogus"]),
    ).toEqual({
      kind: "error",
      message: "unknown daemon start option: --bogus",
    });
    expect(parseAgenCDaemonCliArgs(["daemon", "start", "--bogus"])).toEqual({
      kind: "error",
      message: "unknown daemon start option: --bogus",
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

  it("documents foreground daemon mode and ships supervisor templates", async () => {
    const helpText = formatAgenCDaemonCliHelpText();
    expect(helpText).toContain("agenc daemon start --foreground");
    expect(helpText).toContain("Run the daemon in the current process");

    const repoRoot = resolve(process.cwd(), "..");
    const systemd = await readFile(
      join(repoRoot, "packaging/systemd/agenc-daemon.service"),
      "utf8",
    );
    const launchd = await readFile(
      join(repoRoot, "packaging/launchd/dev.agenc.daemon.plist"),
      "utf8",
    );
    const windows = await readFile(
      join(repoRoot, "packaging/windows/agenc-daemon.xml"),
      "utf8",
    );

    expect(systemd).toContain(
      "ExecStart=/usr/bin/env agenc daemon start --foreground",
    );
    expect(systemd).toContain("Restart=on-failure");
    expect(launchd).toContain("<string>dev.agenc.daemon</string>");
    expect(launchd).toContain("<string>agenc</string>");
    expect(launchd).toContain("<string>--foreground</string>");
    expect(windows).toContain("<id>agenc-daemon</id>");
    expect(windows).toContain(
      "<arguments>daemon start --foreground</arguments>",
    );
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
    const rejectedClient = createAgenCJsonLineDaemonRequestClient({
      socketPath,
      authCookie: "wrong-daemon-cookie",
      timeoutMs: 1000,
    });
    await expect(rejectedClient.request("auth.whoami")).rejects.toThrow(
      "daemon connection authentication failed",
    );
    const rejectedSocket = createConnection(socketPath);
    await once(rejectedSocket, "connect");
    rejectedSocket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "bad-init",
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          clientName: "agenc-auth-test",
          authCookie: "wrong-daemon-cookie",
          capabilities: {},
        },
      })}\n`,
    );
    const rejectedLine = JSON.parse(await readSocketLine(rejectedSocket)) as {
      readonly error?: { readonly data?: { readonly code?: string } };
    };
    expect(rejectedLine.error?.data?.code).toBe(
      "CONNECTION_AUTHENTICATION_FAILED",
    );
    await expect(waitForSocketClose(rejectedSocket)).resolves.toBe("closed");
    const missingCookieSocket = createConnection(socketPath);
    await once(missingCookieSocket, "connect");
    missingCookieSocket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "missing-cookie-init",
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          clientName: "agenc-auth-test",
          capabilities: {},
        },
      })}\n`,
    );
    const missingCookieLine = JSON.parse(
      await readSocketLine(missingCookieSocket),
    ) as {
      readonly error?: { readonly data?: { readonly code?: string } };
    };
    expect(missingCookieLine.error?.data?.code).toBe(
      "CONNECTION_AUTHENTICATION_FAILED",
    );
    await expect(waitForSocketClose(missingCookieSocket)).resolves.toBe(
      "closed",
    );

    const client = createAgenCJsonLineDaemonRequestClient({
      socketPath,
      authCookie,
      timeoutMs: 1000,
    });
    await expect(client.request("auth.whoami")).resolves.toEqual({
      authenticated: false,
      identity: {
        daemon: {
          transport: "daemon",
          verifiedBy: "cookie",
          cookie: "verified",
          peerUid: null,
        },
      },
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
      identity: {
        daemon: {
          transport: "daemon",
          verifiedBy: "cookie",
          cookie: "verified",
          peerUid: null,
        },
      },
    });

    signalProcess.emit("SIGTERM");
    await expect(running).resolves.toBe(0);

    await rm(agencHome, { recursive: true, force: true });
  });

  it("foreground daemon serves read-only state stats to daemon clients", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const io = createIo();
    const signalProcess = createSignalProcess();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
    const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent-health-state",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      submitAgentMessage: async () => {},
    };

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io, signalProcess, runner },
    );
    let stopped = false;
    try {
      await expect(waitForPid(pidPath)).resolves.toBe(4100);

      const authCookie = (await readFile(cookiePath, "utf8")).trim();
      const writerClient = createAgenCJsonLineDaemonRequestClient({
        socketPath,
        authCookie,
        timeoutMs: 1000,
      });
      const readerClientA = createAgenCJsonLineDaemonRequestClient({
        socketPath,
        authCookie,
        timeoutMs: 1000,
      });
      const readerClientB = createAgenCJsonLineDaemonRequestClient({
        socketPath,
        authCookie,
        timeoutMs: 1000,
      });

      const created = await writerClient.request("agent.create", {
        objective: "health state",
      });
      if (created.sessionId === undefined) throw new Error("session id missing");
      const initialStats = await readerClientA.request("health.stats");
      expect(initialStats.sessions).toMatchObject({
        active: 1,
        closed: 0,
        total: 1,
      });
      expect(initialStats.state).toMatchObject({
        available: true,
        readonly: true,
        agentRuns: 1,
      });
      const initialSnapshots = initialStats.state?.sessionStateSnapshots ?? 0;

      const [streamed, statsA, statsB] = await Promise.all([
        writerClient.request("message.stream", {
          sessionId: created.sessionId,
          content: "hello",
          clientMessageId: "message-health-state",
          streamId: "stream-health-state",
        }),
        readerClientA.request("health.stats"),
        readerClientB.request("health.stats"),
      ]);
      expect(streamed).toMatchObject({
        messageId: "message-health-state",
        streamId: "stream-health-state",
      });
      expect(statsA.state).toMatchObject({
        available: true,
        readonly: true,
      });
      expect(statsB.state).toMatchObject({
        available: true,
        readonly: true,
      });
      const finalStats = await readerClientA.request("health.stats");
      expect(finalStats.state?.sessionStateSnapshots).toBeGreaterThan(
        initialSnapshots,
      );

      signalProcess.emit("SIGTERM");
      stopped = true;
      await expect(running).resolves.toBe(0);
    } finally {
      if (!stopped) {
        signalProcess.emit("SIGTERM");
        await running.catch(() => {});
      }
      await rm(agencHome, { recursive: true, force: true });
    }
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
    seedTerminalDaemonRun(agencHome, {
      cwd: process.cwd(),
      runId: "run-prune",
      sessionId: "session-prune",
      status: "completed",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    seedRecoverableDaemonState(agencHome, {
      cwd: otherCwd,
      runId: "run-other",
      sessionId: "session-other",
      toolCallId: "tool-other",
      status: "blocked",
    });
    const resumedRoots: unknown[] = [];
    const live = restoredLiveAgent("run-restart", "/root/run-restart");
    const resumeAgentFromRollout = async (
      params: ResumeAgentFromRolloutParams,
    ) => {
      resumedRoots.push(params);
      return params.rootThreadId === "run-restart"
        ? { resumedCount: 1, rootLive: live }
        : { resumedCount: 0, rootLive: null };
    };
    const sendInput = vi.fn(async () => {});
    let runParams: Parameters<AgenCRunAgentFunction>[0] | undefined;
    const runAgentFn = (async function* (
      params: Parameters<AgenCRunAgentFunction>[0],
    ) {
      runParams = params;
      params.live.status.markRunning("turn-restart");
      yield { kind: "status", text: "restored" };
      await new Promise(() => {});
    }) as AgenCRunAgentFunction;
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: async () => {},
    };
    const runner: AgenCBackgroundAgentRunner =
      new AgenCDelegateBackgroundAgentRunner({
        bootstrap: (async () => ({
          session: {
            conversationId: "daemon-recovery",
            permissionModeRegistry,
            services: {},
          },
          shutdown: async () => {},
        })) as AgenCBootstrapFunction,
        ensureAgentControl: (() => ({
          control: {
            resumeAgentFromRollout,
            sendInput,
            shutdown: async () => {},
          },
          registry: {},
        })) as AgenCEnsureAgentControlFunction,
        runAgentFn,
        now: () => "2026-05-01T12:00:00.000Z",
      });

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io, signalProcess, runner, snapshotPeriodicIntervalMs: 10 },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);
    await expect(
      waitForSnapshotCount(agencHome, process.cwd(), "session-restart", 2),
    ).resolves.toBeGreaterThanOrEqual(2);
    await expect(
      waitForSnapshotCount(agencHome, otherCwd, "session-other", 2),
    ).resolves.toBeGreaterThanOrEqual(2);
    expect(latestSnapshotToolState(agencHome, otherCwd, "session-other"))
      .toMatchObject({
        lastTrigger: "periodic",
        pending: ["tool-other"],
      });

    expect(io.stderrText()).toContain(
      "daemon recovery loaded 2 agent run(s) from state",
    );
    expect(io.stderrText()).toContain(
      "daemon recovery marked 2 stale in-flight tool call(s) failed",
    );
    expect(resumedRoots).toHaveLength(2);
    expect(resumedRoots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rootThreadId: "run-restart",
          metadata: expect.objectContaining({
            agentId: "run-restart",
          }),
        }),
        expect.objectContaining({
          rootThreadId: "run-other",
          metadata: expect.objectContaining({
            agentId: "run-other",
          }),
        }),
      ]),
    );
    expect(runParams?.initialMessages).toEqual([
      { role: "assistant", content: "state" },
    ]);
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
      status: "running",
      activeSessionIds: ["session-restart"],
      metadata: {
        recovery: {
          runStatus: "running",
          runnable: true,
          runtimeRestore: "available",
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
    ).resolves.toMatchObject({
      messageId: expect.any(String),
      streamId: expect.any(String),
    });
    expect(sendInput).toHaveBeenCalledWith("run-restart", "continue");

    signalProcess.emit("SIGTERM");
    await expect(running).resolves.toBe(0);
    expect(readRecoveredToolStatus(agencHome, process.cwd(), "tool-restart")).toBe(
      "failed",
    );
    expect(readRecoveredToolStatus(agencHome, otherCwd, "tool-other")).toBe(
      "failed",
    );
    expect(readAgentRunStatus(agencHome, process.cwd(), "run-prune")).toBeUndefined();

    await rm(otherCwd, { recursive: true, force: true });
    await rm(agencHome, { recursive: true, force: true });
  });

  it("recovers an agent.create row left running by a crash-style restart", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
    const firstSignal = createSignalProcess();
    const createdAgentId = "agent-created-restart";
    const startRunner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: createdAgentId,
        agentPath: `/root/${createdAgentId}`,
        startedAt: "2026-05-01T12:00:00.000Z",
        status: "running",
      }),
      stopAgent: async () => {},
    };

    const first = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io: createIo(), signalProcess: firstSignal, runner: startRunner },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);
    const firstCookie = (await readFile(cookiePath, "utf8")).trim();
    const firstClient = createAgenCJsonLineDaemonRequestClient({
      socketPath: resolveAgenCDaemonSocketPath(host.env, host.userHome),
      authCookie: firstCookie,
      timeoutMs: 1000,
    });
    const created = await firstClient.request("agent.create", {
      objective: "survive daemon restart",
      cwd: process.cwd(),
      model: "grok-4",
      provider: "xai",
      profile: "fast",
      unattendedAllow: ["FileRead"],
      unattendedDeny: ["system.bash"],
    });
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("session id missing");
    expect(created.agentId).toBe(createdAgentId);
    expect(readAgentRunStatus(agencHome, process.cwd(), createdAgentId)).toBe(
      "running",
    );
    expect(snapshotCount(agencHome, process.cwd(), sessionId)).toBeGreaterThan(0);

    firstSignal.emit("SIGTERM");
    await expect(first).resolves.toBe(0);
    // The harness can only stop gracefully; reset the row to simulate a crash
    // after proving agent.create produced the running row and session snapshot.
    markAgentRunRunning(agencHome, process.cwd(), createdAgentId, sessionId);

    const resumedRoots: unknown[] = [];
    const live = restoredLiveAgent(createdAgentId, `/root/${createdAgentId}`);
    const resumeAgentFromRollout = async (
      params: ResumeAgentFromRolloutParams,
    ) => {
      resumedRoots.push(params);
      return params.rootThreadId === createdAgentId
        ? { resumedCount: 1, rootLive: live }
        : { resumedCount: 0, rootLive: null };
    };
    const sendInput = vi.fn(async () => {});
    let runParams: Parameters<AgenCRunAgentFunction>[0] | undefined;
    let restoreBootstrapOptions:
      | Parameters<AgenCBootstrapFunction>[0]
      | undefined;
    const runAgentFn = (async function* (
      params: Parameters<AgenCRunAgentFunction>[0],
    ) {
      runParams = params;
      params.live.status.markRunning("turn-created-restart");
      yield { kind: "status", text: "restored" };
      await new Promise(() => {});
    }) as AgenCRunAgentFunction;
    const secondSignal = createSignalProcess();
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const restoreRunner: AgenCBackgroundAgentRunner =
      new AgenCDelegateBackgroundAgentRunner({
        bootstrap: (async (options) => {
          restoreBootstrapOptions = options;
          return {
            session: {
              conversationId: "daemon-recovery",
              permissionModeRegistry,
              services: {},
            },
            shutdown: async () => {},
          };
        }) as AgenCBootstrapFunction,
        ensureAgentControl: (() => ({
          control: {
            resumeAgentFromRollout,
            sendInput,
            shutdown: async () => {},
          },
          registry: {},
        })) as AgenCEnsureAgentControlFunction,
        runAgentFn,
        now: () => "2026-05-01T12:01:00.000Z",
      });

    const second = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      {
        host,
        io: createIo(),
        signalProcess: secondSignal,
        runner: restoreRunner,
      },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);
    expect(resumedRoots).toEqual([
      expect.objectContaining({
        rootThreadId: createdAgentId,
        metadata: expect.objectContaining({
          agentId: createdAgentId,
        }),
      }),
    ]);
    expect(runParams?.taskPrompt).toBe("survive daemon restart");
    expect(runParams?.model).toBe("grok-4");
    expect(restoreBootstrapOptions?.argv).toEqual(
      expect.arrayContaining([
        "--provider",
        "xai",
        "--model",
        "grok-4",
        "--profile",
        "fast",
      ]),
    );
    expect(permissionModeRegistry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        alwaysAllowRules: expect.objectContaining({
          session: ["FileRead"],
        }),
        alwaysDenyRules: expect.objectContaining({
          session: ["system.bash"],
        }),
      }),
    );

    const secondCookie = (await readFile(cookiePath, "utf8")).trim();
    const secondClient = createAgenCJsonLineDaemonRequestClient({
      socketPath: resolveAgenCDaemonSocketPath(host.env, host.userHome),
      authCookie: secondCookie,
      timeoutMs: 1000,
    });
    const agentList = await secondClient.request("agent.list", {});
    const recovered = agentList.agents.find(
      (agent) => agent.agentId === createdAgentId,
    );
    expect(recovered).toMatchObject({
      agentId: createdAgentId,
      status: "running",
      metadata: {
        recovery: {
          runnable: true,
          runtimeRestore: "available",
        },
      },
    });

    secondSignal.emit("SIGTERM");
    await expect(second).resolves.toBe(0);
    await rm(agencHome, { recursive: true, force: true });
  });

  it("routes attach-time session events to a non-default project database", async () => {
    const agencHome = await tempAgencHome();
    const otherCwd = await mkdtemp(join(tmpdir(), "agenc-daemon-event-cwd-"));
    await mkdir(join(otherCwd, ".git"));
    const host = createHost(agencHome);
    const io = createIo();
    const signalProcess = createSignalProcess();
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
    let binding: AgenCBackgroundAgentSessionEventBinding | undefined;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent-early-route",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      attachAgentSessionEvents: async (_agentId, nextBinding) => {
        binding = nextBinding;
        await nextBinding.emit({
          jsonrpc: "2.0",
          method: "event.tool_request",
          params: {
            sessionId: nextBinding.sessionId,
            eventId: "tool-early-route",
            agentId: "agent-early-route",
            requestId: "tool-early-route",
            toolName: "FileRead",
            input: { path: "a.txt" },
          },
        });
      },
    };

    const running = runAgenCDaemonCli(
      { kind: "command", action: "run" },
      { host, io, signalProcess, runner },
    );
    await expect(waitForPid(pidPath)).resolves.toBe(4100);

    const authCookie = (await readFile(cookiePath, "utf8")).trim();
    const client = createAgenCJsonLineDaemonRequestClient({
      socketPath: resolveAgenCDaemonSocketPath(host.env, host.userHome),
      authCookie,
      timeoutMs: 1000,
    });
    const created = await client.request("agent.create", {
      objective: "route attach event",
      cwd: otherCwd,
    });
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("session id missing");
    expect(binding?.sessionId).toBe(sessionId);
    expect(snapshotCount(agencHome, process.cwd(), sessionId)).toBe(0);
    expect(latestSnapshotToolState(agencHome, otherCwd, sessionId))
      .toMatchObject({
        inFlight: {
          "tool-early-route": {
            requestId: "tool-early-route",
            toolName: "FileRead",
          },
        },
      });

    signalProcess.emit("SIGTERM");
    await expect(running).resolves.toBe(0);

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
          last_snapshot_at,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify({
          agentPath: `/root/${params.runId.replaceAll("-", "_")}`,
        }),
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

function seedTerminalDaemonRun(
  agencHome: string,
  params: {
    readonly cwd: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly status: string;
    readonly lastActiveAt: string;
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
        "prune daemon state",
        params.status,
        "2026-01-01T00:00:00.000Z",
        params.lastActiveAt,
        params.sessionId,
        "client-1",
        params.lastActiveAt,
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
      .run(params.sessionId, params.lastActiveAt, "[]", "{}", "{}");
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

function readAgentRunStatus(
  agencHome: string,
  cwd: string,
  runId: string,
): string | undefined {
  const driver = openStateDatabases({
    cwd,
    agencHome,
  });
  try {
    return driver
      .prepareState<[string], { status: string }>(
        `SELECT status
         FROM agent_runs
         WHERE id = ?`,
      )
      .get(runId)?.status;
  } finally {
    driver.close();
  }
}

function markAgentRunRunning(
  agencHome: string,
  cwd: string,
  runId: string,
  sessionId: string,
): void {
  const driver = openStateDatabases({
    cwd,
    agencHome,
  });
  try {
    driver
      .prepareState<[string, string]>(
        `UPDATE agent_runs
         SET status = 'running',
             current_session_id = ?
         WHERE id = ?`,
      )
      .run(sessionId, runId);
  } finally {
    driver.close();
  }
}

function snapshotCount(
  agencHome: string,
  cwd: string,
  sessionId: string,
): number {
  const driver = openStateDatabases({
    cwd,
    agencHome,
  });
  try {
    return (
      driver
        .prepareState<[string], { count: number }>(
          `SELECT COUNT(*) AS count
           FROM session_state_snapshots
           WHERE session_id = ?`,
        )
        .get(sessionId)?.count ?? 0
    );
  } finally {
    driver.close();
  }
}

function latestSnapshotToolState(
  agencHome: string,
  cwd: string,
  sessionId: string,
): unknown {
  const driver = openStateDatabases({
    cwd,
    agencHome,
  });
  try {
    const row = driver
      .prepareState<[string], { tool_state_json: string }>(
        `SELECT tool_state_json
         FROM session_state_snapshots
         WHERE session_id = ?
         ORDER BY snapshot_at DESC
         LIMIT 1`,
      )
      .get(sessionId);
    if (row === undefined) throw new Error("snapshot missing");
    return JSON.parse(row.tool_state_json);
  } finally {
    driver.close();
  }
}
