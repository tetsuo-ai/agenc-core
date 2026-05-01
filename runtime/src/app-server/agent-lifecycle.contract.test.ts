import { describe, expect, it, vi } from "vitest";
import {
  AgenCDaemonAgentLifecycleError,
  AgenCDaemonAgentManager,
} from "./agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import type {
  AgenCBackgroundAgentSnapshot,
  AgenCBackgroundAgentRunner,
  AgenCBackgroundAgentStartParams,
} from "./background-agent-runner.js";

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}

function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AgenC background agent lifecycle", () => {
  it("agent.create launches a running background agent and seeds its session", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence([
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
    });
    const starts: AgenCBackgroundAgentStartParams[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async (params) => {
        starts.push(params);
        return {
          agentId: "agent_1",
          agentPath: "/root/agent_1",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      runner,
      sessionManager: sessions,
    });

    await expect(
      agents.createAgent({
        objective: "  build the parser  ",
        metadata: { ticket: "F-06a" },
      }),
    ).resolves.toEqual({
      agentId: "agent_1",
      agentPath: "/root/agent_1",
      objective: "build the parser",
      status: "running",
      createdAt: "2026-05-01T12:00:00.000Z",
      startedAt: "2026-05-01T12:00:00.500Z",
      lastActiveAt: "2026-05-01T12:00:00.500Z",
      cwd: "/workspace",
      activeSessionIds: ["session_1"],
      metadata: {
        ticket: "F-06a",
        unattendedAllow: [
          "FileRead",
          "system.grep",
          "system.glob",
          "system.listDir",
          "system.stat",
        ],
        unattendedDeny: [],
      },
      sessionId: "session_1",
    });
    expect(starts).toEqual([
      {
        objective: "build the parser",
        cwd: "/workspace",
        metadata: {
          ticket: "F-06a",
          unattendedAllow: [
            "FileRead",
            "system.grep",
            "system.glob",
            "system.listDir",
            "system.stat",
          ],
          unattendedDeny: [],
        },
        unattendedAllow: [
          "FileRead",
          "system.grep",
          "system.glob",
          "system.listDir",
          "system.stat",
        ],
        unattendedDeny: [],
      },
    ]);
    await expect(sessions.getSession("session_1")).resolves.toEqual({
      sessionId: "session_1",
      agentId: "agent_1",
      status: "idle",
      createdAt: "2026-05-01T12:00:01.000Z",
      cwd: "/workspace",
      metadata: {
        ticket: "F-06a",
        objective: "build the parser",
        source: "agent.start",
        unattendedAllow: [
          "FileRead",
          "system.grep",
          "system.glob",
          "system.listDir",
          "system.stat",
        ],
        unattendedDeny: [],
      },
    });
    await expect(agents.listAgents()).resolves.toEqual({
      agents: [
        {
          agentId: "agent_1",
          agentPath: "/root/agent_1",
          objective: "build the parser",
          status: "running",
          createdAt: "2026-05-01T12:00:00.000Z",
          startedAt: "2026-05-01T12:00:00.500Z",
          lastActiveAt: "2026-05-01T12:00:00.500Z",
          cwd: "/workspace",
          activeSessionIds: ["session_1"],
          metadata: {
            ticket: "F-06a",
            unattendedAllow: [
              "FileRead",
              "system.grep",
              "system.glob",
              "system.listDir",
              "system.stat",
            ],
            unattendedDeny: [],
          },
        },
      ],
    });
    await expect(
      agents.attachAgent({ agentId: "agent_1", clientId: "tui_1" }),
    ).resolves.toEqual({
      agentId: "agent_1",
      attachmentId: "attachment_1",
      sessionIds: ["session_1"],
      runtimeSessionId: "agent_1",
      sessions: [
        {
          sessionId: "session_1",
          agentId: "agent_1",
          status: "idle",
          createdAt: "2026-05-01T12:00:01.000Z",
          cwd: "/workspace",
          metadata: {
            ticket: "F-06a",
            objective: "build the parser",
            source: "agent.start",
            unattendedAllow: [
              "FileRead",
              "system.grep",
              "system.glob",
              "system.listDir",
              "system.stat",
            ],
            unattendedDeny: [],
          },
          activeAttachmentIds: ["attachment_1"],
        },
      ],
    });
    await expect(sessions.getSession("session_1")).resolves.toMatchObject({
      activeAttachmentIds: ["attachment_1"],
    });
  });

  it("agent.stop shuts down the runner and persists the stopped summary", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence([
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
        "2026-05-01T12:00:03.000Z",
      ]),
    });
    const stopAgent = vi.fn(async () => {});
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_stop",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
      runner,
      sessionManager: sessions,
    });

    await agents.createAgent({ objective: "build the parser" });
    await expect(
      agents.attachAgent({ agentId: "agent_stop", clientId: "tui_1" }),
    ).resolves.toMatchObject({
      agentId: "agent_stop",
      sessionIds: ["session_1"],
    });

    await expect(
      agents.stopAgent({ agentId: "agent_stop", reason: "operator stop" }),
    ).resolves.toEqual({ agentId: "agent_stop", stopped: true });
    expect(stopAgent).toHaveBeenCalledWith("agent_stop", "operator stop");
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(agents.getAgent("agent_stop")).resolves.toEqual({
      agentId: "agent_stop",
      objective: "build the parser",
      status: "stopped",
      createdAt: "2026-05-01T12:00:00.000Z",
      startedAt: "2026-05-01T12:00:00.500Z",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
      cwd: "/workspace",
      metadata: {
        unattendedAllow: [
          "FileRead",
          "system.grep",
          "system.glob",
          "system.listDir",
          "system.stat",
        ],
        unattendedDeny: [],
      },
    });
    const stoppedSession = await sessions.getSession("session_1");
    expect(stoppedSession).toMatchObject({
      status: "closed",
      closedAt: "2026-05-01T12:00:03.000Z",
    });
    expect(stoppedSession).not.toHaveProperty("activeAttachmentIds");
    await expect(
      agents.attachAgent({ agentId: "agent_stop" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await expect(agents.stopAgent({ agentId: "agent_stop" })).resolves.toEqual({
      agentId: "agent_stop",
      stopped: false,
    });
    expect(stopAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps final stop state durable while runner shutdown is in flight", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence([
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:03.000Z",
      ]),
    });
    const stopStarted = createDeferred();
    const releaseStop = createDeferred();
    let stopping = false;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_race",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      getAgentSnapshot: async () =>
        stopping
          ? null
          : {
              status: "running",
              lastActiveAt: "2026-05-01T12:00:00.500Z",
            },
      stopAgent: async () => {
        stopping = true;
        stopStarted.resolve(undefined);
        await releaseStop.promise;
      },
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
      runner,
      sessionManager: sessions,
    });

    await agents.createAgent({ objective: "race stop" });
    const stop = agents.stopAgent({ agentId: "agent_race" });
    await stopStarted.promise;

    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(agents.getAgent("agent_race")).resolves.toMatchObject({
      agentId: "agent_race",
      status: "stopping",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
    });
    await expect(
      agents.attachAgent({ agentId: "agent_race" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    releaseStop.resolve(undefined);
    await expect(stop).resolves.toEqual({
      agentId: "agent_race",
      stopped: true,
    });
    await expect(agents.getAgent("agent_race")).resolves.toMatchObject({
      agentId: "agent_race",
      status: "stopped",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
    });
  });

  it("keeps stop failures from being reported as successful stops", async () => {
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_fail_stop",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent: async () => {
        throw new Error("shutdown failed");
      },
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
      runner,
    });

    await agents.createAgent({ objective: "fail stop" });
    await expect(agents.stopAgent({ agentId: "agent_fail_stop" })).rejects.toThrow(
      "shutdown failed",
    );
    await expect(agents.getAgent("agent_fail_stop")).resolves.toMatchObject({
      agentId: "agent_fail_stop",
      status: "error",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
    });
  });

  it("refreshes active list status and omits agents no longer active", async () => {
    const snapshots = new Map<string, AgenCBackgroundAgentSnapshot | null>();
    const ids = ["agent_active", "agent_done"];
    let startIndex = 0;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => {
        const agentId = ids[startIndex];
        if (agentId === undefined) throw new Error("unexpected start");
        startIndex += 1;
        snapshots.set(agentId, {
          status: "running",
          lastActiveAt: "2026-05-01T12:00:00.500Z",
        });
        return {
          agentId,
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
      getAgentSnapshot: async (agentId) => snapshots.get(agentId) ?? null,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
      ]),
      runner,
    });

    await agents.createAgent({ objective: "watch active work" });
    await agents.createAgent({ objective: "finish quickly" });
    snapshots.set("agent_active", {
      status: "idle",
      lastActiveAt: "2026-05-01T12:00:03.000Z",
    });
    snapshots.set("agent_done", null);

    await expect(agents.listAgents()).resolves.toEqual({
      agents: [
        {
          agentId: "agent_active",
          objective: "watch active work",
          status: "idle",
          createdAt: "2026-05-01T12:00:00.000Z",
          startedAt: "2026-05-01T12:00:00.500Z",
          lastActiveAt: "2026-05-01T12:00:03.000Z",
          cwd: "/workspace",
          metadata: {
            unattendedAllow: [
              "FileRead",
              "system.grep",
              "system.glob",
              "system.listDir",
              "system.stat",
            ],
            unattendedDeny: [],
          },
        },
      ],
    });
    await expect(agents.getAgent("agent_done")).resolves.toBeNull();
  });

  it("paginates active agents by stable id boundary under churn", async () => {
    const snapshots = new Map<string, AgenCBackgroundAgentSnapshot | null>();
    const ids = ["agent_1", "agent_2", "agent_3"];
    let startIndex = 0;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => {
        const agentId = ids[startIndex];
        if (agentId === undefined) throw new Error("unexpected start");
        startIndex += 1;
        snapshots.set(agentId, {
          status: "running",
          lastActiveAt: "2026-05-01T12:00:00.500Z",
        });
        return {
          agentId,
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
      getAgentSnapshot: async (agentId) => snapshots.get(agentId) ?? null,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
      runner,
    });

    await agents.createAgent({ objective: "first" });
    await agents.createAgent({ objective: "second" });
    await agents.createAgent({ objective: "third" });

    await expect(agents.listAgents({ limit: 2 })).resolves.toMatchObject({
      agents: [
        { agentId: "agent_1", objective: "first" },
        { agentId: "agent_2", objective: "second" },
      ],
      nextCursor: "agent_2",
    });

    snapshots.set("agent_1", null);
    await expect(
      agents.listAgents({ limit: 2, cursor: "agent_2" }),
    ).resolves.toMatchObject({
      agents: [{ agentId: "agent_3", objective: "third" }],
    });
  });

  it("preserves structured message.stream content for the background runner", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const submitted: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_structured",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      submitAgentMessage: async (agentId, params) => {
        submitted.push({ agentId, params });
      },
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ objective: "inspect image" });

    await agents.streamAgentMessage({
      sessionId: "session_1",
      content: [
        { type: "text", text: "inspect" },
        {
          type: "image_url",
          image_url: { url: "file:///tmp/screenshot.png" },
        },
      ],
      messageId: "message_1",
      streamId: "stream_1",
      acceptedAt: "2026-05-01T12:00:01.000Z",
      displayUserMessage: null,
    });

    expect(submitted).toEqual([
      {
        agentId: "agent_structured",
        params: {
          sessionId: "session_1",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/screenshot.png" },
            },
          ],
          originalContent: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/screenshot.png" },
            },
          ],
          displayUserMessage: null,
          messageId: "message_1",
          streamId: "stream_1",
          acceptedAt: "2026-05-01T12:00:01.000Z",
        },
      },
    ]);
  });

  it("rejects agent attach for missing agents and inactive sessions", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1", "session_2"]),
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
    });
    let active = true;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: active ? "agent_closed" : "agent_inactive",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      getAgentSnapshot: async (agentId) =>
        agentId === "agent_inactive" && !active
          ? null
          : {
              status: "running",
              lastActiveAt: "2026-05-01T12:00:00.500Z",
            },
    };
    const agents = new AgenCDaemonAgentManager({
      runner,
      sessionManager: sessions,
    });

    await expect(
      agents.attachAgent({ agentId: "agent_missing" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    await agents.createAgent({ objective: "closed session" });
    await sessions.terminateSession({
      sessionId: "session_1",
      reason: "test closed",
    });
    await expect(
      agents.attachAgent({ agentId: "agent_closed" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    active = false;
    await agents.createAgent({ objective: "inactive before attach" });
    await expect(
      agents.attachAgent({ agentId: "agent_inactive" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("does not report running when no background runner is available", async () => {
    const agents = new AgenCDaemonAgentManager();

    await expect(
      agents.createAgent({ objective: "build the parser" }),
    ).rejects.toMatchObject({
      code: "BACKGROUND_RUNNER_UNAVAILABLE",
    });
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
  });

  it("stops a launched agent when lifecycle session creation fails", async () => {
    const stopAgent = vi.fn(async () => {});
    const agents = new AgenCDaemonAgentManager({
      runner: {
        startAgent: async () => ({
          agentId: "agent_orphan",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        stopAgent,
      },
      sessionManager: {
        createSession: async () => {
          throw new Error("session store unavailable");
        },
      } as unknown as AgenCDaemonSessionManager,
    });

    await expect(
      agents.createAgent({ objective: "build the parser" }),
    ).rejects.toThrow("session store unavailable");
    expect(stopAgent).toHaveBeenCalledWith(
      "agent_orphan",
      "agent.create rollback after lifecycle failure",
    );
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
  });

  it("rejects a blank agent start objective", async () => {
    const agents = new AgenCDaemonAgentManager({
      runner: {
        startAgent: async () => {
          throw new Error("runner should not start");
        },
      },
    });
    await expect(
      agents.createAgent({ objective: "   " }),
    ).rejects.toBeInstanceOf(AgenCDaemonAgentLifecycleError);
  });

  it("requires initialize before agent.create on a daemon JSON-RPC connection", async () => {
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_rpc",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent: vi.fn(async () => {}),
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
      ]),
      runner,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
      initializeAuthenticator: (params) => params.authCookie === "secret-cookie",
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-init",
        method: "initialize",
        params: [],
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-init",
      error: {
        code: -32602,
        message: "daemon request params must be an object",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "auth",
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          clientName: "contract-test",
          authCookie: "wrong-cookie",
          capabilities: {},
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "auth",
      error: {
        code: -32000,
        message: "daemon connection authentication failed",
        data: { code: "CONNECTION_AUTHENTICATION_FAILED" },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "agent.create",
        params: { objective: "ship a daemon task", cwd: "/repo" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      error: {
        code: -32000,
        message: "daemon connection must initialize before requests",
        data: { code: "CONNECTION_NOT_INITIALIZED" },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          clientName: "contract-test",
          authCookie: "secret-cookie",
          capabilities: {},
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: {
        type: "initialized",
        protocolVersion: "1.0.0",
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "agent.create",
        params: { objective: "ship a daemon task", cwd: "/repo" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      result: {
        agentId: "agent_rpc",
        objective: "ship a daemon task",
        status: "running",
        createdAt: "2026-05-01T12:00:00.000Z",
        startedAt: "2026-05-01T12:00:00.500Z",
        lastActiveAt: "2026-05-01T12:00:00.500Z",
        cwd: "/repo",
        metadata: {
          unattendedAllow: [
            "FileRead",
            "system.grep",
            "system.glob",
            "system.listDir",
            "system.stat",
          ],
          unattendedDeny: [],
        },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 3,
        method: "agent.list",
        params: { limit: 1 },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 3,
      result: {
        agents: [
          {
            agentId: "agent_rpc",
            objective: "ship a daemon task",
            status: "running",
            createdAt: "2026-05-01T12:00:00.000Z",
            startedAt: "2026-05-01T12:00:00.500Z",
            lastActiveAt: "2026-05-01T12:00:00.500Z",
            cwd: "/repo",
            metadata: {
              unattendedAllow: [
                "FileRead",
                "system.grep",
                "system.glob",
                "system.listDir",
                "system.stat",
              ],
              unattendedDeny: [],
            },
          },
        ],
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 4,
        method: "agent.stop",
        params: { agentId: "agent_rpc" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 4,
      result: {
        agentId: "agent_rpc",
        stopped: true,
      },
    });
    expect(runner.stopAgent).toHaveBeenCalledWith("agent_rpc", "agent.stop");
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 5,
        method: "agent.list",
        params: { limit: 1 },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 5,
      result: {
        agents: [],
      },
    });
  });

  it("rejects malformed agent.create params before launching the runner", async () => {
    const startAgent = vi.fn(async () => ({
      agentId: "agent_bad",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running" as const,
    }));
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager({
        runner: { startAgent },
      }),
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1.0.0", clientName: "contract-test" },
      }),
    ).resolves.toMatchObject({
      result: { type: "initialized" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-create",
        method: "agent.create",
        params: [],
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-create",
      error: {
        code: -32602,
        message: "daemon request params must be an object",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "agent.create",
        params: { objective: 42 },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      error: {
        code: -32602,
        message: "agent.create param 'objective' must be a string",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-list",
        method: "agent.list",
        params: { limit: "many" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-list",
      error: {
        code: -32602,
        message: "agent.list param 'limit' must be a number",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-attach",
        method: "agent.attach",
        params: { clientId: "tui_1" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-attach",
      error: {
        code: -32602,
        message: "agent.attach requires agentId",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-stop",
        method: "agent.stop",
        params: { reason: "missing id" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-stop",
      error: {
        code: -32602,
        message: "agent.stop requires agentId",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-stream-content",
        method: "message.stream",
        params: {
          sessionId: "session_1",
          content: [{ type: "image", text: "not allowed" }],
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-stream-content",
      error: {
        code: -32602,
        message: "message.stream param 'content[0]' must be a text or image_url block",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 3,
        method: "agent.create",
        params: { objective: "ship", unattendedAllow: "FileRead" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 3,
      error: {
        code: -32602,
        message: "agent.create param 'unattendedAllow' must be an array of strings",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 4,
        method: "agent.create",
        params: { objective: "ship", metadata: [] },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 4,
      error: {
        code: -32602,
        message: "agent.create param 'metadata' must be an object",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    expect(startAgent).not.toHaveBeenCalled();
  });

  it("routes daemon tool approval decisions to the background runner", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const decisions: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_approve",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      resolveToolDecision: async (agentId, params) => {
        decisions.push({ agentId, params });
        return true;
      },
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ objective: "wait for approval" });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
    });
    const connection = dispatcher.createConnection();

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "approve",
        method: "tool.approve",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          scope: "session",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "approve",
      result: { requestId: "call_1", decision: "approved" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "deny",
        method: "tool.deny",
        params: {
          sessionId: "session_1",
          requestId: "call_2",
          reason: "no",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "deny",
      result: { requestId: "call_2", decision: "denied" },
    });

    expect(decisions).toEqual([
      {
        agentId: "agent_approve",
        params: {
          requestId: "call_1",
          decision: { kind: "approved_for_session" },
        },
      },
      {
        agentId: "agent_approve",
        params: {
          requestId: "call_2",
          decision: { kind: "denied" },
        },
      },
    ]);
  });

  it("rejects duplicate attach client ids instead of retaining a stale socket", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence([
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const agents = new AgenCDaemonAgentManager({
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      runner: {
        startAgent: async () => ({
          agentId: "agent_dup",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
      },
      sessionManager: sessions,
      broadcastSessionEvent: async (sessionId, event) => {
        await clientMultiplexer.broadcastSessionEvent(sessionId, event);
      },
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
      clientMultiplexer,
    });
    const first = dispatcher.createConnection({ sendNotification: () => {} });
    const second = dispatcher.createConnection({ sendNotification: () => {} });

    for (const [id, connection] of [
      ["init-1", first],
      ["init-2", second],
    ] as const) {
      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id,
          method: "initialize",
          params: { protocolVersion: "1.0.0", clientName: "contract-test" },
        }),
      ).resolves.toMatchObject({ result: { type: "initialized" } });
    }
    await expect(
      first.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "create",
        method: "agent.create",
        params: { objective: "run background work" },
      }),
    ).resolves.toMatchObject({
      result: { agentId: "agent_dup", sessionId: "session_1" },
    });
    await expect(
      first.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach-1",
        method: "agent.attach",
        params: { agentId: "agent_dup", clientId: "tui_dup" },
      }),
    ).resolves.toMatchObject({
      result: { agentId: "agent_dup", sessionIds: ["session_1"] },
    });
    await expect(
      second.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach-2",
        method: "agent.attach",
        params: { agentId: "agent_dup", clientId: "tui_dup" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "attach-2",
      error: {
        code: -32602,
        message: "daemon client is already registered: tui_dup",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
  });

  it("registers an attached client only on the primary attached session", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_new", "session_old"]),
      createAttachmentId: sequence(["attachment_new"]),
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
    });
    await sessions.createSession({ agentId: "agent_multi" });
    await sessions.createSession({ agentId: "agent_multi" });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {
        createAgent: async () => {
          throw new Error("createAgent should not be called");
        },
        listAgents: async () => ({ agents: [] }),
        streamAgentMessage: async () => {},
        approveTool: async () => ({ requestId: "unused", decision: "approved" }),
        denyTool: async () => ({ requestId: "unused", decision: "denied" }),
        cancelTool: async () => ({
          requestId: "unused",
          decision: "cancelled",
        }),
        attachAgent: async () => ({
          agentId: "agent_multi",
          attachmentId: "attachment_new",
          sessionIds: ["session_new", "session_old"],
          sessions: [
            {
              sessionId: "session_new",
              agentId: "agent_multi",
              status: "idle",
              createdAt: "2026-05-01T12:00:00.000Z",
            },
            {
              sessionId: "session_old",
              agentId: "agent_multi",
              status: "idle",
              createdAt: "2026-05-01T12:00:01.000Z",
            },
          ],
        }),
      },
      clientMultiplexer,
    });
    const connection = dispatcher.createConnection({ sendNotification: () => {} });

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach",
        method: "agent.attach",
        params: { agentId: "agent_multi", clientId: "tui_multi" },
      }),
    ).resolves.toMatchObject({
      result: {
        agentId: "agent_multi",
        sessionIds: ["session_new", "session_old"],
      },
    });

    await expect(
      clientMultiplexer.attachedClientIds("session_new"),
    ).resolves.toEqual(["tui_multi"]);
    await expect(
      clientMultiplexer.attachedClientIds("session_old"),
    ).resolves.toEqual([]);
  });
});
