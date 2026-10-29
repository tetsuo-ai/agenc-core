import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENC_DAEMON_STOP_DECLINED_EXIT,
  parseAgenCDaemonCliArgs,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonSocketPath,
  stopAgenCDaemon,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
} from "../../src/app-server/daemon-control.js";
import type { AgenCDaemonInstanceIdentity } from "../../src/app-server/daemon-instance-identity.js";
import {
  AGENC_DAEMON_RESTART_LOG_FILENAME,
  busyReasonFromAgents,
  busyReasonFromServices,
  busyReasonFromSessionDetail,
  busyReasonFromSessions,
  compareAgenCRuntimeBuilds,
  agenCCommandLabel,
  agenCRuntimeTreeOf,
  findOtherAgenCRuntimeClients,
  listLinuxAgenCProcesses,
  parseAgenCProcessList,
  probeAgenCDaemonIdle,
  readAgenCDaemonPendingRestart,
  restartAgenCDaemonWhenIdle,
  runAgenCDaemonRestartWaiter,
  runAgenCDaemonRestartWhenIdleCli,
  writeAgenCDaemonPendingRestart,
  type AgenCDaemonIdleVerdict,
  type AgenCDaemonRestartState,
  type AgenCDaemonRestartWhenIdleDeps,
  type AgenCProcessEntry,
} from "../../src/app-server/daemon-restart-when-idle.js";
import {
  formatAgenCDaemonRestartOutcome,
  parseAgenCDaemonRestartOutcome,
} from "../../src/app-server/daemon-restart-outcome.js";
import {
  resolveAgenCDaemonRuntimeInfoPath,
  writeDaemonRuntimeInfo,
} from "../../src/app-server/daemon-runtime-info.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const NEW_BUILD = { runtimeVersion: "9.9.9", commit: "new", buildTime: "2026-10-29T00:00:00.000Z" };
const OLD_BUILD = { runtimeVersion: "9.9.8", commit: "old", buildTime: "2026-10-01T00:00:00.000Z" };

function identityFor(pid: number, build = OLD_BUILD): AgenCDaemonInstanceIdentity {
  return { pid, instanceId: `instance-${pid}`, processStart: `start-${pid}`, ...build };
}

function quietIo(): AgenCDaemonCliIo & { readonly out: () => string } {
  let text = "";
  const write = (chunk: string | Uint8Array): boolean => {
    text += String(chunk);
    return true;
  };
  return {
    stdout: { write } as Pick<NodeJS.WriteStream, "write">,
    stderr: { write } as Pick<NodeJS.WriteStream, "write">,
    out: () => text,
  };
}

function testHost(home: string, overrides: Partial<AgenCDaemonCliHost> = {}): AgenCDaemonCliHost {
  return {
    env: { AGENC_HOME: home },
    userHome: home,
    entrypointPath: join(home, "runtime", "9.9.9", "tree", "node_modules", "@tetsuo-ai", "runtime", "bin", "agenc"),
    execPath: "/usr/bin/node",
    pid: 7000,
    platform: "darwin",
    spawnDetachedDaemon: () => {
      throw new Error("no spawn in this test");
    },
    isPidRunning: () => true,
    readProcessIdentity: (pid) => `start-${pid}`,
    terminatePid: () => {
      throw new Error("no signal in this test");
    },
    sleep: async () => {},
    ...overrides,
  };
}

describe("idle decisions", () => {
  it("treats any agent that is not idle as work", () => {
    expect(busyReasonFromAgents([{ status: "idle" }, { status: "running" }], NOW, 15_000))
      .toEqual({ idle: false, reason: "1 agent working" });
    expect(busyReasonFromAgents([{ status: "unknown" }, { status: "running" }], NOW, 15_000))
      .toEqual({ idle: false, reason: "2 agents working" });
  });

  it("waits out the quiet window after the last agent activity", () => {
    const recent = new Date(NOW - 4_000).toISOString();
    const old = new Date(NOW - 60_000).toISOString();
    expect(busyReasonFromAgents([{ status: "idle", lastActiveAt: recent }], NOW, 15_000))
      .toEqual({ idle: false, reason: "an agent was active 4 s ago" });
    expect(busyReasonFromAgents([{ status: "idle", lastActiveAt: old }], NOW, 15_000))
      .toEqual({ idle: true });
    expect(busyReasonFromAgents([], NOW, 15_000)).toEqual({ idle: true });
  });

  it("counts attached clients across sessions", () => {
    expect(busyReasonFromSessions([
      { sessionId: "a", status: "idle", activeAttachmentIds: ["x"], restorePending: false },
      { sessionId: "b", status: "idle", activeAttachmentIds: ["y", "z"], restorePending: false },
    ])).toEqual({ idle: false, reason: "3 clients attached" });
    expect(busyReasonFromSessions([
      { sessionId: "a", status: "idle", activeAttachmentIds: [], restorePending: false },
    ])).toEqual({ idle: true });
  });

  it("treats sub-agents, an active goal and running processes as work", () => {
    expect(busyReasonFromSessionDetail({ nativeWorkers: 1, runningProcesses: 0 }))
      .toEqual({ idle: false, reason: "1 sub-agent running" });
    expect(busyReasonFromSessionDetail({ nativeWorkers: 0, goalStatus: "active", runningProcesses: 0 }))
      .toEqual({ idle: false, reason: "a goal is active" });
    expect(busyReasonFromSessionDetail({ nativeWorkers: 0, goalStatus: "paused", runningProcesses: 2 }))
      .toEqual({ idle: false, reason: "2 background processes running" });
    expect(busyReasonFromSessionDetail({ nativeWorkers: 0, goalStatus: "met", runningProcesses: 0 }))
      .toEqual({ idle: true });
  });

  it("treats routine runs, remote devices and tool calls in flight as work", () => {
    expect(busyReasonFromServices({ activeRoutineRuns: 1, connectedRemoteDevices: 0, inFlightToolCalls: 0 }))
      .toEqual({ idle: false, reason: "1 routine running" });
    expect(busyReasonFromServices({ activeRoutineRuns: 0, connectedRemoteDevices: 2, inFlightToolCalls: 0 }))
      .toEqual({ idle: false, reason: "2 remote devices connected" });
    expect(busyReasonFromServices({ activeRoutineRuns: 0, connectedRemoteDevices: 0, inFlightToolCalls: 1 }))
      .toEqual({ idle: false, reason: "1 tool call in flight" });
    expect(busyReasonFromServices({ activeRoutineRuns: 0, connectedRemoteDevices: 0, inFlightToolCalls: 0 }))
      .toEqual({ idle: true });
  });
});

describe("older AgenC processes of the home", () => {
  const home = "/Users/me/.agenc";
  const oldTree = `${home}/runtime/9.9.8/darwin-arm64-tree/node_modules/@tetsuo-ai/runtime`;
  const newTree = `${home}/runtime/9.9.9/darwin-arm64-tree/node_modules/@tetsuo-ai/runtime`;
  const node = `${home}/bin/agenc-node`;
  const entries: AgenCProcessEntry[] = parseAgenCProcessList([
    `  1     0   0 /sbin/launchd`,
    ` 10     1 501 ${node} ${oldTree}/bin/agenc daemon start --foreground`,
    ` 11    10 501 ${node} ${oldTree}/bin/agenc mcp serve`,
    ` 20     1 501 /bin/zsh`,
    ` 21    20 501 ${node} ${oldTree}/bin/agenc`,
    ` 30    20 501 ${node} ${oldTree}/bin/agenc update`,
    ` 31    30 501 ${node} ${newTree}/bin/agenc daemon restart --when-idle --json`,
    ` 40     1 502 ${node} ${oldTree}/bin/agenc`,
    ` 50     1 501 /usr/bin/node /tmp/elsewhere/.agenc/runtime/9.9.8/x/node_modules/@tetsuo-ai/runtime/bin/agenc`,
    ` 60     1 501 ${node} ${oldTree}/bin/agenc daemon start --foreground`,
    ` 70     1 501 ${node} ${newTree}/bin/agenc -p hello`,
  ].join("\n"));

  it("labels a process by its first flag or a known subcommand only", () => {
    expect(agenCCommandLabel(`${node} ${oldTree}/bin/agenc`)).toBe("agenc");
    expect(agenCCommandLabel(`${node} ${oldTree}/bin/agenc -p summarize my notes`)).toBe("agenc -p");
    expect(agenCCommandLabel(`${node} ${oldTree}/bin/agenc update --json`)).toBe("agenc update");
    expect(agenCCommandLabel(`${node} ${oldTree}/bin/agenc deploy to prod`)).toBe("agenc");
  });

  it("parses ps output with full command lines", () => {
    expect(entries).toHaveLength(11);
    expect(entries[2]).toEqual({ pid: 11, ppid: 10, uid: 501, command: `${node} ${oldTree}/bin/agenc mcp serve` });
  });

  it("finds an older TUI and nothing else", () => {
    expect(findOtherAgenCRuntimeClients({
      entries,
      selfPid: 31,
      uid: 501,
      daemonPid: 10,
      homeRuntimeRoots: [`${home}/runtime/`],
      ownRuntimeTree: agenCRuntimeTreeOf(newTree),
    })).toEqual([21]);
  });

  it("reads Linux processes from /proc, where the title hides the command line", () => {
    const tree = "/home/me/.agenc/runtime/9.9.8/linux-x64-tree";
    const files: Record<string, string> = {
      "/proc/1/status": "Name:\tsystemd\nPPid:\t0\nUid:\t0\t0\t0\t0\n",
      "/proc/1/cmdline": "/sbin/init\0",
      "/proc/2/status": "Name:\tkthreadd\nPPid:\t0\nUid:\t0\t0\t0\t0\n",
      "/proc/2/cmdline": "",
      "/proc/300/status": "Name:\tagenc\nPPid:\t1\nUid:\t1000\t1000\t1000\t1000\n",
      "/proc/300/cmdline": "agenc\0",
    };
    const links: Record<string, string> = {
      "/proc/1/exe": "/usr/lib/systemd/systemd",
      "/proc/300/exe": `${tree}/node_modules/.agenc-node/bin/node`,
    };
    const listed = listLinuxAgenCProcesses({
      listPids: () => ["1", "2", "300", "301"],
      readText: (path) => {
        const text = files[path];
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      readLink: (path) => {
        const target = links[path];
        if (target === undefined) throw new Error("EACCES");
        return target;
      },
    });
    expect(listed).toEqual([
      { pid: 1, ppid: 0, uid: 0, command: "/usr/lib/systemd/systemd /sbin/init" },
      { pid: 2, ppid: 0, uid: 0, command: "" },
      { pid: 300, ppid: 1, uid: 1000, command: `${tree}/node_modules/.agenc-node/bin/node agenc` },
    ]);
    expect(findOtherAgenCRuntimeClients({
      entries: listed!,
      selfPid: 400,
      uid: 1000,
      daemonPid: 299,
      homeRuntimeRoots: ["/home/me/.agenc/runtime/"],
      ownRuntimeTree: "/home/me/.agenc/runtime/9.9.9/linux-x64-tree",
    })).toEqual([300]);
    expect(findOtherAgenCRuntimeClients({
      entries: listed!,
      selfPid: 400,
      uid: 1000,
      daemonPid: 299,
      homeRuntimeRoots: ["/home/me/.agenc/runtime/"],
      ownRuntimeTree: tree,
    })).toEqual([]);
  });

  it("counts the updater once it is no longer this process's parent", () => {
    expect(findOtherAgenCRuntimeClients({
      entries: entries.filter((entry) => entry.pid !== 31),
      selfPid: 99,
      uid: 501,
      daemonPid: 10,
      homeRuntimeRoots: [`${home}/runtime/`],
      ownRuntimeTree: agenCRuntimeTreeOf(newTree),
    })).toEqual([21, 30]);
  });
});

describe("outcome line", () => {
  it("round-trips and formats each status in one line", () => {
    const outcome = { status: "deferred", reason: "1 client attached", fromVersion: "9.9.8", toVersion: "9.9.9", waitUntil: "x" } as const;
    expect(parseAgenCDaemonRestartOutcome(JSON.stringify(outcome))).toEqual(outcome);
    expect(parseAgenCDaemonRestartOutcome("ok daemon restart")).toBeNull();
    expect(parseAgenCDaemonRestartOutcome(JSON.stringify({ status: "exploded" }))).toBeNull();
    expect(formatAgenCDaemonRestartOutcome(outcome))
      .toBe("The daemon is busy (1 client attached), so it will restart on 9.9.9 once it is idle.");
    expect(formatAgenCDaemonRestartOutcome({ status: "restarted", toVersion: "9.9.9", pid: 42 }))
      .toBe("Restarted the daemon on 9.9.9 (pid 42).");
    expect(formatAgenCDaemonRestartOutcome({ status: "not-running", toVersion: "9.9.9" }))
      .toBe("No daemon is running. The next one starts on 9.9.9.");
    expect(formatAgenCDaemonRestartOutcome({ status: "skipped", code: "already-current", toVersion: "9.9.9" }))
      .toBe("The daemon already runs 9.9.9.");
  });
});

describe("daemon restart --when-idle arguments", () => {
  it("parses the public form and the waiter form", () => {
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle"]))
      .toEqual({ kind: "restart-when-idle", json: false });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--json"]))
      .toEqual({ kind: "restart-when-idle", json: true });
    const token = "0b8f5f3c-2b1a-4d6e-9f00-0123456789ab";
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--wait", token]))
      .toEqual({ kind: "restart-when-idle", json: false, waitToken: token });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--wait", "../x"]))
      .toEqual({ kind: "error", message: "daemon restart --wait needs a restart token" });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--now"]))
      .toEqual({ kind: "error", message: "unknown daemon restart option: --now" });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart"]))
      .toEqual({ kind: "command", action: "restart" });
  });
});

/** A daemon control socket that answers like an older daemon would. */
class FakeDaemonSocket {
  readonly requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
  readonly server: Server;
  constructor(
    readonly identity: AgenCDaemonInstanceIdentity,
    readonly answer: (method: string, params: Record<string, unknown>) => unknown,
    readonly protocolVersion = "1.34.0",
    readonly methods: Record<string, boolean> = {
      "routine.list": true, "remote.status": true, "session.goal": true, "session.processes.list": true,
    },
  ) {
    this.server = createServer((socket) => this.#serve(socket));
  }

  #serve(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          id: number; method: string; params: Record<string, unknown>;
        };
        buffer = buffer.slice(newline + 1);
        this.requests.push({ method: message.method, params: message.params });
        socket.write(`${JSON.stringify(this.#respond(message))}\n`);
        newline = buffer.indexOf("\n");
      }
    });
  }

  #respond(message: { id: number; method: string; params: Record<string, unknown> }): unknown {
    if (message.method === "initialize") {
      if (message.params.authCookie !== "cookie") {
        return { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "auth failed" } };
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          type: "initialized",
          protocolVersion: this.protocolVersion,
          protocol: { version: this.protocolVersion },
          capabilities: { "daemon.methods": this.methods },
          daemonIdentity: this.identity,
        },
      };
    }
    const result = this.answer(message.method, message.params);
    if (result instanceof Error) {
      const code = (result as Error & { code?: string }).code;
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: result.message, ...(code === undefined ? {} : { data: { code } }) },
      };
    }
    return { jsonrpc: "2.0", id: message.id, result };
  }

  listen(path: string): Promise<void> {
    return new Promise((resolve) => this.server.listen(path, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

interface FakeDaemonState {
  agents: unknown[];
  sessions: unknown[];
  ready: boolean;
  inFlightToolCalls: number;
  routines: unknown[];
  connectedDevices: number;
  snapshot: Record<string, unknown>;
  goal: Record<string, unknown>;
  processes: unknown[];
}

function idleDaemonState(): FakeDaemonState {
  return {
    agents: [
      { agentId: "live", status: "idle", lastActiveAt: new Date(NOW - 120_000).toISOString(), activeSessionIds: ["s-live"] },
      { agentId: "saved", status: "idle", lastActiveAt: "2026-01-01T00:00:00.000Z", activeSessionIds: ["s-saved"], metadata: { recovered: true } },
    ],
    sessions: [
      { sessionId: "s-live", agentId: "live", status: "idle", createdAt: "x" },
      { sessionId: "s-pending", agentId: "pending", status: "waiting", createdAt: "x", metadata: { recovered: true, recovery: { loaded: false } } },
    ],
    ready: true,
    inFlightToolCalls: 0,
    routines: [{ id: "r1", lastRun: { status: "completed" } }],
    connectedDevices: 0,
    snapshot: { sessionId: "s-live", turnCount: 3 },
    goal: { ok: true },
    processes: [{ taskId: "t", status: "completed" }],
  };
}

function answerFrom(state: FakeDaemonState) {
  return (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case "health.ready": return { ready: state.ready, uptimeMs: 1, now: "x" };
      case "agent.list": return { agents: state.agents };
      case "session.list": return { sessions: state.sessions };
      case "health.stats": return { uptimeMs: 1, now: "x", sessions: { active: 1, closed: 0, total: 1 }, memory: {}, state: { inFlightToolCalls: state.inFlightToolCalls } };
      case "routine.list": return { routines: state.routines };
      case "remote.status": return { connectedDevices: state.connectedDevices };
      case "session.snapshot": return params.sessionId === "s-live" ? state.snapshot : Object.assign(new Error("no live agent"), { code: "AGENT_NOT_FOUND" });
      case "session.goal": return state.goal;
      case "session.processes.list": return { processes: state.processes };
      default: return new Error(`unexpected ${method}`);
    }
  };
}

describe("probeAgenCDaemonIdle against a daemon socket", () => {
  let home: string;
  let daemon: FakeDaemonSocket | undefined;
  const identity = identityFor(4242);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rwi-"));
    writeFileSync(resolveAgenCDaemonCookiePath({ AGENC_HOME: home }, home), "cookie\n");
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  async function probe(
    state: FakeDaemonState,
    options: {
      readonly protocolVersion?: string;
      readonly identity?: AgenCDaemonInstanceIdentity;
      readonly processes?: AgenCProcessEntry[] | null;
    } = {},
  ): Promise<AgenCDaemonIdleVerdict> {
    daemon = new FakeDaemonSocket(options.identity ?? identity, answerFrom(state), options.protocolVersion);
    await daemon.listen(resolveAgenCDaemonSocketPath({ AGENC_HOME: home }, home));
    return probeAgenCDaemonIdle({ env: { AGENC_HOME: home }, userHome: home, pid: 7000 }, identity, {
      nowMs: () => NOW,
      listProcesses: () => (options.processes === undefined ? [] : options.processes),
      uid: 501,
    });
  }

  it("reports an idle daemon as idle without naming a session whose restore is pending", async () => {
    await expect(probe(idleDaemonState())).resolves.toEqual({ idle: true });
    const named = daemon!.requests.flatMap((request) =>
      typeof request.params.sessionId === "string" ? [request.params.sessionId] : []);
    expect(named).not.toContain("s-pending");
    expect(named).toContain("s-live");
    expect(daemon!.requests.map((request) => request.method)).toContain("health.stats");
  });

  it.each([
    ["a running turn", (s: FakeDaemonState) => { (s.agents[0] as Record<string, unknown>).status = "running"; }, "1 agent working"],
    ["an attached TUI", (s: FakeDaemonState) => { (s.sessions[0] as Record<string, unknown>).activeAttachmentIds = ["att"]; }, "1 client attached"],
    ["a daemon still starting", (s: FakeDaemonState) => { s.ready = false; }, "the daemon is starting or stopping"],
    ["a routine run", (s: FakeDaemonState) => { s.routines = [{ lastRun: { status: "running" } }]; }, "1 routine running"],
    ["a remote device", (s: FakeDaemonState) => { s.connectedDevices = 1; }, "1 remote device connected"],
    ["a tool call in flight", (s: FakeDaemonState) => { s.inFlightToolCalls = 2; }, "2 tool calls in flight"],
    ["a sub-agent", (s: FakeDaemonState) => { s.snapshot = { ...s.snapshot, nativeWorkers: [{ id: "w" }] }; }, "1 sub-agent running"],
    ["an active goal", (s: FakeDaemonState) => { s.goal = { ok: true, goal: { status: "active" } }; }, "a goal is active"],
    ["a background process", (s: FakeDaemonState) => { s.processes = [{ status: "running" }]; }, "1 background process running"],
  ])("finds %s", async (_label, mutate, reason) => {
    const state = idleDaemonState();
    mutate(state);
    await expect(probe(state)).resolves.toEqual({ idle: false, reason });
  });

  it("calls a daemon that answers for another instance busy", async () => {
    await expect(probe(idleDaemonState(), { identity: identityFor(4343) }))
      .resolves.toEqual({ idle: false, reason: "the daemon was replaced during the check" });
  });

  it("marks a daemon too old to check as permanently unprovable", async () => {
    await expect(probe(idleDaemonState(), { protocolVersion: "1.12.0" })).resolves.toEqual({
      idle: false,
      reason: "daemon protocol 1.12.0 is too old to check",
      permanent: true,
    });
  });

  it("calls an unreadable process list busy", async () => {
    await expect(probe(idleDaemonState(), { processes: null }))
      .resolves.toEqual({ idle: false, reason: "the process list could not be read" });
  });

  it("never restarts a daemon that is an ancestor of this process", async () => {
    await expect(probe(idleDaemonState(), {
      processes: [
        { pid: 7000, ppid: 6000, uid: 501, command: "agenc update" },
        { pid: 6000, ppid: identity.pid, uid: 501, command: "/bin/sh" },
        { pid: identity.pid, ppid: 1, uid: 501, command: "agenc daemon start --foreground" },
      ],
    })).resolves.toEqual({ idle: false, reason: "the update runs inside a daemon session" });
  });

  it("finds an older TUI of this home that is not attached, without showing its arguments", async () => {
    const tree = `${home}/runtime/9.9.8/tree/node_modules/@tetsuo-ai/runtime/bin/agenc`;
    await expect(probe(idleDaemonState(), {
      processes: [
        { pid: 7000, ppid: 1, uid: 501, command: "agenc daemon restart --when-idle" },
        { pid: 8100, ppid: 1, uid: 501, command: `/x/agenc-node ${tree} fix the secret build` },
        { pid: 8200, ppid: 1, uid: 501, command: `/x/agenc-node ${tree} -p hello` },
      ],
    })).resolves.toEqual({
      idle: false,
      reason: "an older AgenC process is still running (pid 8100, agenc and 1 more)",
    });
  });
});

describe("restartAgenCDaemonWhenIdle", () => {
  let home: string;
  const daemonCommand = (): string =>
    `/x/agenc-node ${home}/runtime/9.9.8/tree/node_modules/@tetsuo-ai/runtime/bin/agenc daemon start --foreground`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rwi-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function scenario(options: {
    readonly state?: AgenCDaemonRestartState;
    readonly verdicts?: AgenCDaemonIdleVerdict[];
    readonly stopExit?: number;
    readonly startExit?: number;
    readonly replacement?: AgenCDaemonInstanceIdentity;
  } = {}) {
    const calls: string[] = [];
    const verdicts = [...(options.verdicts ?? [{ idle: true }, { idle: true }])];
    const old = identityFor(4242);
    const deps: AgenCDaemonRestartWhenIdleDeps = {
      now: () => new Date(NOW),
      ownBuild: () => NEW_BUILD,
      readState: async () => options.state ?? { kind: "running", identity: old },
      probe: async () => {
        calls.push("probe");
        return verdicts.shift() ?? { idle: true };
      },
      daemonCommand,
      stopDaemon: async (_host, _io, _timeout, stopOptions) => {
        calls.push("stop");
        if (await stopOptions?.beforeShutdownRequest?.(old) !== undefined) {
          return AGENC_DAEMON_STOP_DECLINED_EXIT;
        }
        calls.push("shutdown");
        return options.stopExit ?? 0;
      },
      startDaemon: async () => {
        calls.push("start");
        return options.startExit ?? 0;
      },
      requestIdentity: async () => options.replacement ?? identityFor(5000, NEW_BUILD),
      spawnWaiter: (_host, token) => {
        calls.push(`waiter:${token}`);
        return 6000;
      },
    };
    return { calls, deps, old };
  }

  it("restarts an idle daemon through stop and start and confirms the new build", async () => {
    const { calls, deps } = scenario();
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, deps)).resolves.toEqual({
      status: "restarted",
      fromVersion: "9.9.8",
      toVersion: "9.9.9",
      pid: 5000,
    });
    // The idle check runs again under the lock, just before daemon.shutdown.
    expect(calls).toEqual(["probe", "stop", "probe", "shutdown", "start"]);
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
  });

  it("defers a busy daemon: one record, one waiter, nothing stopped", async () => {
    const { calls, deps, old } = scenario({ verdicts: [{ idle: false, reason: "1 client attached" }] });
    const outcome = await restartAgenCDaemonWhenIdle(testHost(home), {}, deps);
    expect(outcome).toMatchObject({ status: "deferred", reason: "1 client attached", toVersion: "9.9.9" });
    const record = readAgenCDaemonPendingRestart(home);
    expect(record).toMatchObject({
      daemon: { pid: old.pid, instanceId: old.instanceId },
      target: NEW_BUILD,
      notAfter: new Date(NOW + 12 * 60 * 60 * 1_000).toISOString(),
    });
    expect(calls).toEqual(["probe", `waiter:${record!.token}`]);
    expect(readFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "utf8"))
      .toContain("is busy (1 client attached)");
  });

  it("defers when work starts between the first check and daemon.shutdown", async () => {
    const { calls, deps } = scenario({
      verdicts: [{ idle: true }, { idle: false, reason: "1 agent working" }],
    });
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, deps))
      .resolves.toMatchObject({ status: "deferred", reason: "1 agent working" });
    expect(calls).not.toContain("shutdown");
    expect(calls).not.toContain("start");
  });

  it("does nothing when no daemon runs", async () => {
    const { calls, deps } = scenario({ state: { kind: "not-running" } });
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, deps))
      .resolves.toEqual({ status: "not-running", toVersion: "9.9.9" });
    expect(calls).toEqual([]);
  });

  it("leaves a daemon that already runs this build", async () => {
    const { calls, deps } = scenario({ state: { kind: "running", identity: identityFor(4242, NEW_BUILD) } });
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, deps))
      .resolves.toMatchObject({ status: "skipped", code: "already-current" });
    expect(calls).toEqual([]);
  });

  it("never restarts a daemon that runs from outside this install", async () => {
    const { calls, deps } = scenario();
    const outcome = await restartAgenCDaemonWhenIdle(testHost(home), {}, {
      ...deps,
      daemonCommand: () => "/Applications/AgenC.app/Contents/Resources/agenc-core/bin/agenc daemon start --foreground",
    });
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(outcome.reason).toContain("outside this install");
    expect(calls).toEqual([]);
  });

  it("reports a daemon too old to check without waiting for it", async () => {
    const { calls, deps } = scenario({
      verdicts: [{ idle: false, reason: "daemon protocol 1.2.0 is too old to check", permanent: true }],
    });
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, deps))
      .resolves.toMatchObject({ status: "skipped", code: "unsupported" });
    expect(calls).toEqual(["probe"]);
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
  });

  it.each([
    ["the stop fails", { stopExit: 1 }, "the daemon could not be stopped"],
    ["the start fails", { startExit: 1 }, "the daemon stopped but did not start again"],
    ["the daemon comes back on another build", { replacement: identityFor(5001, OLD_BUILD) }, "came back on 9.9.8 instead of 9.9.9"],
  ])("reports a failure when %s", async (_label, options, reason) => {
    const { deps } = scenario(options);
    const outcome = await restartAgenCDaemonWhenIdle(testHost(home), {}, deps);
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain(reason);
  });

  it("orders builds by version, then by build time, and admits when it cannot tell", () => {
    expect(compareAgenCRuntimeBuilds(OLD_BUILD, NEW_BUILD)).toBe(-1);
    expect(compareAgenCRuntimeBuilds(NEW_BUILD, OLD_BUILD)).toBe(1);
    expect(compareAgenCRuntimeBuilds(NEW_BUILD, { ...NEW_BUILD })).toBe(0);
    const rebuilt = { ...NEW_BUILD, commit: "newer", buildTime: "2026-10-30T00:00:00.000Z" };
    expect(compareAgenCRuntimeBuilds(NEW_BUILD, rebuilt)).toBe(-1);
    expect(compareAgenCRuntimeBuilds({ ...NEW_BUILD, runtimeVersion: "dev" }, NEW_BUILD)).toBeUndefined();
    expect(compareAgenCRuntimeBuilds({ ...NEW_BUILD, buildTime: "" }, { ...NEW_BUILD, commit: "x" })).toBeUndefined();
  });

  it.each([
    ["a newer version", identityFor(4242, { runtimeVersion: "10.0.0", commit: "n", buildTime: "2026-10-29T00:00:00.000Z" })],
    ["a later rebuild of the same version", identityFor(4242, { ...NEW_BUILD, commit: "n", buildTime: "2026-10-30T00:00:00.000Z" })],
    ["a build it cannot order", identityFor(4242, { runtimeVersion: "dev", commit: "n", buildTime: "x" })],
  ])("only-older mode leaves %s alone", async (_label, daemon) => {
    const { calls, deps } = scenario({ state: { kind: "running", identity: daemon } });
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, { ...deps, onlyOlderDaemon: true }))
      .resolves.toMatchObject({ status: "skipped", code: "newer-daemon", pid: 4242 });
    expect(calls).toEqual([]);
  });

  it("only-older mode restarts an older daemon as usual", async () => {
    const { calls, deps } = scenario();
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, { ...deps, onlyOlderDaemon: true }))
      .resolves.toMatchObject({ status: "restarted", fromVersion: "9.9.8", toVersion: "9.9.9" });
    expect(calls).toEqual(["probe", "stop", "probe", "shutdown", "start"]);
  });

  it("is not available off macOS and Linux", async () => {
    const { calls, deps } = scenario();
    await expect(restartAgenCDaemonWhenIdle(testHost(home, { platform: "win32" }), {}, deps))
      .resolves.toMatchObject({ status: "skipped", code: "unsupported" });
    expect(calls).toEqual([]);
  });

  it("prints one JSON line for agenc update", async () => {
    const { deps } = scenario({ state: { kind: "not-running" } });
    const io = quietIo();
    await expect(runAgenCDaemonRestartWhenIdleCli(
      { kind: "restart-when-idle", json: true }, testHost(home), io, {}, deps,
    )).resolves.toBe(0);
    expect(io.out().trim().split("\n")).toHaveLength(1);
    expect(parseAgenCDaemonRestartOutcome(io.out().trim())).toEqual({ status: "not-running", toVersion: "9.9.9" });
  });
});

describe("the deferred restart waiter", () => {
  let home: string;
  let clock: number;
  const token = "0b8f5f3c-2b1a-4d6e-9f00-0123456789ab";
  const old = identityFor(4242);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rwi-"));
    clock = NOW;
    writeAgenCDaemonPendingRestart(home, {
      schemaVersion: 1,
      token,
      createdAt: new Date(NOW).toISOString(),
      notAfter: new Date(NOW + 60_000).toISOString(),
      daemon: { pid: old.pid, instanceId: old.instanceId },
      target: NEW_BUILD,
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function waiterDeps(options: {
    readonly states?: AgenCDaemonRestartState[];
    readonly verdicts?: AgenCDaemonIdleVerdict[];
    readonly onProbe?: () => void;
  }) {
    const calls: string[] = [];
    const states = [...(options.states ?? [])];
    const verdicts = [...(options.verdicts ?? [])];
    const deps: AgenCDaemonRestartWhenIdleDeps = {
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      pollMs: 15_000,
      ownBuild: () => NEW_BUILD,
      readState: async () => states.shift() ?? { kind: "running", identity: old },
      probe: async () => {
        calls.push("probe");
        options.onProbe?.();
        return verdicts.shift() ?? { idle: true };
      },
      daemonCommand: () => `${home}/runtime/9.9.8/tree/node_modules/@tetsuo-ai/runtime/bin/agenc daemon start --foreground`,
      stopDaemon: async (_host, _io, _timeout, stopOptions) => {
        calls.push("stop");
        if (await stopOptions?.beforeShutdownRequest?.(old) !== undefined) {
          return AGENC_DAEMON_STOP_DECLINED_EXIT;
        }
        calls.push("shutdown");
        return 0;
      },
      startDaemon: async () => {
        calls.push("start");
        return 0;
      },
      requestIdentity: async () => identityFor(5000, NEW_BUILD),
    };
    return { calls, deps };
  }

  it("restarts only after two idle checks in a row, then removes its record", async () => {
    const { calls, deps } = waiterDeps({
      verdicts: [
        { idle: false, reason: "1 agent working" },
        { idle: true },
        { idle: false, reason: "1 agent working" },
        { idle: true },
        { idle: true },
        { idle: true },
      ],
    });
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, deps))
      .resolves.toMatchObject({ status: "restarted", pid: 5000 });
    expect(calls).toEqual(["probe", "probe", "probe", "probe", "probe", "stop", "probe", "shutdown", "start"]);
    expect(clock - NOW).toBe(4 * 15_000);
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
    expect(readFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "utf8"))
      .toContain("restarted: Restarted the daemon on 9.9.9 (pid 5000).");
  });

  it("stands down when a newer update replaced its record", async () => {
    const newer = "11111111-2222-4333-8444-555555555555";
    const { calls, deps } = waiterDeps({ verdicts: [{ idle: false, reason: "busy" }] });
    const replace = (): void => {
      writeAgenCDaemonPendingRestart(home, { ...readAgenCDaemonPendingRestart(home)!, token: newer });
    };
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      probe: async (...args) => {
        replace();
        return deps.probe!(...args);
      },
    })).resolves.toMatchObject({ status: "skipped", reason: "a newer update replaced this restart" });
    expect(calls).toEqual(["probe"]);
    // The newer restart keeps its record.
    expect(readAgenCDaemonPendingRestart(home)?.token).toBe(newer);
  });

  it("stands down when the update is superseded between the last check and daemon.shutdown", async () => {
    const newer = "11111111-2222-4333-8444-555555555555";
    let probes = 0;
    const { calls, deps } = waiterDeps({
      onProbe: () => {
        probes += 1;
        // The second idle check passes; a newer update lands right after it.
        if (probes === 2) {
          writeAgenCDaemonPendingRestart(home, { ...readAgenCDaemonPendingRestart(home)!, token: newer });
        }
      },
    });
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, deps))
      .resolves.toMatchObject({ status: "skipped", reason: "a newer update replaced this restart" });
    expect(calls).toEqual(["probe", "probe", "stop"]);
    expect(readAgenCDaemonPendingRestart(home)?.token).toBe(newer);
  });

  it("stands down when the daemon was already restarted or replaced", async () => {
    const { calls, deps } = waiterDeps({ states: [{ kind: "running", identity: identityFor(4999) }] });
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, deps))
      .resolves.toMatchObject({ status: "skipped", reason: "the daemon was restarted by something else" });
    expect(calls).toEqual([]);
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
  });

  it("stands down when the daemon already runs the new build", async () => {
    const { deps } = waiterDeps({ states: [{ kind: "running", identity: identityFor(4999, NEW_BUILD) }] });
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, deps))
      .resolves.toMatchObject({ status: "skipped", code: "already-current" });
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
  });

  it("ends when the daemon stopped: the next start uses the new runtime", async () => {
    const { calls, deps } = waiterDeps({ states: [{ kind: "not-running" }] });
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, deps))
      .resolves.toEqual({ status: "not-running", toVersion: "9.9.9" });
    expect(calls).toEqual([]);
  });

  it("gives up at its deadline without stopping anything", async () => {
    const { calls, deps } = waiterDeps({
      verdicts: Array.from({ length: 10 }, () => ({ idle: false as const, reason: "1 client attached" })),
    });
    const outcome = await runAgenCDaemonRestartWaiter(testHost(home), token, {}, deps);
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("waiting time ran out");
    expect(calls.filter((call) => call !== "probe")).toEqual([]);
    expect(calls.length).toBe(5);
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
  });
});

describe("stop with a last check before daemon.shutdown", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rwi-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("proves the instance, asks the check, and sends nothing when it declines", async () => {
    const identity = identityFor(4500);
    writeDaemonRuntimeInfo(resolveAgenCDaemonRuntimeInfoPath(home), {
      ...identity,
      startedAt: "2026-10-29T00:00:00.000Z",
    });
    const seen: string[] = [];
    const io = quietIo();
    const exit = await stopAgenCDaemon(testHost(home), io, 1_000, {
      requestDaemonInstanceIdentity: () => identity,
      requestDaemonShutdown: () => {
        seen.push("shutdown");
      },
      beforeShutdownRequest: async (proven) => {
        seen.push(`check:${proven.instanceId}`);
        return "1 agent working";
      },
    });
    expect(exit).toBe(AGENC_DAEMON_STOP_DECLINED_EXIT);
    expect(seen).toEqual(["check:instance-4500"]);
  });

  it("declines a daemon without an instance identity instead of signalling it", async () => {
    writeFileSync(join(home, "daemon.pid"), "4501\n");
    const exit = await stopAgenCDaemon(testHost(home, { platform: "linux" }), quietIo(), 1_000, {
      beforeShutdownRequest: async () => undefined,
    });
    expect(exit).toBe(AGENC_DAEMON_STOP_DECLINED_EXIT);
  });
});
