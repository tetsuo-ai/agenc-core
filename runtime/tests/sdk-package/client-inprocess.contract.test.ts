/**
 * Contract tests for the in-repo embedding SDK (`packages/agenc-sdk`)
 * against a fake daemon hosted on the REAL in-process transport
 * (`runtime/src/app-server/transport/in-process.ts`): real JSON-RPC
 * dispatcher, real session lifecycle, real client multiplexer; only the
 * agent runtime is faked.
 */

import { describe, expect, it } from "vitest";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import {
  JSON_RPC_VERSION,
  type AgenCDaemonSessionNotification,
  type JsonObject,
} from "../../src/app-server/protocol/index.js";
import {
  createAgencClient,
  type AgencClient,
  type AgencPermissionRequest,
  type AgencPromptEvent,
  type AgencTransport,
} from "../../../packages/agenc-sdk/src/index";

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("test sequence exhausted");
    index += 1;
    return value;
  };
}

interface FakeDaemon {
  readonly client: AgencClient;
  readonly transport: AgenCInProcessDaemonTransport;
  readonly multiplexer: AgenCDaemonClientMultiplexer;
  readonly calls: {
    streamed: JsonObject[];
    approved: JsonObject[];
    denied: JsonObject[];
  };
  broadcast(
    sessionId: string,
    notification: AgenCDaemonSessionNotification,
  ): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Assemble a fake daemon: real dispatcher + session manager + multiplexer
 * hosted on the real in-process transport, with an agent runtime whose turn
 * behavior is provided by `onStreamMessage`.
 */
async function createFakeDaemon(options: {
  readonly onStreamMessage?: (
    daemon: FakeDaemon,
    params: JsonObject,
  ) => Promise<void> | void;
  readonly onApproveTool?: (daemon: FakeDaemon, params: JsonObject) => void;
  readonly onDenyTool?: (daemon: FakeDaemon, params: JsonObject) => void;
  readonly onPermissionRequest?: (
    request: AgencPermissionRequest,
  ) =>
    | { behavior: "allow"; scope?: "once" | "session" | "agent" }
    | { behavior: "deny"; reason?: string };
} = {}): Promise<FakeDaemon> {
  const sessionManager = new AgenCDaemonSessionManager({
    createSessionId: sequence(["session_1", "session_2"]),
    createAttachmentId: sequence(["attachment_1", "attachment_2"]),
  });
  const multiplexer = new AgenCDaemonClientMultiplexer({
    sessionManager,
  });
  const calls: FakeDaemon["calls"] = { streamed: [], approved: [], denied: [] };

  let daemon!: FakeDaemon;
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: {
      createAgent: async () => {
        throw new Error("createAgent should not be called");
      },
      listAgents: async () => ({ agents: [] }),
      attachAgent: async () => {
        throw new Error("attachAgent should not be called");
      },
      stopAgent: async () => ({ agentId: "agent_1", stopped: true }),
      getAgentLogs: async () => ({
        agentId: "agent_1",
        sessions: [],
        transcript: "",
      }),
      streamAgentMessage: async (params: JsonObject) => {
        calls.streamed.push(params);
        await options.onStreamMessage?.(daemon, params);
      },
      approveTool: async (params: JsonObject) => {
        calls.approved.push(params);
        options.onApproveTool?.(daemon, params);
        return {
          requestId: String(params.requestId),
          decision: "approved" as const,
        };
      },
      denyTool: async (params: JsonObject) => {
        calls.denied.push(params);
        options.onDenyTool?.(daemon, params);
        return {
          requestId: String(params.requestId),
          decision: "denied" as const,
        };
      },
      cancelTool: async (params: JsonObject) => ({
        requestId: String(params.requestId),
        decision: "cancelled" as const,
      }),
      snapshotSession: async (params: JsonObject) => ({
        sessionId: String(params.sessionId),
        turnCount: 1,
        tokenUsage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          costUsd: 0.0042,
        },
        cacheStats: {
          requestCount: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheTotalInputTokens: 0,
          hitRate: null,
        },
      }),
    } as never,
    sessionManager,
    clientMultiplexer: multiplexer,
  });

  let client: AgencClient | undefined;
  const transport = new AgenCInProcessDaemonTransport({
    dispatcher,
    sendNotification: (notification) =>
      client?.dispatchNotification(notification),
  });
  client = createAgencClient({
    transport: transport as unknown as AgencTransport,
    clientId: "agenc-sdk-test-client",
    ...(options.onPermissionRequest !== undefined
      ? { onPermissionRequest: options.onPermissionRequest }
      : {}),
  });

  daemon = {
    client,
    transport,
    multiplexer,
    calls,
    broadcast: (sessionId, notification) =>
      multiplexer.broadcastSessionNotification(sessionId, notification),
    close: async () => {
      await client?.close();
      await transport.close();
    },
  };
  return daemon;
}

function statusNotification(
  sessionId: string,
  runStatus: "completed" | "errored" | "stopped",
  message?: string,
): AgenCDaemonSessionNotification {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: "event.agent_status",
    params: {
      sessionId,
      eventId: `evt_status_${runStatus}`,
      agentId: "agent_1",
      status: "running",
      runStatus,
      ...(message !== undefined ? { message } : {}),
    },
  };
}

describe("agenc-sdk client over the in-process transport", () => {
  it("initializes, creates a session, and streams a typed prompt event stream", async () => {
    const daemon = await createFakeDaemon({
      onStreamMessage: async (fake, params) => {
        const sessionId = String(params.sessionId);
        await fake.broadcast(sessionId, {
          jsonrpc: JSON_RPC_VERSION,
          method: "event.message_chunk",
          params: {
            sessionId,
            eventId: "evt_1",
            messageId: String(params.messageId),
            delta: "Hello ",
          },
        });
        await fake.broadcast(sessionId, {
          jsonrpc: JSON_RPC_VERSION,
          method: "event.tool_request",
          params: {
            sessionId,
            eventId: "evt_2",
            requestId: "tool_req_1",
            toolName: "Read",
            input: { file_path: "/tmp/x" },
          },
        });
        await fake.broadcast(sessionId, {
          jsonrpc: JSON_RPC_VERSION,
          method: "event.message_chunk",
          params: {
            sessionId,
            eventId: "evt_3",
            messageId: String(params.messageId),
            delta: "world",
          },
        });
        await fake.broadcast(
          sessionId,
          statusNotification(sessionId, "completed", "Hello world"),
        );
      },
    });

    const initialized = await daemon.client.initialize();
    expect(initialized).toMatchObject({
      type: "initialized",
      protocol: { version: "1.0.0" },
    });

    const session = await daemon.client.createSession({
      metadata: { source: "sdk-inprocess-test" },
    });
    expect(session.sessionId).toBe("session_1");
    await expect(
      daemon.multiplexer.attachedClientIds("session_1"),
    ).resolves.toEqual(["agenc-sdk-test-client"]);

    const run = session.prompt("hi there");
    const events: AgencPromptEvent[] = [];
    for await (const event of run) {
      events.push(event);
    }
    const result = await run.result();

    expect(daemon.calls.streamed).toHaveLength(1);
    expect(daemon.calls.streamed[0]).toMatchObject({
      sessionId: "session_1",
      content: "hi there",
    });
    await expect(run.accepted).resolves.toEqual({
      messageId: expect.any(String),
    });

    expect(
      events
        .filter(
          (event): event is Extract<AgencPromptEvent, { type: "text" }> =>
            event.type === "text",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe("Hello world");
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    const toolCall = events.find(
      (event): event is Extract<AgencPromptEvent, { type: "tool_call" }> =>
        event.type === "tool_call",
    );
    expect(toolCall).toMatchObject({
      requestId: "tool_req_1",
      toolName: "Read",
      input: { file_path: "/tmp/x" },
    });

    expect(result.stopReason).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.finalMessage).toBe("Hello world");
    expect(result.deniedPermissionRequestIds).toEqual([]);
    // includeUsage default: usage came from session.snapshot via the fake.
    expect(result.usage).toMatchObject({ totalTokens: 18, costUsd: 0.0042 });
    expect(result.cacheStats).toMatchObject({ requestCount: 1 });

    await daemon.close();
  });

  it("routes a permission request through the callback and back over tool.approve", async () => {
    const seen: AgencPermissionRequest[] = [];
    const daemon = await createFakeDaemon({
      onPermissionRequest: (request) => {
        seen.push(request);
        return { behavior: "allow", scope: "once" };
      },
      onStreamMessage: async (fake, params) => {
        const sessionId = String(params.sessionId);
        await fake.broadcast(sessionId, {
          jsonrpc: JSON_RPC_VERSION,
          method: "event.permission_request",
          params: {
            sessionId,
            eventId: "evt_perm_1",
            requestId: "perm_req_1",
            toolName: "Bash",
            permissions: ["bash"],
            input: { command: "ls" },
            reason: "tool requires approval",
          },
        });
      },
      onApproveTool: (fake, params) => {
        // The daemon resumes the turn once the approval lands.
        void fake.broadcast(
          String(params.sessionId),
          statusNotification(String(params.sessionId), "completed", "done"),
        );
      },
    });

    await daemon.client.initialize();
    const session = await daemon.client.createSession();
    const result = await session.prompt("run ls").result();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: "session_1",
      requestId: "perm_req_1",
      toolName: "Bash",
      permissions: ["bash"],
    });
    expect(daemon.calls.approved).toHaveLength(1);
    expect(daemon.calls.approved[0]).toMatchObject({
      sessionId: "session_1",
      requestId: "perm_req_1",
      scope: "once",
    });
    expect(daemon.calls.denied).toHaveLength(0);
    expect(result.stopReason).toBe("completed");
    expect(result.deniedPermissionRequestIds).toEqual([]);

    await daemon.close();
  });

  it("denies permission requests when no handler is registered (never hangs)", async () => {
    const daemon = await createFakeDaemon({
      onStreamMessage: async (fake, params) => {
        const sessionId = String(params.sessionId);
        await fake.broadcast(sessionId, {
          jsonrpc: JSON_RPC_VERSION,
          method: "event.permission_request",
          params: {
            sessionId,
            eventId: "evt_perm_2",
            requestId: "perm_req_2",
            toolName: "Bash",
            permissions: ["bash"],
          },
        });
      },
      onDenyTool: (fake, params) => {
        void fake.broadcast(
          String(params.sessionId),
          statusNotification(String(params.sessionId), "completed"),
        );
      },
    });

    await daemon.client.initialize();
    const session = await daemon.client.createSession();
    const result = await session.prompt("run ls").result();

    expect(daemon.calls.approved).toHaveLength(0);
    expect(daemon.calls.denied).toHaveLength(1);
    expect(daemon.calls.denied[0]).toMatchObject({
      sessionId: "session_1",
      requestId: "perm_req_2",
      reason: "agenc-sdk: no permission handler registered",
    });
    expect(result.deniedPermissionRequestIds).toEqual(["perm_req_2"]);

    await daemon.close();
  });

  it("resumes an existing session and surfaces turn errors as errored results", async () => {
    const daemon = await createFakeDaemon({
      onStreamMessage: async (fake, params) => {
        const sessionId = String(params.sessionId);
        await fake.broadcast(
          sessionId,
          statusNotification(sessionId, "errored", "provider exploded"),
        );
      },
    });

    await daemon.client.initialize();
    // Create the session out of band (as another client would), then resume.
    const created = await daemon.client.request("session.create", {});
    const session = await daemon.client.resumeSession(created.sessionId);
    const result = await session
      .prompt("hello", { includeUsage: false })
      .result();

    expect(result.stopReason).toBe("errored");
    expect(result.exitCode).toBe(1);
    expect(result.finalMessage).toBe("provider exploded");
    expect(result.usage).toBeUndefined();

    await daemon.close();
  });
});
