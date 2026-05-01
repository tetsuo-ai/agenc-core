import { describe, expect, it, vi } from "vitest";
import {
  AgenCDaemonAgentLifecycleError,
  AgenCDaemonAgentManager,
} from "./agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import type {
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

describe("AgenC background agent lifecycle", () => {
  it("agent.create launches a running background agent and seeds its session", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:01.000Z"]),
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
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z"]),
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
});
