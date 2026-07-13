import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import type { AgenCBackgroundAgentRunner } from "./background-agent-runner.js";
import { AgenCCommandExecService } from "./command-exec.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import type { AgenCFuzzyFileSearch } from "./fuzzy-file-search.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";

function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

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

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for file: ${path}`);
}

describe("AgenC daemon cancellation and preemption", () => {
  it("request.cancel aborts an in-flight request on the same connection", async () => {
    const searchStarted = createDeferred();
    let observedSignal: AbortSignal | undefined;
    const fuzzyFileSearch: AgenCFuzzyFileSearch = {
      search: vi.fn(async (_params, options) => {
        observedSignal = options?.signal;
        searchStarted.resolve(undefined);
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve();
            return;
          }
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return { files: [] };
      }),
    };
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      fuzzyFileSearch,
    });
    const connection = dispatcher.createConnection();

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });
    const search = connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "search-1",
      method: "fs.fuzzy_search",
      params: { query: "src", roots: ["/workspace"] },
    });
    await searchStarted.promise;
    expect(observedSignal?.aborted).toBe(false);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "cancel-1",
        method: "request.cancel",
        params: { requestId: "search-1", reason: "user stop" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "cancel-1",
      result: {
        requestId: "search-1",
        cancelled: true,
        reason: "user stop",
      },
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe("user stop");
    await expect(search).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "search-1",
      error: {
        code: -32000,
        data: {
          code: "REQUEST_CANCELLED",
          requestId: "search-1",
          reason: "user stop",
        },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "cancel-missing",
        method: "request.cancel",
        params: { requestId: "search-1" },
      }),
    ).resolves.toMatchObject({
      result: { requestId: "search-1", cancelled: false },
    });
  });

  it("request.cancel terminates a real in-flight commandExec.start process", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-command-cancel-"));
    const readyPath = join(root, "ready.txt");
    const terminatedPath = join(root, "terminated.txt");
    try {
      const dispatcher = new AgenCDaemonJsonRpcDispatcher({
        agentManager: new AgenCDaemonAgentManager(),
        commandExec: new AgenCCommandExecService(),
      });
      const connection = dispatcher.createConnection();
      await connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "init",
        method: "initialize",
        params: { protocolVersion: "1.0.0", clientName: "contract-test" },
      });

      const start = connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "command-1",
        method: "commandExec.start",
        params: {
          command: [
            process.execPath,
            "-e",
            [
              "const fs = require('node:fs');",
              "const [readyPath, terminatedPath] = process.argv.slice(1);",
              "fs.writeFileSync(readyPath, 'ready');",
              "process.on('SIGTERM', () => {",
              "  fs.writeFileSync(terminatedPath, 'terminated');",
              "  process.exit(0);",
              "});",
              "setInterval(() => {}, 1000);",
            ].join("\n"),
            readyPath,
            terminatedPath,
          ],
          processId: "cancel-real-command",
          timeoutMs: 60_000,
        },
      });

      await expect(waitForFile(readyPath)).resolves.toBe("ready");
      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: "cancel-command",
          method: "request.cancel",
          params: {
            requestId: "command-1",
            reason: "test cancellation",
          },
        }),
      ).resolves.toEqual({
        jsonrpc: JSON_RPC_VERSION,
        id: "cancel-command",
        result: {
          requestId: "command-1",
          cancelled: true,
          reason: "test cancellation",
        },
      });
      await expect(start).resolves.toMatchObject({
        jsonrpc: JSON_RPC_VERSION,
        id: "command-1",
        error: {
          code: -32000,
          data: {
            code: "REQUEST_CANCELLED",
            requestId: "command-1",
            reason: "test cancellation",
          },
        },
      });
      await expect(waitForFile(terminatedPath)).resolves.toBe("terminated");
      await connection.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("request.cancel does not falsely cancel non-cancellable daemon methods", async () => {
    const listStarted = createDeferred();
    const releaseList = createDeferred();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {
        createAgent: async () => {
          throw new Error("createAgent should not be called");
        },
        listAgents: async () => {
          listStarted.resolve(undefined);
          await releaseList.promise;
          return { agents: [] };
        },
        attachAgent: async () => ({
          agentId: "agent_1",
          attachmentId: "attachment_1",
          sessionIds: ["session_1"],
        }),
        streamAgentMessage: async () => {},
        approveTool: async () => ({
          requestId: "unused",
          decision: "approved",
        }),
        denyTool: async () => ({ requestId: "unused", decision: "denied" }),
        cancelTool: async () => ({
          requestId: "unused",
          decision: "cancelled",
        }),
        stopAgent: async () => ({ agentId: "agent_1", stopped: true }),
        getAgentLogs: async () => ({
          agentId: "agent_1",
          sessions: [],
          transcript: "agent_id\tagent_1\nNo transcript entries",
        }),
      },
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });

    const list = connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "list-1",
      method: "agent.list",
      params: {},
    });
    await listStarted.promise;
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "cancel-list",
        method: "request.cancel",
        params: { requestId: "list-1" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "cancel-list",
      result: {
        requestId: "list-1",
        cancelled: false,
      },
    });

    releaseList.resolve(undefined);
    await expect(list).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "list-1",
      result: { agents: [] },
    });
  });

  it("tool.cancel routes to the active runner cancellation hook", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const cancellations: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_active_tool",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      resolveToolDecision: async () => false,
      cancelTool: async (agentId, params) => {
        cancellations.push({ agentId, params });
        return true;
      },
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ cwd: process.cwd(), objective: "run a tool" });
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
        id: "cancel-active-tool",
        method: "tool.cancel",
        params: {
          sessionId: "session_1",
          requestId: "call_active",
          reason: "user stop",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "cancel-active-tool",
      result: { requestId: "call_active", decision: "cancelled" },
    });
    expect(cancellations).toEqual([
      {
        agentId: "agent_active_tool",
        params: {
          requestId: "call_active",
          reason: "user stop",
        },
      },
    ]);
  });

  it("tool.cancel rejects unknown request ids without interrupting", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const cancellations: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_active_tool",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      resolveToolDecision: async () => false,
      cancelTool: async (agentId, params) => {
        cancellations.push({ agentId, params });
        return false;
      },
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ cwd: process.cwd(), objective: "run a tool" });
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
        id: "cancel-missing-tool",
        method: "tool.cancel",
        params: {
          sessionId: "session_1",
          requestId: "missing_call",
          reason: "stale client request",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "cancel-missing-tool",
      error: {
        code: -32602,
        message: "AgenC daemon tool request is not pending: missing_call",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    expect(cancellations).toEqual([
      {
        agentId: "agent_active_tool",
        params: {
          requestId: "missing_call",
          reason: "stale client request",
        },
      },
    ]);
  });

  it("tool.cancel resolves a pending tool decision with an abort", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const decisions: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_cancel",
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
    await agents.createAgent({ cwd: process.cwd(), objective: "wait for cancel" });
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
        id: "cancel-tool",
        method: "tool.cancel",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          reason: "user stop",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "cancel-tool",
      result: { requestId: "call_1", decision: "cancelled" },
    });

    expect(decisions).toEqual([
      {
        agentId: "agent_cancel",
        params: {
          requestId: "call_1",
          decision: { kind: "abort" },
        },
      },
    ]);
  });
});
