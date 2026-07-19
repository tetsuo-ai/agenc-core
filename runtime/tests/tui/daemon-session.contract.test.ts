import { describe, expect, it, vi } from "vitest";

vi.mock("./ink.js", () => ({
  Box: () => null,
  Text: () => null,
  useApp: () => ({ exit: () => {} }),
  useTerminalFocus: () => true,
  useTerminalTitle: () => {},
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../commands.js", () => ({
  listTuiCommandList: () => [],
}));

vi.mock("../agents/role-definitions.js", () => ({
  listAgentRoleDefinitions: () => [],
}));

vi.mock("./model-switch.js", () => ({
  buildPendingProviderSwitch: () => null,
}));

vi.mock("../llm/pasted-content.js", () => ({
  pastedContentsToLLMMessage: () => null,
}));

vi.mock("../tools.js", () => ({
  assembleToolPool: () => [],
  filterToolsByDenyRules: (tools: unknown) => tools,
  getAllBaseTools: () => [],
  getTools: () => [],
  getToolsForDefaultPreset: () => [],
  parseToolPreset: () => [],
}));

vi.mock("src/tools.js", () => ({
  assembleToolPool: () => [],
  filterToolsByDenyRules: (tools: unknown) => tools,
  getAllBaseTools: () => [],
  getTools: () => [],
}));

vi.mock("./context/fpsMetrics.js", () => ({
  FpsMetricsProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("./context/stats.js", () => ({
  StatsProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("./state/onChangeAppState.js", () => ({
  onChangeAppState: () => {},
}));

vi.mock("./components/Messages.js", () => ({
  Messages: () => null,
}));

vi.mock("./components/PromptInput/PromptInput.js", () => ({
  default: () => null,
}));

vi.mock("./context/promptOverlayContext.js", () => ({
  PromptOverlayProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("./keybindings/KeybindingProviderSetup.js", () => ({
  KeybindingSetup: ({ children }: { children: unknown }) => children,
}));

vi.mock("./permission-requests.js", () => ({
  AgenCPermissionOverlay: () => null,
  buildToolUseConfirmQueue: () => [],
  usePermissionRequests: () => [],
}));

vi.mock("./session-transcript.js", () => ({
  useSessionTranscript: () => ({
    messages: [],
    toolNames: [],
    isStreaming: false,
    inProgressToolUseIDs: [],
    streamingToolUses: [],
    streamingText: "",
  }),
}));

vi.mock("./tool-jsx-state.js", () => ({
  useToolJSX: () => [null, () => {}],
}));

vi.mock("./tool-rendering.js", () => ({
  createTuiTools: () => [],
}));

import {
  AGENC_DAEMON_RECONNECTING_MESSAGE,
  attachDaemonAgentTuiSession,
  attachDaemonTuiSession,
  createDaemonTuiSession,
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "./daemon-session.js";
import {
  installElicitationResolvers,
  subscribeToMcpUrlCompletions,
} from "./components/App.js";
import { installCompactProgressControls } from "./session-types.js";
import type {
  AgenCDaemonInternalMethod,
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  SessionPartialCompactFromMessageResult,
  SessionRewindConversationToMessageResult,
} from "../app-server/protocol/index.js";
import { JSON_RPC_VERSION } from "../app-server/protocol/index.js";
import { APPROVED, DENIED } from "../permissions/review-decision.js";

function createBaseSession(): AgenCTuiBridgeSession {
  return {
    conversationId: "local_session",
    services: {
      permissionModeRegistry: {
        current: () =>
          ({
            mode: "default",
            plan: null,
            network: null,
          }) as never,
      },
    },
  };
}

describe("compact progress controls", () => {
  it("publishes daemon-backed session compact controls and restores previous values", () => {
    const session = createBaseSession();
    const previousSetStreamMode = vi.fn();
    session.setStreamMode = previousSetStreamMode;
    const controls = {
      setStreamMode: vi.fn(),
      setResponseLength: vi.fn(),
      onCompactProgress: vi.fn(),
      setSDKStatus: vi.fn(),
    };

    const restore = installCompactProgressControls(session, controls);
    session.setStreamMode?.("requesting");
    session.setResponseLength?.((value) => value + 1);
    session.onCompactProgress?.({ type: "compact_start" });
    session.setSDKStatus?.("compacting");

    expect(controls.setStreamMode).toHaveBeenCalledWith("requesting");
    expect(controls.setResponseLength).toHaveBeenCalledOnce();
    expect(controls.onCompactProgress).toHaveBeenCalledWith({
      type: "compact_start",
    });
    expect(controls.setSDKStatus).toHaveBeenCalledWith("compacting");

    restore();
    expect(session.setStreamMode).toBe(previousSetStreamMode);
    expect(session.setResponseLength).toBeUndefined();
    expect(session.onCompactProgress).toBeUndefined();
    expect(session.setSDKStatus).toBeUndefined();
  });
});

function createClient(): AgenCDaemonTuiClient & {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod | AgenCDaemonInternalMethod;
    readonly params?: JsonObject;
    readonly signal?: AbortSignal;
  }>;
  connectionState: AgenCDaemonConnectionState | null;
  emitConnection(state: AgenCDaemonConnectionState): void;
  emit(sessionId: string, event: JsonObject): void;
  emitNotification(event: JsonObject): void;
} {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  const notificationListeners = new Set<(event: JsonObject) => void>();
  const connectionListeners = new Set<
    (state: AgenCDaemonConnectionState) => void
  >();
  const requests: Array<{
    readonly method: AgenCDaemonMethod | AgenCDaemonInternalMethod;
    readonly params?: JsonObject;
    readonly signal?: AbortSignal;
  }> = [];
  return {
    requests,
    connectionState: null,
    async request(
      method: AgenCDaemonMethod | AgenCDaemonInternalMethod,
      params?: JsonObject,
      options?: { readonly signal?: AbortSignal },
    ): Promise<
      | AgenCDaemonResultByMethod[AgenCDaemonMethod]
      | SessionPartialCompactFromMessageResult
      | SessionRewindConversationToMessageResult
    > {
      requests.push({
        method,
        params,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (method === "session.partialCompactFromMessage") {
        return {
          sessionId: "session_1",
          ok: true,
          eventAlreadyEmitted: true,
        };
      }
      if (method === "session.rewindConversationToMessage") {
        return {
          sessionId: "session_1",
          ok: true,
          eventAlreadyEmitted: true,
        };
      }
      return {} as AgenCDaemonResultByMethod[AgenCDaemonMethod];
    },
    subscribeToSessionEvents: (sessionId, cb) => {
      let sessionListeners = listeners.get(sessionId);
      if (sessionListeners === undefined) {
        sessionListeners = new Set();
        listeners.set(sessionId, sessionListeners);
      }
      sessionListeners.add(cb);
      return () => {
        sessionListeners?.delete(cb);
      };
    },
    subscribeToNotifications: (cb) => {
      notificationListeners.add(cb);
      return () => {
        notificationListeners.delete(cb);
      };
    },
    getConnectionState() {
      return this.connectionState;
    },
    subscribeToConnectionState: (cb) => {
      connectionListeners.add(cb);
      return () => {
        connectionListeners.delete(cb);
      };
    },
    emitConnection(state) {
      this.connectionState = state;
      for (const listener of connectionListeners) {
        listener(state);
      }
    },
    emit: (sessionId, event) => {
      for (const listener of listeners.get(sessionId) ?? []) {
        listener(event);
      }
    },
    emitNotification: (event) => {
      for (const listener of notificationListeners) {
        listener(event);
      }
    },
  };
}

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("AgenC TUI daemon session adapter", () => {
  it("attaches the TUI to an agent before subscribing to its daemon session", async () => {
    const client = createClient();
    client.request = async (method, params) => {
      client.requests.push({ method, params });
      if (method === "agent.attach") {
        return {
          agentId: "agent_1",
          attachmentId: "attachment_1",
          sessionIds: ["session_1"],
          runtimeSessionId: "agent_runtime",
        } as never;
      }
      return {} as never;
    };

    const session = await attachDaemonAgentTuiSession({
      baseSession: createBaseSession(),
      client,
      agentId: "agent_1",
      clientId: "tui_1",
    });
    const received: JsonObject[] = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_delta", id: "turn_1" },
    });
    unsubscribe();

    expect(session.conversationId).toBe("agent_runtime");
    expect(client.requests).toEqual([
      {
        method: "agent.attach",
        params: { agentId: "agent_1", clientId: "tui_1" },
      },
    ]);
    expect(received).toEqual([{ type: "turn_delta", id: "turn_1" }]);
  });

  it("attaches the TUI client before returning a daemon-backed session", async () => {
    const client = createClient();

    await expect(
      attachDaemonTuiSession({
        baseSession: createBaseSession(),
        client,
        sessionId: "session_1",
        clientId: "tui_1",
      }),
    ).resolves.toMatchObject({
      conversationId: "session_1",
    });
    expect(client.requests).toEqual([
      {
        method: "session.attach",
        params: { sessionId: "session_1", clientId: "tui_1" },
      },
    ]);
  });

  it("mirrors daemon-backed MCP additions to the runtime session", async () => {
    const client = createClient();
    client.request = async (method, params) => {
      client.requests.push({ method, params });
      if (method === "session.mcp.addServer") {
        return {
          sessionId: "session_1",
          serverName: "audit-ping",
          success: true,
          toolCount: 1,
        } as never;
      }
      return {} as never;
    };
    const localAddServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 1,
    }));
    const baseSession = createBaseSession();
    baseSession.services.mcpManager = {
      addServer: localAddServer,
    };

    const session = await attachDaemonTuiSession({
      baseSession,
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const result = await (
      session.services.mcpManager as {
        addServer(config: {
          name: string;
          transport: "stdio";
          command: string;
          args: readonly string[];
        }): Promise<unknown>;
      }
    ).addServer({
      name: "audit-ping",
      transport: "stdio",
      command: "node",
      args: ["/tmp/audit-ping.mjs"],
    });

    expect(result).toEqual({
      serverName: "audit-ping",
      success: true,
      toolCount: 1,
    });
    expect(client.requests).toEqual([
      {
        method: "session.attach",
        params: { sessionId: "session_1", clientId: "tui_1" },
      },
      {
        method: "session.mcp.addServer",
        params: {
          sessionId: "session_1",
          config: {
            name: "audit-ping",
            transport: "stdio",
            command: "node",
            args: ["/tmp/audit-ping.mjs"],
          },
        },
      },
    ]);
    expect(localAddServer).toHaveBeenCalledWith({
      name: "audit-ping",
      transport: "stdio",
      command: "node",
      args: ["/tmp/audit-ping.mjs"],
    });
  });

  it("mirrors daemon-backed MCP reconnect/enable/disable to the runtime session", async () => {
    const client = createClient();
    client.request = async (method, params) => {
      client.requests.push({ method, params });
      if (
        method === "session.mcp.reconnectServer" ||
        method === "session.mcp.enableServer" ||
        method === "session.mcp.disableServer"
      ) {
        return {
          sessionId: "session_1",
          serverName: "audit-ping",
          success: true,
          toolCount: 2,
        } as never;
      }
      return {} as never;
    };
    const localReconnect = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 2,
    }));
    const localEnable = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 2,
    }));
    const localDisable = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 2,
    }));
    const baseSession = createBaseSession();
    baseSession.services.mcpManager = {
      reconnectServer: localReconnect,
      enableServer: localEnable,
      disableServer: localDisable,
    };

    const session = await attachDaemonTuiSession({
      baseSession,
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const manager = session.services.mcpManager as {
      reconnectServer(name: string): Promise<unknown>;
      enableServer(name: string): Promise<unknown>;
      disableServer(name: string): Promise<unknown>;
    };

    const reconnectResult = await manager.reconnectServer("audit-ping");
    const enableResult = await manager.enableServer("audit-ping");
    const disableResult = await manager.disableServer("audit-ping");

    const projected = {
      serverName: "audit-ping",
      success: true,
      toolCount: 2,
    };
    expect(reconnectResult).toEqual(projected);
    expect(enableResult).toEqual(projected);
    expect(disableResult).toEqual(projected);

    expect(client.requests).toEqual([
      {
        method: "session.attach",
        params: { sessionId: "session_1", clientId: "tui_1" },
      },
      {
        method: "session.mcp.reconnectServer",
        params: { sessionId: "session_1", serverName: "audit-ping" },
      },
      {
        method: "session.mcp.enableServer",
        params: { sessionId: "session_1", serverName: "audit-ping" },
      },
      {
        method: "session.mcp.disableServer",
        params: { sessionId: "session_1", serverName: "audit-ping" },
      },
    ]);
    expect(localReconnect).toHaveBeenCalledWith("audit-ping");
    expect(localEnable).toHaveBeenCalledWith("audit-ping");
    expect(localDisable).toHaveBeenCalledWith("audit-ping");
  });

  it("exposes daemon turn activity through activeTurn for prompt busy state", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const unsubscribe = session.subscribeToEvents(() => undefined);

    expect(session.activeTurn?.unsafePeek()).toBeNull();

    await session.submit("use the MCP tool");
    expect(session.activeTurn?.unsafePeek()?.turnId).toMatch(/^tui_1:/u);

    client.emit("session_1", {
      method: "event.agent_status",
      params: {
        eventId: "status_1",
        turnId: "turn_1",
        status: "running",
      },
    });
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "turn_1" });

    client.emit("session_1", {
      method: "event.agent_status",
      params: {
        eventId: "status_2",
        turnId: "turn_1",
        status: "idle",
      },
    });
    expect(session.activeTurn?.unsafePeek()).toBeNull();
    unsubscribe();
  });

  it("keeps daemon activeTurn alive for foreground tool events after per-step idle status", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const unsubscribe = session.subscribeToEvents(() => undefined);

    client.emit("session_1", {
      method: "event.agent_status",
      params: {
        eventId: "status_idle",
        turnId: "turn_1",
        status: "idle",
      },
    });
    expect(session.activeTurn?.unsafePeek()).toBeNull();

    client.emit("session_1", {
      method: "event.session_event",
      params: {
        eventId: "tool_started",
        event: {
          id: "tool_started",
          type: "tool_call_started",
          payload: {
            callId: "call_1",
            toolName: "Read",
            args: "{}",
          },
        },
      },
    });
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "daemon-turn" });

    client.emit("session_1", {
      method: "event.session_event",
      params: {
        eventId: "tool_done",
        event: {
          id: "tool_done",
          type: "tool_call_completed",
          payload: {
            callId: "call_1",
            toolName: "Read",
            result: "ok",
          },
        },
      },
    });
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "daemon-turn" });

    client.emit("session_1", {
      method: "event.session_event",
      params: {
        eventId: "turn_done",
        event: {
          id: "turn_done",
          type: "turn_complete",
          payload: {
            turnId: "turn_1",
            lastAgentMessage: "done",
          },
        },
      },
    });
    expect(session.activeTurn?.unsafePeek()).toBeNull();
    unsubscribe();
  });

  it("sends TUI user input through message.stream", async () => {
    const client = createClient();
    const abortController = new AbortController();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await session.submit?.("run tests");
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      method: "message.stream",
      params: {
        sessionId: "session_1",
        content: "run tests",
      },
    });
  });

  it("clears daemon-owned session history through session.clear", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await session.clearDaemonSession?.();

    expect(client.requests).toEqual([
      {
        method: "session.clear",
        params: { sessionId: "session_1" },
      },
    ]);
  });

  it("interrupts the active turn through session.cancelTurn", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await session.cancelActiveTurn?.("interrupted");

    expect(client.requests).toEqual([
      {
        method: "session.cancelTurn",
        params: { sessionId: "session_1", reason: "interrupted" },
        // The cancel RPC carries a 5s timeout signal so a wedged daemon can
        // never swallow an ESC silently.
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("session.cancelTurn omits reason when none is supplied", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await session.cancelActiveTurn?.();

    expect(client.requests).toEqual([
      {
        method: "session.cancelTurn",
        params: { sessionId: "session_1" },
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("session.cancelTurn swallows daemon RPC failures so ESC never surfaces an error", async () => {
    const baseClient = createClient();
    // Wrap the fixture's request with a thrower for cancelTurn so we can
    // assert that pressing ESC against a disconnected daemon does NOT
    // bubble. Other methods stay on the original implementation.
    const originalRequest = baseClient.request.bind(baseClient);
    const client = {
      ...baseClient,
      request: async (
        method: AgenCDaemonMethod | AgenCDaemonInternalMethod,
        params?: JsonObject,
        options?: { readonly signal?: AbortSignal },
      ) => {
        if (method === "session.cancelTurn") {
          throw new Error("daemon disconnected");
        }
        return originalRequest(method, params, options);
      },
    } as AgenCDaemonTuiClient;
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await expect(session.cancelActiveTurn?.("interrupted")).resolves.toBeUndefined();
  });

  it("partially compacts daemon-owned session history through the internal TUI RPC", async () => {
    const client = createClient();
    const abortController = new AbortController();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await expect(
      session.partialCompactFromMessage({
        messageOrdinal: 2,
        direction: "up_to",
        feedback: "keep decisions",
        signal: abortController.signal,
      }),
    ).resolves.toMatchObject({
      sessionId: "session_1",
      ok: true,
      eventAlreadyEmitted: true,
    });

    expect(client.requests).toEqual([
      {
        method: "session.partialCompactFromMessage",
        params: {
          sessionId: "session_1",
          messageOrdinal: 2,
          direction: "up_to",
          feedback: "keep decisions",
        },
        signal: abortController.signal,
      },
    ]);
  });

  it("rewinds daemon-owned session history through the internal TUI RPC", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await expect(
      session.rewindConversationToMessage({
        messageOrdinal: 1,
      }),
    ).resolves.toMatchObject({
      sessionId: "session_1",
      ok: true,
      eventAlreadyEmitted: true,
    });

    expect(client.requests).toEqual([
      {
        method: "session.rewindConversationToMessage",
        params: {
          sessionId: "session_1",
          messageOrdinal: 1,
        },
      },
    ]);
  });

  it("forwards setPendingProviderSwitch to the daemon session.setModel RPC", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    // /model and /provider stage the switch synchronously; the bridge
    // fires session.setModel fire-and-forget. Flush the microtask queue
    // so the request lands before assertion.
    (session as unknown as {
      setPendingProviderSwitch: (
        spec: { provider: string; model: string } | null,
      ) => void;
    }).setPendingProviderSwitch({ provider: "openai", model: "gpt-x" });
    await Promise.resolve();
    await Promise.resolve();

    expect(client.requests).toEqual([
      {
        method: "session.setModel",
        params: {
          sessionId: "session_1",
          model: "gpt-x",
          provider: "openai",
        },
      },
    ]);
  });

  it("ignores a null setPendingProviderSwitch without issuing an RPC", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    (session as unknown as {
      setPendingProviderSwitch: (spec: null) => void;
    }).setPendingProviderSwitch(null);
    await Promise.resolve();

    expect(client.requests).toEqual([]);
  });

  it("forwards setDaemonPermissionMode to the daemon session.setPermissionMode RPC", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await (session as unknown as {
      setDaemonPermissionMode: (mode: string) => Promise<unknown>;
    }).setDaemonPermissionMode("plan");

    expect(client.requests).toEqual([
      {
        method: "session.setPermissionMode",
        params: {
          sessionId: "session_1",
          mode: "plan",
        },
      },
    ]);
  });

  it("forwards applyDaemonConfig to the daemon session.applyConfig RPC", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await (session as unknown as {
      applyDaemonConfig: (params: {
        profile?: string;
        reload?: boolean;
      }) => Promise<unknown>;
    }).applyDaemonConfig({ profile: "fast" });

    await (session as unknown as {
      applyDaemonConfig: (params: {
        profile?: string;
        reload?: boolean;
      }) => Promise<unknown>;
    }).applyDaemonConfig({ reload: true });

    expect(client.requests).toEqual([
      {
        method: "session.applyConfig",
        params: { sessionId: "session_1", profile: "fast" },
      },
      {
        method: "session.applyConfig",
        params: { sessionId: "session_1", reload: true },
      },
    ]);
  });

  it("forwards getDaemonHooksStatus to the daemon session.hooks.status RPC", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await (session as unknown as {
      getDaemonHooksStatus: () => Promise<unknown>;
    }).getDaemonHooksStatus();

    expect(client.requests).toEqual([
      {
        method: "session.hooks.status",
        params: { sessionId: "session_1" },
      },
    ]);
  });

  it("forwards setDaemonHooksDisabled to the daemon session.hooks.setDisabled RPC", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await (session as unknown as {
      setDaemonHooksDisabled: (disabled: boolean) => Promise<unknown>;
    }).setDaemonHooksDisabled(true);

    expect(client.requests).toEqual([
      {
        method: "session.hooks.setDisabled",
        params: { sessionId: "session_1", disabled: true },
      },
    ]);
  });

  it("exposes realtime controls that route through the daemon thread RPC surface", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
      realtimeThreadId: "agent_1",
      realtimeAudioCaptureFactory: async () => ({ stop: vi.fn() }),
    });

    await session.realtime.start({ transport: "websocket", outputModality: "text" });
    await session.realtime.appendText("voice text");
    await session.realtime.appendAudio({
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
    });
    await session.realtime.stop();

    expect(client.requests).toEqual([
      {
        method: "thread/realtime/start",
        params: {
          threadId: "agent_1",
          transport: { type: "websocket" },
          realtimeSessionId: null,
          prompt: null,
          outputModality: "text",
          voice: null,
        },
      },
      {
        method: "thread/realtime/appendText",
        params: {
          threadId: "agent_1",
          text: "voice text",
        },
      },
      {
        method: "thread/realtime/appendAudio",
        params: {
          threadId: "agent_1",
          audio: {
            data: "AAAA",
            sampleRate: 24000,
            numChannels: 1,
          },
        },
      },
      {
        method: "thread/realtime/stop",
        params: { threadId: "agent_1" },
      },
    ]);
  });

  it("maps realtime JSON-RPC notifications into subscribed TUI transcript events", async () => {
    const client = createClient();
    const realtimeAudioPlayer = {
      enqueue: vi.fn(),
      close: vi.fn(),
    };
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
      realtimeThreadId: "agent_1",
      realtimeAudioPlayer,
      realtimeAudioCaptureFactory: async () => ({ stop: vi.fn() }),
    });
    const received: JsonObject[] = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });

    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/started",
      params: {
        threadId: "other_agent",
        realtimeSessionId: "rt_other",
        version: "v2",
      },
    });
    await session.realtime.start({ transport: "websocket" });
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/started",
      params: {
        eventId: "rt_started_1",
        threadId: "agent_1",
        realtimeSessionId: "rt_1",
        version: "v2",
      },
    });
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/transcript/done",
      params: {
        threadId: "agent_1",
        role: "user",
        text: "hello by voice",
      },
    });
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/transcript/delta",
      params: {
        threadId: "agent_1",
        role: "assistant",
        delta: "partial",
      },
    });
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/itemAdded",
      params: {
        threadId: "agent_1",
        item: { type: "message", id: "item_1" },
      },
    });
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/outputAudio/delta",
      params: {
        threadId: "agent_1",
        audio: {
          data: "AAAA",
          sampleRate: 24000,
          numChannels: 1,
        },
      },
    });
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/sdp",
      params: {
        threadId: "agent_1",
        sdp: "answer-sdp",
      },
    });
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/closed",
      params: {
        threadId: "agent_1",
        reason: "requested",
      },
    });
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/error",
      params: {
        threadId: "agent_1",
        message: "transport failed",
      },
    });
    unsubscribe();

    expect(received.map((event) => event.type)).toEqual([
      "realtime_started",
      "realtime_transcript_done",
      "realtime_transcript_delta",
      "realtime_item_added",
      "realtime_output_audio_delta",
      "realtime_sdp",
      "realtime_closed",
      "realtime_error",
    ]);
    expect(received[0]?.id).toBe("rt_started_1");
    expect(realtimeAudioPlayer.enqueue).toHaveBeenCalledWith({
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
      samplesPerChannel: null,
      itemId: null,
    });
    expect(session.realtime.getState()).toMatchObject({
      phase: "inactive",
      realtimeSessionId: null,
      errorBanner: "transport failed",
    });
  });

  it("exposes daemon elicitation response helpers to the TUI", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await session.respondToUserInput("call_1", {
      answers: { choice: { answers: ["Yes"] } },
    });
    await session.respondToMcpElicitation("srv", "mcp_1", {
      action: "accept",
      content: { ok: true },
    });

    expect(client.requests).toEqual([
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          kind: "request_user_input",
          response: {
            answers: { choice: { answers: ["Yes"] } },
          },
        },
      },
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "mcp_1",
          kind: "mcp",
          serverName: "srv",
          response: {
            action: "accept",
            content: { ok: true },
          },
        },
      },
    ]);
  });

  it("bridges typed daemon elicitations through TUI resolvers", async () => {
    const client = createClient();
    const received: JsonObject[] = [];
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          requestUserInputResolver: {
            request: async (event) => {
              expect(event.requestId).toBe("call_1");
              expect(event.callId).toBe("call_1");
              expect(event.turnId).toBe("turn_1");
              return { answers: { choice: { answers: ["Yes"] } } };
            },
          },
          mcpElicitationResolver: {
            request: async (event) => {
              expect(event.serverName).toBe("srv");
              expect(event.requestId).toBe("mcp_1");
              return { action: "accept", content: { ok: true } };
            },
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.user_input_request",
      params: {
        sessionId: "session_1",
        eventId: "input_1",
        requestId: "call_1",
        callId: "call_1",
        turnId: "turn_1",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Proceed?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Yes", description: "Continue." },
              { label: "No", description: "Stop." },
            ],
          },
        ],
      },
    });
    await flush();
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_elicitation_request",
      params: {
        sessionId: "session_1",
        eventId: "mcp_1",
        requestId: "mcp_1",
        serverName: "srv",
        turnId: "turn_1",
        request: {
          mode: "form",
          message: "Need details",
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });
    await flush();
    unsubscribe();

    expect(received.map((event) => event.type)).toEqual([
      "request_user_input",
      "mcp_elicitation_request",
    ]);
    expect(client.requests).toEqual([
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          kind: "request_user_input",
          response: { answers: { choice: { answers: ["Yes"] } } },
        },
      },
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "mcp_1",
          kind: "mcp",
          serverName: "srv",
          response: { action: "accept", content: { ok: true } },
        },
      },
    ]);
  });

  it("flushes queued TUI idle input through an empty submit", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    expect(
      session.enqueueIdleInput({
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: "file:///tmp/screenshot.png" } },
        ],
      }),
    ).toBe(1);
    await session.submit("", { displayUserMessage: null });

    expect(client.requests).toEqual([
      {
        method: "message.stream",
        params: {
          sessionId: "session_1",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/screenshot.png" },
            },
          ],
          metadata: { displayUserMessage: null },
          streamId: expect.stringMatching(/^tui_1:/),
        },
      },
    ]);
  });

  it("combines queued idle input with explicit attached submit text", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    expect(session.enqueueIdleInput({ role: "user", content: "queued" })).toBe(1);
    await session.submit("typed");

    expect(client.requests[0]).toMatchObject({
      method: "message.stream",
      params: {
        sessionId: "session_1",
        content: [
          { type: "text", text: "queued" },
          { type: "text", text: "typed" },
        ],
      },
    });
  });

  it("bridges daemon permission requests back through tool decisions", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: {
            request: async (ctx) => {
              expect(ctx.callId).toBe("call_1");
              expect(ctx.toolName).toBe("Bash");
              return APPROVED;
            },
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents(() => {});
    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: {
          callId: "call_1",
          toolName: "Bash",
          turnId: "turn_1",
          input: { kind: "function", arguments: "{}" },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    unsubscribe();

    expect(client.requests).toEqual([
      {
        method: "tool.approve",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          scope: "once",
        },
      },
    ]);
  });

  it("bridges typed daemon permission requests back through tool decisions", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: {
            request: async (ctx) => {
              expect(ctx.callId).toBe("call_1");
              expect(ctx.toolName).toBe("Bash");
              return APPROVED;
            },
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents(() => {});
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.permission_request",
      params: {
        sessionId: "session_1",
        eventId: "call_1",
        requestId: "call_1",
        toolName: "Bash",
        turnId: "turn_1",
        permissions: ["tool.use"],
        input: { command: "pwd" },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    unsubscribe();

    expect(client.requests).toEqual([
      {
        method: "tool.approve",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          scope: "once",
        },
      },
    ]);
  });

  it("sends daemon deny decisions when permission bridge rejects", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: {
            request: async () => DENIED,
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents(() => {});
    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: {
          callId: "call_2",
          toolName: "Bash",
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    unsubscribe();

    expect(client.requests).toEqual([
      {
        method: "tool.deny",
        params: {
          sessionId: "session_1",
          requestId: "call_2",
          reason: "denied",
        },
      },
    ]);
  });

  it("subscribes the TUI to daemon session events", () => {
    const client = createClient();
    const received: JsonObject[] = [];
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents?.((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_start", id: "turn_1" },
    });
    unsubscribe?.();
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_complete", id: "turn_1" },
    });

    expect(received).toEqual([{ type: "turn_start", id: "turn_1" }]);
  });

  it("converts typed daemon notifications to TUI transcript events", () => {
    const client = createClient();
    const received: JsonObject[] = [];
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents?.((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.message_chunk",
      params: {
        sessionId: "session_1",
        eventId: "delta_1",
        delta: "hello",
      },
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.tool_request",
      params: {
        sessionId: "session_1",
        eventId: "tool_1",
        requestId: "call_1",
        toolName: "Bash",
        input: { command: "pwd" },
      },
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        sessionId: "session_1",
        eventId: "turn_1",
        agentId: "agent_1",
        status: "running",
        runStatus: "running",
        turnId: "turn_1",
      },
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        sessionId: "session_1",
        eventId: "turn_1_done",
        agentId: "agent_1",
        status: "idle",
        runStatus: "completed",
        turnId: "turn_1",
        message: "done",
      },
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.session_event",
      params: {
        sessionId: "session_1",
        eventId: "raw_1",
        event: { id: "raw_1", type: "custom", payload: { ok: true } },
      },
    });
    unsubscribe?.();

    expect(received).toEqual([
      {
        id: "delta_1",
        type: "agent_message_delta",
        payload: { delta: "hello" },
      },
      {
        id: "tool_1",
        type: "tool_call_started",
        payload: {
          callId: "call_1",
          toolName: "Bash",
          args: JSON.stringify({ command: "pwd" }),
        },
      },
      {
        id: "turn_1",
        type: "background_agent_status",
        payload: {
          turnId: "turn_1",
          status: "running",
          agentId: "agent_1",
          runStatus: "running",
        },
      },
      {
        id: "turn_1_done",
        type: "background_agent_status",
        payload: {
          turnId: "turn_1",
          status: "idle",
          agentId: "agent_1",
          runStatus: "completed",
          message: "done",
        },
      },
      { id: "raw_1", type: "custom", payload: { ok: true } },
    ]);
  });

  it("namespaces daemon request event ids when a permission prompt shares the tool request id", () => {
    const client = createClient();
    const received: JsonObject[] = [];
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents?.((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.permission_request",
      params: {
        sessionId: "session_1",
        requestId: "call_1",
        toolName: "FileRead",
        permissions: ["tool.use"],
      },
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.tool_request",
      params: {
        sessionId: "session_1",
        requestId: "call_1",
        toolName: "FileRead",
        input: { file_path: "/tmp/secret.txt" },
      },
    });
    unsubscribe?.();

    expect(received.map((event) => event.id)).toEqual([
      "permission-request:call_1",
      "tool-request:call_1",
    ]);
    expect(new Set(received.map((event) => event.id)).size).toBe(2);
  });

  it("shows a reconnecting notice without dropping the daemon event stream", () => {
    const client = createClient();
    const received: JsonObject[] = [];
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_start", id: "turn_1" },
    });
    client.emitConnection({ status: "reconnecting" });
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_complete", id: "turn_1" },
    });
    unsubscribe();

    expect(received).toEqual([
      { type: "turn_start", id: "turn_1" },
      {
        id: "agenc-daemon-reconnecting",
        type: "warning",
        payload: {
          message: AGENC_DAEMON_RECONNECTING_MESSAGE,
          cause: "daemon_connection_state",
          status: "reconnecting",
        },
      },
      { type: "turn_complete", id: "turn_1" },
    ]);
  });

  it("preserves initial transcript state while surfacing an existing disconnect", () => {
    const client = createClient();
    client.connectionState = { status: "disconnected" };
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        initialTranscriptEvents: [
          { type: "user_message", payload: { message: "status" } },
        ],
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    expect(session.getInitialTranscriptEvents()).toEqual([
      { type: "user_message", payload: { message: "status" } },
      {
        id: "agenc-daemon-disconnected",
        type: "warning",
        payload: {
          message: AGENC_DAEMON_RECONNECTING_MESSAGE,
          cause: "daemon_connection_state",
          status: "disconnected",
        },
      },
    ]);
  });

  it("clears daemon-backed MCP URL prompts from completion notifications without duplicate responses", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const prompts: unknown[] = [];
    const controller = installElicitationResolvers(session, (pending) => {
      prompts.push(pending);
    });
    const unsubscribe = subscribeToMcpUrlCompletions(session, controller);

    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_elicitation_request",
      params: {
        sessionId: "session_1",
        eventId: "url_1",
        requestId: "url_1",
        serverName: "srv",
        turnId: "turn_1",
        request: {
          mode: "url",
          message: "Authorize",
          elicitationId: "url_1",
          url: "https://127.0.0.1/auth",
        },
      },
    });
    await flush();
    expect((prompts.at(-1) as { readonly kind?: unknown } | undefined)?.kind)
      .toBe("mcp-url");
    expect(client.requests).toEqual([]);

    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.session_event",
      params: {
        sessionId: "session_1",
        event: {
          id: "complete_1",
          type: "mcp_elicitation_complete",
          payload: { serverName: "srv", elicitationId: "url_1" },
        },
      },
    });
    await flush();

    expect(prompts.at(-1)).toBeNull();
    expect(client.requests).toEqual([]);
    unsubscribe();
    controller.cleanup();
  });

  it("sends daemon-backed MCP URL responses for explicit TUI submissions", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const controller = installElicitationResolvers(session, () => {});
    const unsubscribe = subscribeToMcpUrlCompletions(session, controller);

    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_elicitation_request",
      params: {
        sessionId: "session_1",
        eventId: "url_1",
        requestId: "url_1",
        serverName: "srv",
        turnId: "turn_1",
        request: {
          mode: "url",
          message: "Authorize",
          elicitationId: "url_1",
          url: "https://127.0.0.1/auth",
        },
      },
    });
    await flush();

    expect(controller.submit("")).toBe(true);
    await flush();

    expect(client.requests).toEqual([
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "url_1",
          kind: "mcp",
          serverName: "srv",
          response: { action: "accept" },
        },
      },
    ]);
    unsubscribe();
    controller.cleanup();
  });

  it("bridges daemon elicitations once with multiple event subscribers", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const prompts: unknown[] = [];
    const controller = installElicitationResolvers(session, (pending) => {
      prompts.push(pending);
    });
    const completionUnsubscribe = subscribeToMcpUrlCompletions(session, controller);
    const transcriptEvents: unknown[] = [];
    const transcriptUnsubscribe = session.subscribeToEvents((event) => {
      transcriptEvents.push(event);
    });

    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.user_input_request",
      params: {
        sessionId: "session_1",
        eventId: "input_1",
        requestId: "call_1",
        callId: "call_1",
        turnId: "turn_1",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Proceed?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Yes", description: "Continue." },
              { label: "No", description: "Stop." },
            ],
          },
        ],
      },
    });
    await flush();

    expect(prompts.filter((prompt) =>
      (prompt as { readonly kind?: unknown } | null)?.kind === "user"
    )).toHaveLength(1);
    expect(controller.submit("Yes")).toBe(true);
    await flush();
    expect(client.requests).toEqual([
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          kind: "request_user_input",
          response: { answers: { choice: { answers: ["Yes"] } } },
        },
      },
    ]);

    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_elicitation_request",
      params: {
        sessionId: "session_1",
        eventId: "url_1",
        requestId: "url_1",
        serverName: "srv",
        turnId: "turn_1",
        request: {
          mode: "url",
          message: "Authorize",
          elicitationId: "url_1",
          url: "https://127.0.0.1/auth",
        },
      },
    });
    await flush();

    expect(prompts.filter((prompt) =>
      (prompt as { readonly kind?: unknown } | null)?.kind === "mcp-url"
    )).toHaveLength(1);

    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.session_event",
      params: {
        sessionId: "session_1",
        event: {
          id: "complete_1",
          type: "mcp_elicitation_complete",
          payload: { serverName: "srv", elicitationId: "url_1" },
        },
      },
    });
    await flush();

    expect(prompts.at(-1)).toBeNull();
    expect(client.requests).toHaveLength(1);
    expect(transcriptEvents.map((event) =>
      (event as { readonly type?: unknown }).type
    )).toEqual([
      "request_user_input",
      "mcp_elicitation_request",
      "mcp_elicitation_complete",
    ]);

    transcriptUnsubscribe();
    completionUnsubscribe();
    controller.cleanup();
  });

  it("bridges null user-input resolver results as cancellation", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          requestUserInputResolver: {
            request: async () => null,
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    session.subscribeToEvents(() => {});
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.user_input_request",
      params: {
        sessionId: "session_1",
        eventId: "input_1",
        requestId: "call_1",
        callId: "call_1",
        turnId: "turn_1",
        questions: [],
      },
    });
    await flush();

    expect(client.requests).toEqual([
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          kind: "request_user_input",
          response: { action: "cancel" },
        },
      },
    ]);
  });

  it("bridges thrown user-input resolver results as cancellation", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          requestUserInputResolver: {
            request: async () => {
              throw new Error("cancelled");
            },
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    session.subscribeToEvents(() => {});
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.user_input_request",
      params: {
        sessionId: "session_1",
        eventId: "input_1",
        requestId: "call_1",
        callId: "call_1",
        turnId: "turn_1",
        questions: [],
      },
    });
    await flush();

    expect(client.requests).toEqual([
      {
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          kind: "request_user_input",
          response: { action: "cancel" },
        },
      },
    ]);
  });
});
