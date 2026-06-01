import { describe, expect, it, vi } from "vitest";

import { createMcpUrlCompletionResponse } from "../../elicitation/url-completion.js";
import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "../../app-server/protocol/index.js";
import {
  attachDaemonAgentTuiSession,
  createDaemonTuiSession,
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "../daemon-session.js";

interface RecordedRequest {
  readonly method: string;
  readonly params?: JsonObject;
  readonly signal?: AbortSignal;
}

interface TestClient extends AgenCDaemonTuiClient {
  readonly requests: RecordedRequest[];
  connectionState: AgenCDaemonConnectionState | null;
  sessionSubscribeCount: number;
  sessionUnsubscribeCount: number;
  notificationSubscribeCount: number;
  notificationUnsubscribeCount: number;
  connectionSubscribeCount: number;
  connectionUnsubscribeCount: number;
  emit(sessionId: string, event: JsonObject): void;
  emitNotification(event: JsonObject): void;
  emitConnection(state: AgenCDaemonConnectionState): void;
}

function createBaseSession(
  overrides: Partial<AgenCTuiBridgeSession> = {},
): AgenCTuiBridgeSession {
  const { services, ...rest } = overrides;
  return {
    conversationId: "local_session",
    ...rest,
    services: {
      ...services,
    },
  };
}

function createClient(
  requestImpl?: (
    method: string,
    params: JsonObject | undefined,
    options: { readonly signal?: AbortSignal } | undefined,
    requests: RecordedRequest[],
  ) => Promise<unknown>,
): TestClient {
  const sessionListeners = new Map<string, Set<(event: JsonObject) => void>>();
  const notificationListeners = new Set<(event: JsonObject) => void>();
  const connectionListeners = new Set<
    (state: AgenCDaemonConnectionState) => void
  >();
  const client = {
    requests: [],
    connectionState: null,
    sessionSubscribeCount: 0,
    sessionUnsubscribeCount: 0,
    notificationSubscribeCount: 0,
    notificationUnsubscribeCount: 0,
    connectionSubscribeCount: 0,
    connectionUnsubscribeCount: 0,
    async request<Method extends AgenCDaemonMethod>(
      method: Method,
      params?: JsonObject,
      options?: { readonly signal?: AbortSignal },
    ): Promise<AgenCDaemonResultByMethod[Method]> {
      const record: RecordedRequest = {
        method,
        ...(params !== undefined ? { params } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      };
      this.requests.push(record);
      if (requestImpl !== undefined) {
        return await requestImpl(method, params, options, this.requests) as
          AgenCDaemonResultByMethod[Method];
      }
      if (method === "agent.attach") {
        return {
          agentId: "agent_1",
          attachmentId: "attach_1",
          sessionIds: ["session_1"],
          runtimeSessionId: "runtime_1",
        } as AgenCDaemonResultByMethod[Method];
      }
      if (method === "session.snapshot") {
        return {
          sessionId: params?.sessionId,
          events: [{ id: "event_1", type: "message" }],
        } as AgenCDaemonResultByMethod[Method];
      }
      if (method === "session.mcp.addServer") {
        const config = params?.config;
        const name =
          typeof config === "object" &&
          config !== null &&
          "name" in config &&
          typeof config.name === "string"
            ? config.name
            : "server";
        return {
          serverName: name,
          success: name !== "remote-failure",
          toolCount: name === "remote-failure" ? 0 : 2,
          ...(name === "remote-failure" ? { error: "remote rejected" } : {}),
        } as AgenCDaemonResultByMethod[Method];
      }
      return {} as AgenCDaemonResultByMethod[Method];
    },
    subscribeToSessionEvents(sessionId: string, cb: (event: JsonObject) => void) {
      this.sessionSubscribeCount += 1;
      const listeners = sessionListeners.get(sessionId) ?? new Set();
      listeners.add(cb);
      sessionListeners.set(sessionId, listeners);
      return () => {
        this.sessionUnsubscribeCount += 1;
        listeners.delete(cb);
      };
    },
    subscribeToNotifications(cb: (event: JsonObject) => void) {
      this.notificationSubscribeCount += 1;
      notificationListeners.add(cb);
      return () => {
        this.notificationUnsubscribeCount += 1;
        notificationListeners.delete(cb);
      };
    },
    getConnectionState() {
      return this.connectionState;
    },
    subscribeToConnectionState(cb: (state: AgenCDaemonConnectionState) => void) {
      this.connectionSubscribeCount += 1;
      connectionListeners.add(cb);
      return () => {
        this.connectionUnsubscribeCount += 1;
        connectionListeners.delete(cb);
      };
    },
    emit(sessionId: string, event: JsonObject) {
      for (const listener of sessionListeners.get(sessionId) ?? []) {
        listener(event);
      }
    },
    emitNotification(event: JsonObject) {
      for (const listener of notificationListeners) {
        listener(event);
      }
    },
    emitConnection(state: AgenCDaemonConnectionState) {
      this.connectionState = state;
      for (const listener of connectionListeners) {
        listener(state);
      }
    },
  } satisfies TestClient;
  return client;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("coverage swarm daemon session adapter", () => {
  it("throws when an agent attachment has no daemon session and exposes snapshots", async () => {
    const client = createClient(async (method) => {
      if (method === "agent.attach") {
        return {
          agentId: "agent_empty",
          attachmentId: "attach_empty",
          sessionIds: [],
        };
      }
      return {};
    });

    await expect(
      attachDaemonAgentTuiSession({
        baseSession: createBaseSession(),
        client,
        agentId: "agent_empty",
        clientId: "tui_1",
      }),
    ).rejects.toThrow("daemon agent has no attached session: agent_empty");

    const attached = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client: createClient(),
      sessionId: "session_1",
      clientId: "tui_1",
    });
    await expect(attached.getDaemonSessionSnapshot?.()).resolves.toEqual({
      sessionId: "session_1",
      events: [{ id: "event_1", type: "message" }],
    });
  });

  it("filters queued idle input and clears active turns when streaming fails", async () => {
    const failedStream = new Error("stream failed");
    const client = createClient(async (method) => {
      if (method === "message.stream") throw failedStream;
      return {};
    });
    const baseSession = createBaseSession({
      activeTurn: {
        unsafePeek: () => ({ turnId: "base_turn" }),
      },
    });
    const session = createDaemonTuiSession({
      baseSession,
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await session.submit("");
    expect(client.requests).toEqual([]);
    expect(session.enqueueIdleInput(42)).toBe(0);
    expect(session.enqueueIdleInput({ content: { text: "not an array" } })).toBe(0);
    expect(
      session.enqueueIdleInput({
        content: [
          null,
          { type: "text", text: 123 },
          { type: "image_url", image_url: { path: "/tmp/no-url.png" } },
          { type: "image_url", image_url: { url: "file:///tmp/ok.png" } },
          { type: "text", text: "queued text" },
        ],
      }),
    ).toBe(1);
    expect(session.enqueueIdleInput("raw string")).toBe(2);

    await expect(session.submit("typed text")).rejects.toBe(failedStream);
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "base_turn" });
    expect(client.requests).toEqual([
      {
        method: "message.stream",
        params: {
          sessionId: "session_1",
          content: [
            { type: "image_url", image_url: { url: "file:///tmp/ok.png" } },
            { type: "text", text: "queued text" },
            { type: "text", text: "raw string" },
            { type: "text", text: "typed text" },
          ],
          streamId: expect.stringMatching(/^tui_1:/u),
        },
      },
    ]);
  });

  it("returns daemon MCP addServer results across local mirror edge cases", async () => {
    const nullManagerSession = createDaemonTuiSession({
      baseSession: createBaseSession({
        services: { mcpManager: null },
      }),
      client: createClient(),
      sessionId: "session_1",
      clientId: "tui_1",
    });
    expect(nullManagerSession.services.mcpManager).toBeNull();

    const remoteOnlySession = createDaemonTuiSession({
      baseSession: createBaseSession({
        services: { mcpManager: { listServers: () => [] } },
      }),
      client: createClient(),
      sessionId: "session_1",
      clientId: "tui_1",
    });
    await expect(
      (
        remoteOnlySession.services.mcpManager as {
          addServer(config: { readonly name: string }): Promise<unknown>;
        }
      ).addServer({ name: "remote-failure" }),
    ).resolves.toEqual({
      serverName: "remote-failure",
      success: false,
      toolCount: 0,
      error: "remote rejected",
    });

    const alreadyConfiguredAddServer = vi.fn(async () => ({
      serverName: "already-configured",
      success: false,
      toolCount: 0,
      error: "Server already configured",
    }));
    const alreadyConfiguredSession = createDaemonTuiSession({
      baseSession: createBaseSession({
        services: { mcpManager: { addServer: alreadyConfiguredAddServer } },
      }),
      client: createClient(),
      sessionId: "session_1",
      clientId: "tui_1",
    });
    await expect(
      (
        alreadyConfiguredSession.services.mcpManager as {
          addServer(config: { readonly name: string }): Promise<unknown>;
        }
      ).addServer({ name: "already-configured" }),
    ).resolves.toEqual({
      serverName: "already-configured",
      success: true,
      toolCount: 2,
    });

    const fatalLocalAddServer = vi.fn(async () => ({
      serverName: "fatal-local",
      success: false,
      toolCount: 0,
      error: "local validation failed",
    }));
    const fatalLocalSession = createDaemonTuiSession({
      baseSession: createBaseSession({
        services: { mcpManager: { addServer: fatalLocalAddServer } },
      }),
      client: createClient(),
      sessionId: "session_1",
      clientId: "tui_1",
    });
    await expect(
      (
        fatalLocalSession.services.mcpManager as {
          addServer(config: { readonly name: string }): Promise<unknown>;
        }
      ).addServer({ name: "fatal-local" }),
    ).resolves.toEqual({
      serverName: "fatal-local",
      success: true,
      toolCount: 2,
    });
  });

  it("bridges resolver fallbacks for permissions and elicitations", async () => {
    const client = createClient();
    const approvalResolver = vi.fn(async (ctx) => {
      expect(ctx.toolName).toBe("tool");
      expect(ctx.turnId).toBe("call_session");
      expect(ctx.retryReason).toBe("needs confirmation");
      expect(ctx.invocation.payload.arguments).toBe(JSON.stringify({ ok: true }));
      return { kind: "approved_for_session" as const };
    });
    const requestUserInputResolver = vi.fn(async (event) => {
      expect(event.requestId).toBe("call_input");
      expect(event.questions).toEqual([{ id: "choice" }]);
      return { answers: { choice: { answers: ["Yes"] } } };
    });
    const mcpElicitationResolver = vi
      .fn()
      .mockResolvedValueOnce(createMcpUrlCompletionResponse())
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("resolver failed"));
    const session = createDaemonTuiSession({
      baseSession: createBaseSession({
        services: {
          approvalResolver: { request: approvalResolver },
          requestUserInputResolver: { request: requestUserInputResolver },
          mcpElicitationResolver: { request: mcpElicitationResolver },
        },
      }),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents(() => {});
    client.emit("session_1", {
      msg: {
        type: "request_permissions",
        payload: {
          callId: "call_session",
          input: { ok: true },
          reason: "needs confirmation",
        },
      },
    });
    client.emit("session_1", {
      msg: {
        type: "request_user_input",
        payload: {
          callId: "call_input",
          turnId: "turn_1",
          questions: [{ id: "choice" }, "bad"],
        },
      },
    });
    client.emit("session_1", {
      msg: {
        type: "mcp_elicitation_request",
        payload: {
          serverName: "srv",
          requestId: 7,
          turnId: "turn_1",
          request: { mode: "url" },
        },
      },
    });
    client.emit("session_1", {
      msg: {
        type: "mcp_elicitation_request",
        payload: {
          serverName: "srv",
          requestId: "mcp_null",
          turnId: "turn_1",
          request: { mode: "form" },
        },
      },
    });
    client.emit("session_1", {
      msg: {
        type: "mcp_elicitation_request",
        payload: {
          serverName: "srv",
          requestId: "mcp_throw",
          turnId: "turn_1",
          request: { mode: "form" },
        },
      },
    });
    await flush();
    unsubscribe();

    expect(client.requests).toHaveLength(4);
    expect(client.requests).toEqual(expect.arrayContaining([
      {
        method: "tool.approve",
        params: {
          sessionId: "session_1",
          requestId: "call_session",
          scope: "session",
        },
      },
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "call_input",
          kind: "request_user_input",
          response: { answers: { choice: { answers: ["Yes"] } } },
        },
      },
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "mcp_null",
          kind: "mcp",
          serverName: "srv",
          response: { action: "cancel" },
        },
      },
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "mcp_throw",
          kind: "mcp",
          serverName: "srv",
          response: { action: "cancel" },
        },
      },
    ]));
  });

  it("denies permission requests when the approval resolver throws", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession({
        services: {
          approvalResolver: {
            request: async () => {
              throw new Error("approval failed");
            },
          },
        },
      }),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    session.subscribeToEvents(() => {});
    client.emit("session_1", {
      msg: {
        type: "request_permissions",
        payload: { callId: "call_denied" },
      },
    });
    await flush();

    expect(client.requests).toEqual([
      {
        method: "tool.deny",
        params: {
          sessionId: "session_1",
          requestId: "call_denied",
          reason: "denied",
        },
      },
    ]);
  });

  it("subscribes once, tears down after the last listener, and maps notices", () => {
    const client = createClient();
    client.connectionState = {
      status: "reconnecting",
      id: "custom-reconnect",
      message: "custom reconnecting",
    };
    const session = createDaemonTuiSession({
      baseSession: createBaseSession({
        initialTranscriptEvents: [{ id: "unused", type: "initial" }],
        getInitialTranscriptEvents: () => [{ id: "method", type: "initial" }],
      }),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const firstEvents: JsonObject[] = [];
    const secondEvents: JsonObject[] = [];

    expect(session.getInitialTranscriptEvents()).toEqual([
      { id: "method", type: "initial" },
      {
        id: "custom-reconnect",
        type: "warning",
        payload: {
          message: "custom reconnecting",
          cause: "daemon_connection_state",
          status: "reconnecting",
        },
      },
    ]);

    const unsubscribeFirst = session.subscribeToEvents((event) => {
      firstEvents.push(event as JsonObject);
    });
    const unsubscribeSecond = session.subscribeToEvents((event) => {
      secondEvents.push(event as JsonObject);
    });
    expect(client.sessionSubscribeCount).toBe(1);
    expect(client.notificationSubscribeCount).toBe(1);
    expect(client.connectionSubscribeCount).toBe(1);

    client.emitConnection({ status: "connected" });
    client.emit("session_1", { method: 123, params: { ok: true } });
    client.emit("session_1", {
      method: "event.permission_request",
      params: {
        requestId: "call_1",
        permissions: ["tool.use", 5, "tool.admin"],
      },
    });
    client.emit("session_1", {
      msg: {
        type: "background_agent_status",
        payload: {
          eventId: "",
          status: "running",
        },
      },
    });
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "daemon-turn" });

    client.emit("session_1", {
      method: "event.agent_status",
      params: {
        eventId: "",
        status: "running",
      },
    });

    unsubscribeFirst();
    expect(client.sessionUnsubscribeCount).toBe(0);
    client.emit("session_1", {
      method: "event.agent_status",
      params: {
        turnId: "turn_done",
        status: "completed",
      },
    });
    expect(session.activeTurn?.unsafePeek()).toBeNull();
    unsubscribeSecond();

    expect(client.sessionUnsubscribeCount).toBe(1);
    expect(client.notificationUnsubscribeCount).toBe(1);
    expect(client.connectionUnsubscribeCount).toBe(1);
    expect(firstEvents).toEqual([
      { method: 123, params: { ok: true } },
      {
        id: "permission-request:call_1",
        type: "request_permissions",
        payload: {
          callId: "call_1",
          permissions: ["tool.use", "tool.admin"],
        },
      },
      {
        type: "background_agent_status",
        payload: {
          eventId: "",
          status: "running",
        },
      },
      {
        id: "status",
        type: "background_agent_status",
        payload: {
          turnId: "status",
          status: "running",
        },
      },
    ]);
    expect(secondEvents.at(-1)).toEqual({
      id: "turn_done",
      type: "background_agent_status",
      payload: {
        turnId: "turn_done",
        status: "completed",
      },
    });
  });
});
