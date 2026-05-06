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

vi.mock("../agenc/adapters/upstream-commands.js", () => ({
  loadUpstreamCommandList: () => [],
}));

vi.mock("../agenc/adapters/upstream-agent-list.js", () => ({
  loadUpstreamAgentList: () => [],
}));

vi.mock("../agenc/adapters/upstream-model-switch.js", () => ({
  buildPendingProviderSwitch: () => null,
}));

vi.mock("../agenc/adapters/upstream-attachments.js", () => ({
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
import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
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

function createClient(): AgenCDaemonTuiClient & {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
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
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }> = [];
  return {
    requests,
    connectionState: null,
    async request<Method extends AgenCDaemonMethod>(
      method: Method,
      params?: JsonObject,
    ): Promise<AgenCDaemonResultByMethod[Method]> {
      requests.push({ method, params });
      return {} as AgenCDaemonResultByMethod[Method];
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

  it("sends TUI user input through message.stream", async () => {
    const client = createClient();
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

  it("exposes realtime controls that route through the daemon thread RPC surface", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
      realtimeThreadId: "agent_1",
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
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
      realtimeThreadId: "agent_1",
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
    client.emitNotification({
      jsonrpc: JSON_RPC_VERSION,
      method: "thread/realtime/started",
      params: {
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
      method: "thread/realtime/itemAdded",
      params: {
        threadId: "agent_1",
        item: { type: "message", id: "item_1" },
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
      "realtime_item_added",
      "realtime_error",
    ]);
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
        status: "running",
        turnId: "turn_1",
      },
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        sessionId: "session_1",
        eventId: "turn_1_done",
        status: "idle",
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
        type: "turn_started",
        payload: { turnId: "turn_1" },
      },
      {
        id: "turn_1_done",
        type: "turn_complete",
        payload: { turnId: "turn_1", lastAgentMessage: "done" },
      },
      { id: "raw_1", type: "custom", payload: { ok: true } },
    ]);
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
