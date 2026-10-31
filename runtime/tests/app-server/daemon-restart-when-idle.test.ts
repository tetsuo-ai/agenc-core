import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENC_DAEMON_STOP_DECLINED_EXIT,
  acquireAgenCDaemonLifecycleLock,
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
  cancelAgenCDaemonPendingRestartAbove,
  compareAgenCRuntimeBuilds,
  agenCCommandLabel,
  agenCRuntimeTreeOf,
  findOtherAgenCRuntimeClients,
  homebrewAgenCRuntimeRoots,
  requesterExemption,
  updateAgenCDaemonRestartRequesterAttachments,
  listLinuxAgenCProcesses,
  parseAgenCProcessList,
  probeAgenCDaemonIdle,
  readAgenCDaemonPendingRestart,
  requestAgenCDaemonShutdownWhenIdle,
  restartAgenCDaemonWhenIdle,
  runAgenCDaemonRestartWaiter,
  runAgenCDaemonRestartWhenIdleCli,
  writeAgenCDaemonPendingRestart,
  type AgenCDaemonIdleVerdict,
  type AgenCDaemonRestartRequester,
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
import { LocalSqliteLockTimeoutError } from "../../../packages/agenc/lib/sqlite-lock.mjs";

/** What the lock helper throws when another holder kept a lock the whole wait. */
function busyLockTimeout(home: string, label: string, filename: string, timeoutMs: number): Error {
  return new LocalSqliteLockTimeoutError({ path: join(home, filename), label, timeoutMs });
}

/** What it throws on macOS when its `/bin/df` probe of the lock directory takes over 2 s. */
function filesystemProbeTimeout(home: string, label: string): Error {
  return new LocalSqliteLockTimeoutError({
    path: home,
    label: `${label} (macOS lock filesystem probe via /bin/df)`,
    timeoutMs: 2_000,
  });
}

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

  it("parses the requester a TUI passes when it updates itself", () => {
    expect(parseAgenCDaemonCliArgs([
      "daemon", "restart", "--when-idle", "--json", "--requester-pid", "4321", "--requester-agent", "conv-abc123",
    ])).toEqual({ kind: "restart-when-idle", json: true, requesterPid: 4321, requesterAgentId: "conv-abc123" });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--requester-pid", "1"]))
      .toEqual({ kind: "error", message: "daemon restart --requester-pid needs a process id" });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--requester-pid", "12x"]))
      .toEqual({ kind: "error", message: "daemon restart --requester-pid needs a process id" });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--requester-pid", "9", "--requester-agent", "../x"]))
      .toEqual({ kind: "error", message: "daemon restart --requester-agent needs a conversation id" });
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--requester-agent", "conv-abc123"]))
      .toEqual({ kind: "error", message: "daemon restart --requester-agent needs --requester-pid" });
  });

  it("parses the downgrade intent a pinned update passes", () => {
    expect(parseAgenCDaemonCliArgs(["daemon", "restart", "--when-idle", "--json", "--downgrade"]))
      .toEqual({ kind: "restart-when-idle", json: true, downgrade: true });
  });
});

describe("the requester's own conversation", () => {
  it("exempts only the requester's own attachment ids, never its whole conversation", () => {
    const mine = { attachmentIds: ["tui"], agentId: "conv-mine" };
    const sessions = [
      { sessionId: "s1", agentId: "conv-mine", status: "waiting", activeAttachmentIds: ["tui"], restorePending: false },
    ];
    expect(busyReasonFromSessions(sessions)).toEqual({ idle: false, reason: "1 client attached" });
    expect(busyReasonFromSessions(sessions, mine)).toEqual({ idle: true });
    // An SDK client following the same conversation still counts.
    expect(busyReasonFromSessions(
      [{ ...sessions[0]!, activeAttachmentIds: ["tui", "sdk"] }],
      mine,
    )).toEqual({ idle: false, reason: "1 client attached" });
    // The ids count as the requester's only on its own conversation.
    expect(busyReasonFromSessions(
      [...sessions, { sessionId: "s2", agentId: "conv-other", status: "waiting", activeAttachmentIds: ["tui"], restorePending: false }],
      mine,
    )).toEqual({ idle: false, reason: "1 client attached" });
    expect(requesterExemption({ pid: 4321, agentId: "conv-mine" })).toBeUndefined();
    expect(requesterExemption({ pid: 4321, agentId: "conv-mine", attachmentIds: ["tui"] })).toEqual(mine);
    const now = NOW;
    const recent = new Date(now - 2_000).toISOString();
    expect(busyReasonFromAgents([{ agentId: "conv-mine", status: "idle", lastActiveAt: recent }], now, 15_000).idle)
      .toBe(false);
    expect(busyReasonFromAgents([{ agentId: "conv-mine", status: "idle", lastActiveAt: recent }], now, 15_000, "conv-mine"))
      .toEqual({ idle: true });
    // Work still counts, in the requester's conversation too.
    expect(busyReasonFromAgents([{ agentId: "conv-mine", status: "running" }], now, 15_000, "conv-mine"))
      .toEqual({ idle: false, reason: "1 agent working" });
    expect(busyReasonFromAgents(
      [{ agentId: "conv-mine", status: "idle" }, { agentId: "conv-other", status: "idle", lastActiveAt: recent }],
      now, 15_000, "conv-mine",
    ).idle).toBe(false);
  });

  it("does not count the requester's process as an older client", () => {
    const home = "/h/.agenc";
    const old = `/h/.agenc/bin/agenc-node ${home}/runtime/9.9.8/tree/node_modules/@tetsuo-ai/runtime/bin/agenc`;
    const entries: AgenCProcessEntry[] = [
      { pid: 10, ppid: 1, uid: 501, command: old },
      { pid: 11, ppid: 1, uid: 501, command: old },
    ];
    const scan = { entries, selfPid: 99, uid: 501, daemonPid: 50, homeRuntimeRoots: [`${home}/runtime/`] };
    expect(findOtherAgenCRuntimeClients(scan)).toEqual([10, 11]);
    expect(findOtherAgenCRuntimeClients({ ...scan, requesterPid: 10 })).toEqual([11]);
  });

  it("treats a Homebrew keg as this install", () => {
    expect(homebrewAgenCRuntimeRoots("/opt/homebrew/Cellar/agenc/0.19.26/libexec/node_modules/@tetsuo-ai/runtime"))
      .toEqual(["/opt/homebrew/Cellar/agenc/", "/opt/homebrew/opt/agenc/"]);
    expect(homebrewAgenCRuntimeRoots("/h/.agenc/runtime/0.19.26/tree/node_modules/@tetsuo-ai/runtime")).toEqual([]);
    expect(homebrewAgenCRuntimeRoots(null)).toEqual([]);
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
      "daemon.shutdownIfIdle": true,
    },
    /** Drop the connection instead of answering this method. */
    readonly dropOn?: string,
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
        if (message.method === this.dropOn) {
          socket.destroy();
          return;
        }
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

  it("counts an SDK client that follows the requester's conversation", async () => {
    const state = idleDaemonState();
    (state.sessions[0] as Record<string, unknown>).activeAttachmentIds = ["tui", "sdk"];
    daemon = new FakeDaemonSocket(identity, answerFrom(state));
    await daemon.listen(resolveAgenCDaemonSocketPath({ AGENC_HOME: home }, home));
    await expect(probeAgenCDaemonIdle({ env: { AGENC_HOME: home }, userHome: home, pid: 7000 }, identity, {
      nowMs: () => NOW,
      listProcesses: () => [],
      uid: 501,
      requester: { pid: 4321, agentId: "live", attachmentIds: ["tui"] },
    })).resolves.toEqual({ idle: false, reason: "1 client attached" });
  });

  it("counts only sub-agents that are working, from real snapshot shapes", async () => {
    // snapshotNativeWorkers keeps a reusable worker after its assignment,
    // parked as idle, and a finished one until its handle closes.
    const worker = (agentId: string, status: string, extra: Record<string, unknown> = {}) => ({
      agentId, agentPath: `root/${agentId}`, nickname: agentId, role: "default",
      status, toolUseCount: 3, tokenCount: 1200, ...extra,
    });
    const state = idleDaemonState();
    state.snapshot = {
      ...state.snapshot,
      nativeWorkers: [
        worker("parked", "idle", { timing: { startedAt: "2026-10-29T11:00:00.000Z" } }),
        worker("done", "completed", { terminal: { kind: "completed" } }),
        worker("stopped", "shutdown"),
        worker("failed", "errored", { error: "boom" }),
      ],
    };
    await expect(probe(state)).resolves.toEqual({ idle: true });
    await daemon!.close();
    daemon = undefined;
    state.snapshot = {
      ...state.snapshot,
      nativeWorkers: [worker("parked", "idle"), worker("busy", "running"), worker("starting", "pending_init")],
    };
    await expect(probe(state)).resolves.toEqual({ idle: false, reason: "2 sub-agents running" });
  });

  it("marks a daemon that cannot decide as permanently too old, even when idle", async () => {
    daemon = new FakeDaemonSocket(identity, answerFrom(idleDaemonState()), "1.34.0", {
      "routine.list": true, "remote.status": true, "session.goal": true, "session.processes.list": true,
    });
    await daemon.listen(resolveAgenCDaemonSocketPath({ AGENC_HOME: home }, home));
    await expect(probeAgenCDaemonIdle({ env: { AGENC_HOME: home }, userHome: home, pid: 7000 }, identity, {
      nowMs: () => NOW,
      listProcesses: () => [],
      uid: 501,
    })).resolves.toEqual({
      idle: false,
      reason: "the daemon runs AgenC 9.9.8, which cannot stop only when idle (that starts with 0.19.25)",
      permanent: true,
      tooOld: true,
    });
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
      tooOld: true,
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

describe("the last step before daemon.shutdown", () => {
  let home: string;
  let daemon: FakeDaemonSocket | undefined;
  const identity = identityFor(4242);
  const host = () => ({ env: { AGENC_HOME: home }, userHome: home });
  const CAN_DECIDE = { "daemon.shutdownIfIdle": true };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rwi-final-"));
    writeFileSync(resolveAgenCDaemonCookiePath({ AGENC_HOME: home }, home), "cookie\n");
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  async function serve(
    answer: (method: string, params: Record<string, unknown>) => unknown,
    methods: Record<string, boolean>,
    dropOn?: string,
  ) {
    daemon = new FakeDaemonSocket(identity, answer, "1.34.0", methods, dropOn);
    await daemon.listen(resolveAgenCDaemonSocketPath({ AGENC_HOME: home }, home));
    return daemon;
  }

  it("lets a daemon that can decide do it: one request, and a busy answer stops nothing", async () => {
    const fake = await serve((method) => method === "daemon.shutdownIfIdle"
      ? { shuttingDown: false, instanceId: identity.instanceId, reason: "1 agent working" }
      : new Error(`unexpected ${method}`), CAN_DECIDE);
    await expect(requestAgenCDaemonShutdownWhenIdle(host(), identity)).resolves.toEqual({ declined: "1 agent working" });
    expect(fake.requests.map((request) => request.method)).toEqual(["initialize", "daemon.shutdownIfIdle"]);
    expect(fake.requests[1]!.params).toEqual({ instanceId: identity.instanceId });
  });

  it("passes the requester's attachment ids to the daemon that decides, never anything else", async () => {
    const fake = await serve((method) => method === "daemon.shutdownIfIdle"
      ? { shuttingDown: true, instanceId: identity.instanceId }
      : new Error(`unexpected ${method}`), CAN_DECIDE);
    await requestAgenCDaemonShutdownWhenIdle(host(), identity, { attachmentIds: ["tui"], agentId: "conv-mine" });
    expect(fake.requests[1]!.params).toEqual({
      instanceId: identity.instanceId, exemptAttachmentIds: ["tui"], requesterAgentId: "conv-mine",
    });
    await fake.close();
    daemon = undefined;
    // An older daemon is not stopped at all, exemption or not.
    const older = await serve(answerFrom(idleDaemonState()), {});
    await expect(requestAgenCDaemonShutdownWhenIdle(host(), identity, { attachmentIds: ["tui"], agentId: "conv-mine" }))
      .resolves.toMatchObject({ permanent: true, tooOld: true });
    expect(older.requests.map((request) => request.method)).toEqual(["initialize"]);
  });

  it("returns nothing when the daemon decided to stop", async () => {
    await serve((method) => method === "daemon.shutdownIfIdle"
      ? { shuttingDown: true, instanceId: identity.instanceId }
      : new Error(`unexpected ${method}`), CAN_DECIDE);
    await expect(requestAgenCDaemonShutdownWhenIdle(host(), identity)).resolves.toBeUndefined();
  });

  it("never stops a daemon that cannot decide, idle or not: no fallback", async () => {
    // An outside check always leaves a gap before daemon.shutdown in which a
    // client can start work, so an older daemon is only ever told about.
    const state = idleDaemonState();
    const fake = await serve((method, params) => method === "daemon.shutdown"
      ? { shuttingDown: true, instanceId: identity.instanceId }
      : answerFrom(state)(method, params), {});
    await expect(requestAgenCDaemonShutdownWhenIdle(host(), identity)).resolves.toEqual({
      declined: "the daemon runs AgenC 9.9.8, which cannot stop only when idle (that starts with 0.19.25)",
      permanent: true,
      tooOld: true,
    });
    expect(fake.requests.map((request) => request.method)).toEqual(["initialize"]);
  });

  it("treats a dropped connection as a refusal to retry, not as a failed shutdown", async () => {
    await serve(() => ({}), CAN_DECIDE, "daemon.shutdownIfIdle");
    const result = await requestAgenCDaemonShutdownWhenIdle(host(), identity);
    expect(result).toMatchObject({ declined: expect.stringContaining("did not answer the restart check") });
    expect(result).not.toHaveProperty("permanent");
  });

  it("never signals a busy daemon whose connection drops during the decision", async () => {
    // The restart's stop path, on Linux where a failed shutdown can escalate
    // to SIGTERM: the conditional request loses its connection while the
    // daemon is busy, and nothing may be signalled.
    writeDaemonRuntimeInfo(resolveAgenCDaemonRuntimeInfoPath(home), { ...identity, startedAt: "2026-10-29T00:00:00.000Z" });
    writeFileSync(join(home, "daemon.pid"), `${identity.pid}\n`);
    const fake = await serve(() => ({}), CAN_DECIDE, "daemon.shutdownIfIdle");
    const signals: Array<{ pid: number; signal: string }> = [];
    const exit = await stopAgenCDaemon(
      testHost(home, {
        platform: "linux",
        terminatePid: (pid, signal) => { signals.push({ pid, signal: String(signal) }); },
      }),
      quietIo(),
      1_000,
      {
        requestDaemonInstanceIdentity: () => identity,
        requestDaemonShutdown: (stopHost, proven) => requestAgenCDaemonShutdownWhenIdle(stopHost, proven),
        signalOnlyAfterAcceptedShutdown: true,
      },
    );
    expect(exit).toBe(AGENC_DAEMON_STOP_DECLINED_EXIT);
    expect(signals).toEqual([]);
    expect(fake.requests.map((request) => request.method)).toEqual(["initialize", "daemon.shutdownIfIdle"]);
  });

  it("never signals after a failed shutdown request when only an accepted one may escalate", async () => {
    writeDaemonRuntimeInfo(resolveAgenCDaemonRuntimeInfoPath(home), { ...identity, startedAt: "2026-10-29T00:00:00.000Z" });
    writeFileSync(join(home, "daemon.pid"), `${identity.pid}\n`);
    const signals: string[] = [];
    const exit = await stopAgenCDaemon(
      testHost(home, { platform: "linux", terminatePid: (_pid, signal) => { signals.push(String(signal)); } }),
      quietIo(),
      1_000,
      {
        requestDaemonInstanceIdentity: () => identity,
        requestDaemonShutdown: () => { throw new Error("socket hang up"); },
        signalOnlyAfterAcceptedShutdown: true,
      },
    );
    expect(exit).toBe(AGENC_DAEMON_STOP_DECLINED_EXIT);
    expect(signals).toEqual([]);
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
      // The daemon's own decision at the end, from the same queue.
      requestShutdownWhenIdle: async () => {
        calls.push("probe");
        const verdict = verdicts.shift() ?? { idle: true };
        return verdict.idle ? undefined : { declined: verdict.reason, ...(verdict.permanent ? { permanent: true } : {}) };
      },
      withLifecycleLock: async (_host, operation) => operation(),
      daemonCommand,
      stopDaemon: async (_host, _io, _timeout, stopOptions) => {
        calls.push("stop");
        if (await stopOptions?.beforeShutdownRequest?.(old) !== undefined) {
          return AGENC_DAEMON_STOP_DECLINED_EXIT;
        }
        const decided = await stopOptions?.requestDaemonShutdown?.(_host, old);
        if (decided !== undefined && decided !== null && "declined" in decided) {
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

  it("skips a daemon too old to decide, with the code that brings the restart hint", async () => {
    const { calls, deps } = scenario({
      verdicts: [{ idle: false, reason: "the daemon runs AgenC 9.9.8, which cannot stop only when idle (that starts with 0.19.25)", permanent: true, tooOld: true }],
    });
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, deps)).resolves.toEqual({
      status: "skipped",
      code: "daemon-too-old",
      reason: "the daemon runs AgenC 9.9.8, which cannot stop only when idle (that starts with 0.19.25)",
      fromVersion: "9.9.8",
      toVersion: "9.9.9",
    });
    expect(calls).toEqual(["probe"]);
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
  });

  it("writes the pending record only while holding the lifecycle lock", async () => {
    const { deps } = scenario({ verdicts: [{ idle: false, reason: "1 client attached" }] });
    let releaseLock!: () => void;
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    let lockedWrites = 0;
    const pending = restartAgenCDaemonWhenIdle(testHost(home), {}, {
      ...deps,
      // Another process (a waiter deciding its shutdown) holds the lock.
      withLifecycleLock: async (_host, operation) => {
        await held;
        lockedWrites += 1;
        return operation();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
    releaseLock();
    await expect(pending).resolves.toMatchObject({ status: "deferred" });
    expect(lockedWrites).toBe(1);
    expect(readAgenCDaemonPendingRestart(home)).not.toBeNull();
  });

  describe("a pending restart onto a newer build", () => {
    const NEWER_BUILD = { runtimeVersion: "9.9.10", commit: "newer", buildTime: "2026-10-30T00:00:00.000Z" };
    const newerToken = "1b8f5f3c-2b1a-4d6e-9f00-0123456789ab";
    const publishNewer = (daemon: AgenCDaemonInstanceIdentity): void => {
      writeAgenCDaemonPendingRestart(home, {
        schemaVersion: 1,
        token: newerToken,
        createdAt: new Date(NOW).toISOString(),
        notAfter: new Date(NOW + 3_600_000).toISOString(),
        daemon: { pid: daemon.pid, instanceId: daemon.instanceId },
        target: NEWER_BUILD,
      });
    };

    it("stays when an older update finds the daemon busy after it was published", async () => {
      const { calls, deps, old } = scenario({ verdicts: [{ idle: false, reason: "1 client attached" }] });
      const outcome = await restartAgenCDaemonWhenIdle(testHost(home), {}, {
        ...deps,
        // The newer update publishes while this older one is still in its first check.
        probe: async (...args) => {
          publishNewer(old);
          return deps.probe!(...args);
        },
      });
      expect(outcome).toEqual({
        status: "deferred",
        reason: "1 client attached",
        fromVersion: "9.9.8",
        toVersion: "9.9.10",
        waitUntil: new Date(NOW + 3_600_000).toISOString(),
      });
      expect(readAgenCDaemonPendingRestart(home)).toMatchObject({ token: newerToken, target: NEWER_BUILD });
      expect(calls.filter((call) => call.startsWith("waiter:"))).toEqual([]);
    });

    it("takes on the requesting TUI of the older update, so its own attachments do not hold it up", async () => {
      const { deps, old } = scenario({ verdicts: [{ idle: false, reason: "1 client attached" }] });
      publishNewer(old);
      const requester = { pid: 4321, agentId: "conv-mine" };
      await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, { ...deps, requester }))
        .resolves.toMatchObject({ status: "deferred", toVersion: "9.9.10" });
      expect(readAgenCDaemonPendingRestart(home)).toMatchObject({ token: newerToken, target: NEWER_BUILD, requester });
    });

    it("ends for a pinned downgrade, which restarts now or waits with its own record", async () => {
      const idle = scenario();
      publishNewer(idle.old);
      await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, { ...idle.deps, downgrade: true }))
        .resolves.toMatchObject({ status: "restarted", toVersion: "9.9.9" });
      // Its waiting process leaves at its next check instead of moving the daemon back up.
      expect(readAgenCDaemonPendingRestart(home)).toBeNull();

      const busy = scenario({ verdicts: [{ idle: false, reason: "1 client attached" }] });
      publishNewer(busy.old);
      await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, { ...busy.deps, downgrade: true }))
        .resolves.toMatchObject({ status: "deferred", toVersion: "9.9.9" });
      expect(readAgenCDaemonPendingRestart(home)?.target).toEqual(NEW_BUILD);
    });

    /** A lifecycle lock with a short wait, for a lock another process holds. */
    const impatientLock = async <T>(
      host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const release = await acquireAgenCDaemonLifecycleLock(host, undefined, 50);
      try {
        return await operation();
      } finally {
        await release();
      }
    };

    it("for a pinned downgrade that cannot end it because the lock stays busy, says so and leaves the daemon alone", async () => {
      const { calls, deps, old } = scenario();
      publishNewer(old);
      const host = testHost(home);
      // Another process holds the daemon lifecycle lock.
      const release = await acquireAgenCDaemonLifecycleLock(host);
      const io = quietIo();
      let exit: number;
      try {
        exit = await runAgenCDaemonRestartWhenIdleCli(
          { kind: "restart-when-idle", json: true, downgrade: true },
          host,
          io,
          {},
          { ...deps, withLifecycleLock: impatientLock },
        );
      } finally {
        await release();
      }
      expect(exit).toBe(1);
      const outcome = parseAgenCDaemonRestartOutcome(io.out().trim());
      expect(outcome).toMatchObject({ status: "failed", toVersion: "9.9.9" });
      expect(outcome?.reason).toBe(
        "a restart onto 9.9.10 is still pending and could not be cancelled (the daemon lifecycle lock stayed busy for 50 ms). " +
          `The daemon was left as it is, and that restart can still move it to 9.9.10. To cancel it, delete ${join(home, "daemon-restart-pending.json")}`,
      );
      // Nothing was checked, stopped or started, and the newer restart is still there.
      expect(calls).toEqual([]);
      expect(readAgenCDaemonPendingRestart(home)).toMatchObject({ token: newerToken, target: NEWER_BUILD });
    });

    it.skipIf(process.getuid?.() === 0)(
      "for a pinned downgrade that cannot remove its record, says so, leaves the daemon alone and never logs it as cancelled",
      async () => {
        const { calls, deps, old } = scenario();
        // Warm up: a first restart that finds no daemon creates the lock files a
        // later restart needs; then the home itself cannot be written.
        await restartAgenCDaemonWhenIdle(testHost(home), {}, { ...deps, readState: async () => ({ kind: "not-running" }) });
        publishNewer(old);
        writeFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "");
        chmodSync(home, 0o500);
        let outcome;
        try {
          outcome = await restartAgenCDaemonWhenIdle(testHost(home), {}, { ...deps, downgrade: true });
        } finally {
          chmodSync(home, 0o700);
        }
        expect(outcome).toMatchObject({ status: "failed", toVersion: "9.9.9" });
        expect(outcome.reason).toContain("a restart onto 9.9.10 is still pending and could not be cancelled (the record could not be removed: ");
        expect(outcome.reason).toContain("The daemon was left as it is, and that restart can still move it to 9.9.10");
        expect(calls).toEqual([]);
        expect(readAgenCDaemonPendingRestart(home)).toMatchObject({ token: newerToken, target: NEWER_BUILD });
        const log = readFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "utf8");
        expect(log).not.toContain("cancelled:");
        expect(log).toContain("cancel failed: the restart onto 9.9.10, for a downgrade to 9.9.9, is still pending");
      },
    );

    it.skipIf(process.getuid?.() === 0)(
      "the updater's own cancel reports a record it cannot remove and keeps it, instead of claiming it cancelled",
      async () => {
        const host = { env: { AGENC_HOME: home }, userHome: home };
        publishNewer(identityFor(4242));
        // The lock database and the log exist; the home itself cannot be written.
        const release = await acquireAgenCDaemonLifecycleLock(host);
        await release();
        writeFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "");
        chmodSync(home, 0o500);
        let failure: unknown;
        try {
          failure = await cancelAgenCDaemonPendingRestartAbove(host, "9.9.8").then(
            () => undefined,
            (error: unknown) => error,
          );
        } finally {
          chmodSync(home, 0o700);
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(
          "a restart onto 9.9.10 is still pending and could not be cancelled (the record could not be removed: ",
        );
        expect((failure as Error).message).toContain(`To cancel it, delete ${join(home, "daemon-restart-pending.json")}`);
        expect(readAgenCDaemonPendingRestart(home)).toMatchObject({ token: newerToken, target: NEWER_BUILD });
        const log = readFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "utf8");
        expect(log).not.toContain("cancelled:");
        expect(log).toContain("cancel failed: the restart onto 9.9.10, for a downgrade to 9.9.8, is still pending");
      },
    );

    it("for a pinned downgrade whose lifecycle lock fails for another reason than contention, keeps that reason", async () => {
      const { calls, deps, old } = scenario();
      publishNewer(old);
      const outcome = await restartAgenCDaemonWhenIdle(testHost(home), {}, {
        ...deps,
        downgrade: true,
        withLifecycleLock: async () => {
          throw filesystemProbeTimeout(home, "AgenC daemon lifecycle");
        },
      });
      expect(outcome.status).toBe("failed");
      expect(outcome.reason ?? "").toContain(
        "could not be cancelled (the daemon lifecycle lock could not be taken: agenc: AgenC daemon lifecycle " +
          "(macOS lock filesystem probe via /bin/df) timed out after 2000ms",
      );
      expect(outcome.reason ?? "").not.toContain("stayed busy");
      expect(calls).toEqual([]);
      expect(readAgenCDaemonPendingRestart(home)).toMatchObject({ token: newerToken, target: NEWER_BUILD });
    });

    it("the updater's own cancel reports a busy lock only when a newer restart is pending", async () => {
      const host = { env: { AGENC_HOME: home }, userHome: home };
      // Another process holds the daemon lifecycle lock.
      const release = await acquireAgenCDaemonLifecycleLock(host);
      try {
        // Nothing to end: a busy lock does not hold the downgrade up.
        await expect(cancelAgenCDaemonPendingRestartAbove(host, "9.9.8", undefined, { withLifecycleLock: impatientLock }))
          .resolves.toBeUndefined();
        publishNewer(identityFor(4242));
        await expect(cancelAgenCDaemonPendingRestartAbove(host, "9.9.8", undefined, { withLifecycleLock: impatientLock }))
          .rejects.toThrow(
            "a restart onto 9.9.10 is still pending and could not be cancelled (the daemon lifecycle lock stayed busy for 50 ms)",
          );
      } finally {
        await release();
      }
      expect(readAgenCDaemonPendingRestart(home)).toMatchObject({ token: newerToken, target: NEWER_BUILD });
      // Once the lock is free it ends it.
      await expect(cancelAgenCDaemonPendingRestartAbove(host, "9.9.8")).resolves.toBe("9.9.10");
      expect(readAgenCDaemonPendingRestart(home)).toBeNull();
    }, 15_000);
  });

  it("says once that it waits for another restart, then leaves the daemon alone when that one holds the lock too long", async () => {
    const { calls, deps } = scenario();
    const waits: number[] = [];
    const progress: string[] = [];
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, {
      ...deps,
      onProgress: (line) => progress.push(line),
      acquireRestartLock: async (_host, timeoutMs) => {
        waits.push(timeoutMs);
        throw busyLockTimeout(home, "AgenC daemon restart", "daemon-restart.lock.sqlite", timeoutMs);
      },
    })).resolves.toEqual({
      status: "failed",
      reason: "another daemon restart was still running after 15 minutes, so the daemon was left as it is",
      toVersion: "9.9.9",
    });
    // A short try, the waiting line, then the queue wait.
    expect(waits).toEqual([1_000, 15 * 60 * 1_000]);
    expect(progress).toEqual(["Waiting for another daemon restart to finish (up to 15 minutes)."]);
    expect(calls).toEqual([]);
  });

  it("keeps the real reason when the restart lock fails for anything but another restart", async () => {
    const { calls, deps } = scenario();
    const progress: string[] = [];
    const outcome = await restartAgenCDaemonWhenIdle(testHost(home), {}, {
      ...deps,
      onProgress: (line) => progress.push(line),
      acquireRestartLock: async () => {
        throw filesystemProbeTimeout(home, "AgenC daemon restart");
      },
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "the daemon restart lock could not be taken: agenc: AgenC daemon restart (macOS lock filesystem probe via /bin/df) " +
        `timed out after 2000ms waiting for local process lock ${home}`,
      toVersion: "9.9.9",
    });
    expect(progress).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("writes its waiting line to stderr for agenc update, and still one JSON line to stdout", async () => {
    const { deps } = scenario({ state: { kind: "not-running" } });
    let tries = 0;
    let stdout = "";
    let stderr = "";
    const io = {
      stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk); return true; } },
    } as unknown as AgenCDaemonCliIo;
    await expect(runAgenCDaemonRestartWhenIdleCli({ kind: "restart-when-idle", json: true }, testHost(home), io, {}, {
      ...deps,
      acquireRestartLock: async (_host, timeoutMs) => {
        tries += 1;
        if (tries === 1) throw busyLockTimeout(home, "AgenC daemon restart", "daemon-restart.lock.sqlite", timeoutMs);
        return async () => {};
      },
    })).resolves.toBe(0);
    expect(stderr).toBe("agenc: Waiting for another daemon restart to finish (up to 15 minutes).\n");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(parseAgenCDaemonRestartOutcome(stdout.trim())).toEqual({ status: "not-running", toVersion: "9.9.9" });
  });

  it("never moves a newer daemon down, unless it is a pinned downgrade", async () => {
    // An older update that runs after a newer one finished its restart.
    const newer = identityFor(4242, { runtimeVersion: "10.0.0", commit: "n", buildTime: "2026-10-30T00:00:00.000Z" });
    const { calls, deps } = scenario({ state: { kind: "running", identity: newer } });
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, deps)).resolves.toEqual({
      status: "skipped",
      code: "newer-daemon",
      reason: "the daemon runs 10.0.0, which is not older than 9.9.9",
      fromVersion: "10.0.0",
      toVersion: "9.9.9",
      pid: 4242,
    });
    expect(calls).toEqual([]);
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, { ...deps, downgrade: true }))
      .resolves.toMatchObject({ status: "restarted", fromVersion: "10.0.0", toVersion: "9.9.9" });
    expect(calls).toEqual(["probe", "stop", "probe", "shutdown", "start"]);
  });

  it("passes a live requester to every check and keeps it in the pending record", async () => {
    const seen: Array<AgenCDaemonRestartRequester | undefined> = [];
    const { deps } = scenario({ verdicts: [{ idle: false, reason: "1 client attached" }] });
    const requester = { pid: 4321, agentId: "conv-mine" };
    const outcome = await restartAgenCDaemonWhenIdle(testHost(home), {}, {
      ...deps,
      requester,
      probe: async (_host, _expected, live) => {
        seen.push(live);
        return { idle: false, reason: "1 client attached" };
      },
    });
    expect(outcome.status).toBe("deferred");
    expect(seen).toEqual([requester]);
    expect(readAgenCDaemonPendingRestart(home)?.requester).toEqual(requester);
    // A requester that has exited counts for nothing.
    seen.length = 0;
    await restartAgenCDaemonWhenIdle(testHost(home, { isPidRunning: (pid) => pid !== 4321 }), {}, {
      ...deps,
      requester,
      probe: async (_host, _expected, live) => {
        seen.push(live);
        return { idle: false, reason: "1 client attached" };
      },
    });
    expect(seen).toEqual([undefined]);
  });

  it("owns a daemon that runs from this Homebrew keg", async () => {
    const { calls, deps } = scenario();
    const keg = "/opt/homebrew/Cellar/agenc/9.9.8/libexec/node_modules/@tetsuo-ai/runtime/bin/agenc daemon start --foreground";
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, {
      ...deps,
      daemonCommand: () => `/opt/homebrew/Cellar/agenc/9.9.8/libexec/node ${keg}`,
      installRuntimeRoots: () => ["/opt/homebrew/Cellar/agenc/", "/opt/homebrew/opt/agenc/"],
    })).resolves.toMatchObject({ status: "restarted" });
    expect(calls).toEqual(["probe", "stop", "probe", "shutdown", "start"]);
    await expect(restartAgenCDaemonWhenIdle(testHost(home), {}, {
      ...deps,
      daemonCommand: () => `/opt/homebrew/Cellar/agenc/9.9.8/libexec/node ${keg}`,
      installRuntimeRoots: () => [],
    })).resolves.toMatchObject({ status: "skipped" });
  });

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
      requestShutdownWhenIdle: async () => {
        calls.push("probe");
        options.onProbe?.();
        const verdict = verdicts.shift() ?? { idle: true };
        return verdict.idle ? undefined : { declined: verdict.reason, ...(verdict.permanent ? { permanent: true } : {}) };
      },
      withLifecycleLock: async (_host, operation) => operation(),
      acquireLifecycleLock: async () => async () => {},
      daemonCommand: () => `${home}/runtime/9.9.8/tree/node_modules/@tetsuo-ai/runtime/bin/agenc daemon start --foreground`,
      stopDaemon: async (_host, _io, _timeout, stopOptions) => {
        calls.push("stop");
        if (await stopOptions?.beforeShutdownRequest?.(old) !== undefined) {
          return AGENC_DAEMON_STOP_DECLINED_EXIT;
        }
        const decided = await stopOptions?.requestDaemonShutdown?.(_host, old);
        if (decided !== undefined && decided !== null && "declined" in decided) {
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

  it("hands the daemon exactly the requester's attachment ids, from its record", async () => {
    const requester = { pid: 4321, agentId: "conv-mine", attachmentIds: ["tui"] };
    const record = readAgenCDaemonPendingRestart(home)!;
    writeAgenCDaemonPendingRestart(home, { ...record, requester });
    const exempted: unknown[] = [];
    const { deps } = waiterDeps({});
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      requestShutdownWhenIdle: async (_host, _expected, exempt) => {
        exempted.push(exempt);
      },
    })).resolves.toMatchObject({ status: "restarted" });
    expect(exempted).toEqual([{ attachmentIds: ["tui"], agentId: "conv-mine" }]);
  });

  it("lets the requesting TUI update its attachment ids in its own record only", async () => {
    const record = readAgenCDaemonPendingRestart(home)!;
    writeAgenCDaemonPendingRestart(home, { ...record, requester: { pid: 4321, agentId: "conv-mine" } });
    const host = { env: { AGENC_HOME: home }, userHome: home };
    await expect(updateAgenCDaemonRestartRequesterAttachments(host, 9999, ["x"])).resolves.toBe(false);
    await expect(updateAgenCDaemonRestartRequesterAttachments(host, 4321, ["tui"])).resolves.toBe(true);
    expect(readAgenCDaemonPendingRestart(home)?.requester).toEqual({ pid: 4321, agentId: "conv-mine", attachmentIds: ["tui"] });
    expect(readAgenCDaemonPendingRestart(home)?.token).toBe(token);
    await expect(updateAgenCDaemonRestartRequesterAttachments(host, 4321, ["tui"])).resolves.toBe(false);
  });

  it("keeps excluding the TUI that asked, from its record, while that TUI runs", async () => {
    const requester = { pid: 4321, agentId: "conv-mine" };
    const record = readAgenCDaemonPendingRestart(home)!;
    writeAgenCDaemonPendingRestart(home, { ...record, requester });
    const seen: Array<AgenCDaemonRestartRequester | undefined> = [];
    let requesterRunning = true;
    const { deps } = waiterDeps({});
    await expect(runAgenCDaemonRestartWaiter(
      testHost(home, { isPidRunning: (pid) => pid !== 4321 || requesterRunning }),
      token,
      {},
      {
        ...deps,
        probe: async (_host, _expected, live) => {
          seen.push(live);
          // The TUI quits after the first check.
          requesterRunning = false;
          return { idle: true };
        },
      },
    )).resolves.toMatchObject({ status: "restarted" });
    expect(seen[0]).toEqual(requester);
    expect(seen.slice(1).every((live) => live === undefined)).toBe(true);
  });

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

  it("removes its record only while holding the lifecycle lock", async () => {
    let releaseLock!: () => void;
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    const { deps } = waiterDeps({ states: [{ kind: "running", identity: identityFor(4999, NEW_BUILD) }] });
    const finished = runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      // Another process (a newer update publishing its record) holds the lock.
      withLifecycleLock: async (_host, operation) => {
        await held;
        return operation();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAgenCDaemonPendingRestart(home)?.token).toBe(token);
    // Under that lock the newer update replaced the record; the old waiter,
    // checking its token under the same lock, must leave the new one.
    const record = readAgenCDaemonPendingRestart(home)!;
    writeAgenCDaemonPendingRestart(home, { ...record, token: "1b8f5f3c-2b1a-4d6e-9f00-0123456789ab" });
    releaseLock();
    await expect(finished).resolves.toMatchObject({ status: "skipped", code: "already-current" });
    expect(readAgenCDaemonPendingRestart(home)?.token).toBe("1b8f5f3c-2b1a-4d6e-9f00-0123456789ab");
  });

  it("stands down when something else restarted the daemon on a build at least as new", async () => {
    const newer = { runtimeVersion: "10.0.0", commit: "n", buildTime: "2026-10-30T00:00:00.000Z" };
    const { calls, deps } = waiterDeps({ states: [{ kind: "running", identity: identityFor(4999, newer) }] });
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, deps))
      .resolves.toMatchObject({ status: "skipped", reason: "the daemon was restarted by something else" });
    expect(calls).toEqual([]);
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
  });

  it("keeps going when an earlier waiter restarted the daemon on a build still older than its target", async () => {
    // An earlier waiter finished its restart onto its own, older target just
    // before this record was written: this restart must not be abandoned.
    const replacement = identityFor(4999);
    const { calls, deps } = waiterDeps({});
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      readState: async () => ({ kind: "running", identity: replacement }),
      stopDaemon: async (_host, _io, _timeout, stopOptions) => {
        calls.push("stop");
        if (await stopOptions?.beforeShutdownRequest?.(replacement) !== undefined) return AGENC_DAEMON_STOP_DECLINED_EXIT;
        await stopOptions?.requestDaemonShutdown?.(_host, replacement);
        calls.push("shutdown");
        return 0;
      },
    })).resolves.toMatchObject({ status: "restarted", pid: 5000 });
    expect(calls).toContain("shutdown");
    expect(readFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "utf8"))
      .toContain("replaced the one this restart waited for; waiting for it instead");
  });

  it("does not start its runtime when a newer update replaced the record while the daemon stopped", async () => {
    const { calls, deps } = waiterDeps({});
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      requestShutdownWhenIdle: async () => {
        calls.push("decided");
        // The newer update took the lifecycle lock right after this decision.
        const record = readAgenCDaemonPendingRestart(home)!;
        writeAgenCDaemonPendingRestart(home, { ...record, token: "1b8f5f3c-2b1a-4d6e-9f00-0123456789ab" });
      },
    })).resolves.toMatchObject({ status: "skipped" });
    expect(calls).toContain("shutdown");
    expect(calls).not.toContain("start");
  });

  it("does not start its runtime when a newer update publishes its record while the start waits for the lifecycle lock", async () => {
    const newer = "1b8f5f3c-2b1a-4d6e-9f00-0123456789ab";
    // The newer update holds the lifecycle lock first and publishes its record.
    const newerUpdateTakesTheLockFirst = (): void => {
      const record = readAgenCDaemonPendingRestart(home)!;
      writeAgenCDaemonPendingRestart(home, { ...record, token: newer });
    };
    const { calls, deps } = waiterDeps({});
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      acquireLifecycleLock: async () => {
        newerUpdateTakesTheLockFirst();
        return async () => {};
      },
      // A start that takes the lock itself meets the newer update there instead.
      startDaemon: async (_host, _io, startOptions) => {
        if (startOptions?.lifecycleLockHeld !== true) newerUpdateTakesTheLockFirst();
        calls.push("start");
        return 0;
      },
    })).resolves.toMatchObject({
      status: "skipped",
      reason: "a newer update replaced this restart; the daemon stopped and its next start uses the newest runtime",
    });
    expect(calls).toContain("shutdown");
    expect(calls).not.toContain("start");
    expect(readAgenCDaemonPendingRestart(home)?.token).toBe(newer);
  });

  it("holds the lifecycle lock from its last check through the spawn, and releases it before the readiness waits", async () => {
    const events: string[] = [];
    let held = false;
    const { deps } = waiterDeps({});
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      acquireLifecycleLock: async () => {
        events.push("lock");
        held = true;
        return async () => {
          events.push("unlock");
          held = false;
        };
      },
      // The real start skips its own acquisition, spawns, then hands the lock back.
      startDaemon: async (_host, _io, startOptions) => {
        events.push(`spawn under the lock: ${held && startOptions?.lifecycleLockHeld === true}`);
        await startOptions?.releaseLifecycleLockAfterStartMutation?.();
        events.push(`readiness under the lock: ${held}`);
        return 0;
      },
    })).resolves.toMatchObject({ status: "restarted" });
    expect(events).toEqual(["lock", "spawn under the lock: true", "unlock", "readiness under the lock: false"]);
  });

  it("releases the lifecycle lock once when the start fails before handing it back", async () => {
    let releases = 0;
    const { deps } = waiterDeps({});
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      acquireLifecycleLock: async () => async () => {
        releases += 1;
      },
      startDaemon: async () => {
        throw new Error("spawn failed");
      },
    })).rejects.toThrow("spawn failed");
    expect(releases).toBe(1);
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

  it("logs once a restart lock it cannot take for another reason than a running restart, and checks again later", async () => {
    let tries = 0;
    const { deps } = waiterDeps({});
    await expect(runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...deps,
      acquireRestartLock: async () => {
        tries += 1;
        if (tries <= 2) throw filesystemProbeTimeout(home, "AgenC daemon restart");
        return async () => {};
      },
    })).resolves.toMatchObject({ status: "restarted" });
    const log = readFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "utf8");
    expect(log).toContain(
      "the daemon restart lock could not be taken (agenc: AgenC daemon restart (macOS lock filesystem probe via /bin/df) timed out after 2000ms",
    );
    expect(log.match(/the daemon restart lock could not be taken/g)).toHaveLength(1);
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

describe("two restarts at the same time", () => {
  const FIRST_BUILD = { runtimeVersion: "9.9.7", commit: "first", buildTime: "2026-09-01T00:00:00.000Z" };
  const token = "2b8f5f3c-2b1a-4d6e-9f00-0123456789ab";
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rwi-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** A gate a restart waits at once it stopped the daemon, before it starts its own. */
  function betweenStopAndSpawn() {
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    return { gate, entered, open: () => open(), reached: () => reached() };
  }

  /**
   * One daemon home shared by every restart in a test: stop and start act on
   * the same daemon, and a start finds a daemon that already runs, as the real
   * start does under the lifecycle lock.
   */
  function daemonHome(first: AgenCDaemonInstanceIdentity) {
    let running: AgenCDaemonInstanceIdentity | null = first;
    let nextPid = 5000;
    const spawned: string[] = [];
    const depsFor = (
      build: typeof NEW_BUILD,
      gap?: ReturnType<typeof betweenStopAndSpawn>,
    ): AgenCDaemonRestartWhenIdleDeps => ({
      now: () => new Date(NOW),
      ownBuild: () => build,
      readState: async () => (running === null ? { kind: "not-running" } : { kind: "running", identity: running }),
      probe: async () => ({ idle: true }),
      requestShutdownWhenIdle: async () => undefined,
      withLifecycleLock: async (_host, operation) => operation(),
      acquireLifecycleLock: async () => async () => {},
      daemonCommand: () => `/x/agenc-node ${home}/runtime/${running?.runtimeVersion ?? "none"}/tree/node_modules/@tetsuo-ai/runtime/bin/agenc daemon start --foreground`,
      stopDaemon: async (host, _io, _timeout, stopOptions) => {
        const current = running;
        // Like stopAgenCDaemon: a daemon that is already gone is "stopped",
        // with no last check.
        if (current === null) return 0;
        if (await stopOptions?.beforeShutdownRequest?.(current) !== undefined) return AGENC_DAEMON_STOP_DECLINED_EXIT;
        const decided = await stopOptions?.requestDaemonShutdown?.(host, current);
        if (decided !== undefined && decided !== null && "declined" in decided) return AGENC_DAEMON_STOP_DECLINED_EXIT;
        running = null;
        if (gap !== undefined) {
          gap.reached();
          await gap.gate;
        }
        return 0;
      },
      startDaemon: async () => {
        if (running !== null) return 0;
        running = identityFor(nextPid++, build);
        spawned.push(build.runtimeVersion);
        return 0;
      },
      requestIdentity: async () => {
        if (running === null) throw new Error("no daemon answers");
        return running;
      },
      spawnWaiter: () => 6000,
    });
    return { depsFor, daemon: () => running, spawned };
  }

  const settled = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
    let done = false;
    void promise.then(() => { done = true; }, () => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, ms));
    return done;
  };

  it("a newer update that looks while an older restart is between stop and spawn waits, then moves the daemon to the newer build", async () => {
    const world = daemonHome(identityFor(4242, FIRST_BUILD));
    const gap = betweenStopAndSpawn();
    const older = restartAgenCDaemonWhenIdle(testHost(home), {}, world.depsFor(OLD_BUILD, gap));
    await gap.entered;
    const newer = restartAgenCDaemonWhenIdle(testHost(home), {}, world.depsFor(NEW_BUILD));
    // It decides nothing while the daemon is between stop and spawn: before,
    // it reported "not running" here and the older build was started after it.
    expect(await settled(newer, 50)).toBe(false);
    gap.open();
    await expect(older).resolves.toMatchObject({ status: "restarted", fromVersion: "9.9.7", toVersion: "9.9.8" });
    await expect(newer).resolves.toMatchObject({ status: "restarted", fromVersion: "9.9.8", toVersion: "9.9.9" });
    expect(world.daemon()?.runtimeVersion).toBe("9.9.9");
    expect(world.spawned).toEqual(["9.9.8", "9.9.9"]);
  });

  it("an older update that looks while a newer restart is between stop and spawn leaves the newer daemon alone", async () => {
    const world = daemonHome(identityFor(4242, FIRST_BUILD));
    const gap = betweenStopAndSpawn();
    const newer = restartAgenCDaemonWhenIdle(testHost(home), {}, world.depsFor(NEW_BUILD, gap));
    await gap.entered;
    const older = restartAgenCDaemonWhenIdle(testHost(home), {}, world.depsFor(OLD_BUILD));
    expect(await settled(older, 50)).toBe(false);
    gap.open();
    await expect(newer).resolves.toMatchObject({ status: "restarted", toVersion: "9.9.9" });
    await expect(older).resolves.toMatchObject({
      status: "skipped",
      code: "newer-daemon",
      fromVersion: "9.9.9",
      toVersion: "9.9.8",
    });
    expect(world.daemon()?.runtimeVersion).toBe("9.9.9");
    expect(world.spawned).toEqual(["9.9.9"]);
  });

  it("a waiting process that looks while another restart is between stop and spawn keeps its restart and finishes it", async () => {
    const world = daemonHome(identityFor(4242, FIRST_BUILD));
    // A restart onto 9.9.9 already waits for the first daemon.
    writeAgenCDaemonPendingRestart(home, {
      schemaVersion: 1,
      token,
      createdAt: new Date(NOW).toISOString(),
      notAfter: new Date(NOW + 3_600_000).toISOString(),
      daemon: { pid: 4242, instanceId: "instance-4242" },
      target: NEW_BUILD,
    });
    const gap = betweenStopAndSpawn();
    const older = restartAgenCDaemonWhenIdle(testHost(home), {}, world.depsFor(OLD_BUILD, gap));
    await gap.entered;
    let clock = NOW;
    let firstSleep!: () => void;
    const slept = new Promise<void>((resolve) => { firstSleep = resolve; });
    const waiter = runAgenCDaemonRestartWaiter(testHost(home), token, {}, {
      ...world.depsFor(NEW_BUILD),
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
        firstSleep();
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      pollMs: 15_000,
    });
    // Its first check falls into the gap.
    await Promise.race([slept, waiter]);
    gap.open();
    await expect(older).resolves.toMatchObject({ status: "restarted", toVersion: "9.9.8" });
    await expect(waiter).resolves.toMatchObject({ status: "restarted", fromVersion: "9.9.8", toVersion: "9.9.9" });
    expect(world.daemon()?.runtimeVersion).toBe("9.9.9");
    expect(world.spawned).toEqual(["9.9.8", "9.9.9"]);
    expect(readAgenCDaemonPendingRestart(home)).toBeNull();
    expect(readFileSync(join(home, AGENC_DAEMON_RESTART_LOG_FILENAME), "utf8"))
      .toContain("replaced the one this restart waited for; waiting for it instead");
  }, 15_000);
});
