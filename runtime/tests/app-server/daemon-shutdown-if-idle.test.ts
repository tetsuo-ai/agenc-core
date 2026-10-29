import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import {
  countedAttachments,
  daemonBusyReason,
  runningNativeWorkerCount,
  type DaemonIdleSources,
} from "../../src/app-server/daemon-idle-check.js";
import type { DaemonShutdownIfIdleParams, JsonObject } from "../../src/app-server/protocol/index.js";

const daemonIdentity = {
  pid: 4242,
  instanceId: "instance-4242",
  processStart: "test-process:4242:start",
  runtimeVersion: "0.19.25",
  commit: "abc123",
  buildTime: "2026-10-29T00:00:00.000Z",
} as const;

function request(id: string, method: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: "2.0", id, method, params };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup(options: {
  readonly busyReason: (params: DaemonShutdownIfIdleParams) => Promise<string | undefined>;
  readonly busyReasonNow?: () => string | undefined;
  readonly fuzzyFileSearch?: { search: (params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> };
}) {
  const shutdown = vi.fn((instanceId: string) => ({ shuttingDown: true as const, instanceId }));
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: new AgenCDaemonAgentManager(),
    daemonIdentity,
    initializeAuthenticator: ({ authCookie }) => authCookie === "cookie",
    ...(options.fuzzyFileSearch === undefined ? {} : { fuzzyFileSearch: options.fuzzyFileSearch as never }),
    daemonControl: {
      reloadConfig: () => ({ reloaded: true, configReloadedAt: "x", mcpServer: { status: "disabled" } }),
      shutdown,
      busyReason: options.busyReason,
      ...(options.busyReasonNow === undefined ? {} : { busyReasonNow: options.busyReasonNow }),
    },
  });
  const connect = async () => {
    const connection = dispatcher.createConnection();
    await connection.dispatch(request("init", "initialize", { protocol: { version: "1.2.0" }, authCookie: "cookie" }));
    return connection;
  };
  return { dispatcher, shutdown, connect };
}

describe("daemon.shutdownIfIdle", () => {
  it("holds a request that arrives during the check and refuses it once the daemon stops", async () => {
    let decide!: (reason: string | undefined) => void;
    const { shutdown, connect } = setup({
      busyReason: () => new Promise((resolve) => { decide = resolve; }),
    });
    const control = await connect();
    const client = await connect();
    const stopping = control.dispatch(request("stop", "daemon.shutdownIfIdle", { instanceId: daemonIdentity.instanceId }));
    await tick();
    // A prompt (any request) sent while the daemon checks never starts.
    let arrived = false;
    const late = client.dispatch(request("late", "health.ping")).then((response) => {
      arrived = true;
      return response;
    });
    await tick();
    expect(arrived).toBe(false);
    decide(undefined);
    await expect(stopping).resolves.toMatchObject({ result: { shuttingDown: true, instanceId: daemonIdentity.instanceId } });
    await expect(late).resolves.toMatchObject({ error: { message: "AgenC daemon is shutting down" } });
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("lets held requests through when work keeps the daemon up", async () => {
    let decide!: (reason: string | undefined) => void;
    const { shutdown, connect } = setup({
      busyReason: () => new Promise((resolve) => { decide = resolve; }),
    });
    const control = await connect();
    const client = await connect();
    const stopping = control.dispatch(request("stop", "daemon.shutdownIfIdle", { instanceId: daemonIdentity.instanceId }));
    await tick();
    const late = client.dispatch(request("late", "health.ping"));
    decide("1 agent working");
    await expect(stopping).resolves.toMatchObject({
      result: { shuttingDown: false, instanceId: daemonIdentity.instanceId, reason: "1 agent working" },
    });
    await expect(late).resolves.toMatchObject({ result: expect.anything() });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("counts a request already in flight as work", async () => {
    let release!: () => void;
    let started!: () => void;
    const searching = new Promise<void>((resolve) => { started = resolve; });
    const busyReason = vi.fn(async () => undefined);
    const { shutdown, connect } = setup({
      busyReason,
      fuzzyFileSearch: {
        search: async () => {
          started();
          await new Promise<void>((resolve) => { release = resolve; });
          return { files: [] };
        },
      },
    });
    const control = await connect();
    const client = await connect();
    const search = client.dispatch(request("search", "fs.fuzzy_search", { query: "x", roots: ["."] }));
    await searching;
    await expect(control.dispatch(request("stop", "daemon.shutdownIfIdle", { instanceId: daemonIdentity.instanceId })))
      .resolves.toMatchObject({ result: { shuttingDown: false, reason: "a client request is in progress" } });
    expect(shutdown).not.toHaveBeenCalled();
    release();
    await search;
  });

  it("reads routine runs and remote devices once more right before stopping", async () => {
    const { shutdown, connect } = setup({
      busyReason: async () => undefined,
      busyReasonNow: () => "1 routine run active",
    });
    const control = await connect();
    await expect(control.dispatch(request("stop", "daemon.shutdownIfIdle", { instanceId: daemonIdentity.instanceId })))
      .resolves.toMatchObject({ result: { shuttingDown: false, reason: "1 routine run active" } });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("checks the instance and needs the requester's conversation to exempt anything", async () => {
    const { connect } = setup({ busyReason: async () => undefined });
    const control = await connect();
    await expect(control.dispatch(request("stop", "daemon.shutdownIfIdle", { instanceId: "other" })))
      .resolves.toMatchObject({ error: { data: { code: "DAEMON_INSTANCE_IDENTITY_MISMATCH" } } });
    await expect(control.dispatch(request("stop", "daemon.shutdownIfIdle", {
      instanceId: daemonIdentity.instanceId, exemptAttachmentIds: ["a1"],
    }))).resolves.toMatchObject({ error: { code: -32602 } });
  });
});

describe("the daemon's own idle rules", () => {
  function sources(overrides: Partial<DaemonIdleSources> = {}): DaemonIdleSources {
    return {
      listSessions: async () => ({ sessions: [{ sessionId: "s1", agentId: "conv-1", activeAttachmentIds: [] }] }),
      listAgents: async () => ({ agents: [{ agentId: "conv-1", status: "idle" }] }),
      inFlightToolCalls: async () => 0,
      activeRoutineRuns: () => 0,
      connectedRemoteDevices: () => 0,
      sessionDetail: async () => ({ nativeWorkers: [], processes: [] }),
      ...overrides,
    };
  }

  it("is idle when nothing runs, and never reads a session whose restore is pending", async () => {
    const detail = vi.fn(async () => ({ nativeWorkers: [], processes: [] }));
    await expect(daemonBusyReason(sources({
      listSessions: async () => ({
        sessions: [
          { sessionId: "s1", agentId: "conv-1", activeAttachmentIds: [] },
          { sessionId: "s2", agentId: "conv-2", metadata: { recovery: { loaded: false } } },
        ],
        nextCursor: "agenc-session-list-v1:disk",
      }),
      sessionDetail: detail,
    }))).resolves.toBeUndefined();
    expect(detail.mock.calls.map((call) => call[0])).toEqual(["s1"]);
  });

  it("exempts only the requester's own attachment ids on its own conversation", () => {
    const sessions = [
      { sessionId: "s1", agentId: "conv-1", activeAttachmentIds: ["tui", "sdk"] },
      { sessionId: "s2", agentId: "conv-2", activeAttachmentIds: ["tui"] },
    ];
    expect(countedAttachments(sessions)).toBe(3);
    // The SDK client following the same conversation still counts, and an id
    // claimed on another conversation is not exempt.
    expect(countedAttachments(sessions, { attachmentIds: ["tui"], agentId: "conv-1" })).toBe(2);
    expect(countedAttachments([sessions[0]!], { attachmentIds: ["tui"], agentId: "conv-1" })).toBe(1);
  });

  it("counts only working sub-agents in a real snapshot", () => {
    const worker = (status: string | undefined) => ({
      agentId: `w-${status}`, agentPath: "root/w", nickname: "w", role: "default", toolUseCount: 1, tokenCount: 10,
      ...(status === undefined ? {} : { status }),
    });
    expect(runningNativeWorkerCount([worker("idle"), worker("completed"), worker("errored"), worker("shutdown"), worker("interrupted")])).toBe(0);
    expect(runningNativeWorkerCount([worker("running"), worker("pending_init"), worker(undefined)])).toBe(3);
  });

  it.each([
    ["an attachment", { listSessions: async () => ({ sessions: [{ sessionId: "s1", agentId: "conv-1", activeAttachmentIds: ["a"] }] }) }, "1 client attached"],
    ["a running agent", { listAgents: async () => ({ agents: [{ agentId: "conv-1", status: "running" }] }) }, "1 agent working"],
    ["a tool call", { inFlightToolCalls: async () => 2 }, "2 tool calls in flight"],
    ["a routine run", { activeRoutineRuns: () => 1 }, "1 routine run active"],
    ["a remote device", { connectedRemoteDevices: () => 1 }, "1 remote device connected"],
    ["a running sub-agent", { sessionDetail: async () => ({ nativeWorkers: [{ status: "running" }], processes: [] }) }, "1 sub-agent running"],
    ["an active goal", { sessionDetail: async () => ({ nativeWorkers: [], goalStatus: "active", processes: [] }) }, "a goal is active"],
    ["a background process", { sessionDetail: async () => ({ nativeWorkers: [], processes: [{ status: "running" }] }) }, "1 background process running"],
  ] as const)("finds %s", async (_label, override, reason) => {
    await expect(daemonBusyReason(sources(override as Partial<DaemonIdleSources>))).resolves.toBe(reason);
  });

  it("skips a session without a live runtime and calls any other failure busy", async () => {
    await expect(daemonBusyReason(sources({
      sessionDetail: async () => { throw new Error("AgenC daemon agent not running: conv-1"); },
    }))).resolves.toBeUndefined();
    await expect(daemonBusyReason(sources({
      sessionDetail: async () => { throw Object.assign(new Error("gone"), { code: "AGENT_NOT_FOUND" }); },
    }))).resolves.toBeUndefined();
    await expect(daemonBusyReason(sources({
      sessionDetail: async () => { throw new Error("database locked"); },
    }))).resolves.toBe("session s1 could not be checked");
  });
});
