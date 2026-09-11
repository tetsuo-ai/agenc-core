import { describe, expect, it, vi } from "vitest";

// These mocks mirror the ones in daemon-session.contract.test.ts: importing
// daemon-session.js transitively pulls in App.js, which requires the ink/UI
// modules below to be stubbed so the module graph loads under vitest.
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
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "./daemon-session.js";
import { createDaemonTuiSessionFixture as createDaemonTuiSession } from "../helpers/daemon-tui-session.js";
import type {
  AgenCDaemonInternalMethod,
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "../app-server/protocol/index.js";

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

function createClient(options: { readonly submit?: () => Promise<unknown> } = {}): AgenCDaemonTuiClient & {
  readonly requests: Array<{ readonly method: string; readonly params?: JsonObject }>;
  emit(sessionId: string, event: JsonObject): void;
} {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  const requests: Array<{ readonly method: string; readonly params?: JsonObject }> = [];
  return {
    requests,
    async request(
      method: AgenCDaemonMethod | AgenCDaemonInternalMethod,
      params?: JsonObject,
    ): Promise<AgenCDaemonResultByMethod[AgenCDaemonMethod]> {
      requests.push({ method, params });
      if (method === "message.stream" && options.submit !== undefined) {
        return await options.submit() as AgenCDaemonResultByMethod[AgenCDaemonMethod];
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
    getConnectionState(): AgenCDaemonConnectionState | null {
      return null;
    },
    emit: (sessionId, event) => {
      for (const listener of listeners.get(sessionId) ?? []) {
        listener(event);
      }
    },
  };
}

describe("daemon session activeTurn error handling (ihunt)", () => {
  it.each([0, 1, 130] as const)(
    "settles a submission from its authoritative terminal response (%s) when live completion is missing",
    async (code) => {
      const client = createClient({ submit: async () => ({
        disposition: "started", turnId: "response-turn", terminal: { code, message: "recorded outcome" },
      }) });
      const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
      const events: unknown[] = [];
      const unsubscribe = session.subscribeToEvents((event) => events.push(event));
      await session.submit("input", { clientMessageId: "response-message" });
      expect(session.activeTurn?.unsafePeek()).toBeNull();
      expect(events).toContainEqual(expect.objectContaining({
        type: code === 0 ? "turn_complete" : code === 1 ? "turn_failed" : "turn_aborted",
        clientMessageId: "response-message",
        payload: expect.objectContaining({ turnId: "response-turn" }),
      }));
      unsubscribe();
    },
  );

  it("settles a response without a model turn only against its local submission placeholder", async () => {
    const client = createClient({ submit: async () => ({ disposition: "started", terminal: { code: 0 } }) });
    const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
    const events: unknown[] = [];
    const unsubscribe = session.subscribeToEvents((event) => events.push(event));
    await session.submit("input with no model turn", { clientMessageId: "no-model-message" });
    expect(session.activeTurn?.unsafePeek()).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_complete", clientMessageId: "no-model-message",
      payload: expect.objectContaining({ turnId: expect.stringMatching(/^tui_1:/u) }),
    }));
    await session.cancelActiveTurn?.("late interrupt");
    expect(client.requests.filter((request) => request.method === "session.cancelTurn")).toEqual([]);
    unsubscribe();
  });

  it.each([false, true])("does not let an old terminal response clear a successor turn (turn-scoped: %s)", async (turnScoped) => {
    let resolveSubmit!: (value: unknown) => void;
    const response = new Promise((resolve) => { resolveSubmit = resolve; });
    const client = createClient({ submit: () => response });
    const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
    const events: unknown[] = [];
    const unsubscribe = session.subscribeToEvents((event) => events.push(event));
    const submitted = session.submit("old input");
    await vi.waitFor(() => expect(client.requests.some((request) => request.method === "message.stream")).toBe(true));
    client.emit("session_1", {
      method: "event.agent_status",
      params: { eventId: "successor-start", status: "running", turnId: "successor-turn" },
    });
    resolveSubmit({ disposition: "started", ...(turnScoped ? { turnId: "old-turn" } : {}), terminal: { code: 0 } });
    await submitted;
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "successor-turn" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "turn_complete" }));
    unsubscribe();
  });

  it.each([
    { turnId: "turn", terminal: { code: 2 } },
    { turnId: "turn", terminal: { code: 0, message: 42 } },
    { turnId: "turn", terminal: null },
    { turnId: "", terminal: { code: 0 } },
  ])("rejects malformed terminal submission results %#", async (result) => {
    const client = createClient({ submit: async () => ({ disposition: "started", ...result }) });
    const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
    await expect(session.submit("input")).rejects.toThrow("invalid terminal submission result");
  });

  it.each(["idle", "completed", "failed", "cancelled"])(
    "ignores a stale %s agent status while a successor turn is active",
    (status) => {
      const client = createClient();
      const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
      const unsubscribe = session.subscribeToEvents(() => undefined);
      client.emit("session_1", {
        method: "event.agent_status",
        params: { eventId: "new-running", turnId: "new-turn", status: "running" },
      });
      client.emit("session_1", {
        method: "event.agent_status",
        params: { eventId: "stale-terminal", turnId: "old-turn", status },
      });
      expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "new-turn" });
      unsubscribe();
    },
  );

  it("does not send session-wide cancellation when no authoritative turn is visible", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
    await session.cancelActiveTurn?.("interrupt");
    expect(client.requests).toEqual([]);
    const unsubscribe = session.subscribeToEvents(() => undefined);
    client.emit("session_1", {
      method: "event.agent_status",
      params: { eventId: "presentation-event-id", status: "running" },
    });
    await session.cancelActiveTurn?.("interrupt unknown turn");
    expect(client.requests).toEqual([]);
    unsubscribe();
  });

  it("defers pending cancellation to the matching submission instead of an external turn", async () => {
    let resolveSubmit!: (value: unknown) => void;
    const response = new Promise((resolve) => { resolveSubmit = resolve; });
    const client = createClient({ submit: () => response });
    const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
    const submitted = session.submit("pending input", { clientMessageId: "local-message" });
    await vi.waitFor(() => expect(client.requests.some((request) => request.method === "message.stream")).toBe(true));
    await session.cancelActiveTurn?.("interrupt pending");
    const cancels = () => client.requests.filter((request) => request.method === "session.cancelTurn");
    expect(cancels()).toEqual([]);

    const emitUser = (messageId: string) => client.emit("session_1", {
      method: "event.session_event",
      params: { eventId: messageId, clientMessageId: messageId, event: { type: "user_message", payload: { messageId, message: "input" } } },
    });
    const emitStarted = (turnId: string, clientMessageId?: string) => client.emit("session_1", {
      method: "event.agent_status",
      params: { eventId: turnId, turnId, status: "running", ...(clientMessageId === undefined ? {} : { clientMessageId }) },
    });
    emitUser("external-message");
    emitStarted("external-turn");
    expect(cancels()).toEqual([]);
    emitUser("local-message");
    emitStarted("external-explicit-turn", "external-message");
    expect(cancels()).toEqual([]);
    emitUser("local-message");
    emitStarted("local-turn");
    expect(cancels()).toEqual([{
      method: "session.cancelTurn",
      params: { sessionId: "session_1", expectedTurnId: "local-turn", reason: "interrupt pending" },
    }]);
    resolveSubmit({ disposition: "started", turnId: "local-turn", terminal: { code: 130 } });
    await submitted;
  });

  it.each(["rejected", "duplicate"] as const)(
    "discards deferred cancellation after a %s submission settles",
    async (outcome) => {
      let resolveSubmit!: (value: unknown) => void;
      let rejectSubmit!: (error: Error) => void;
      const response = new Promise((resolve, reject) => {
        resolveSubmit = resolve;
        rejectSubmit = reject;
      });
      const client = createClient({ submit: () => response });
      const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
      const submitted = session.submit("pending input", { clientMessageId: "settled-message" });
      await vi.waitFor(() => expect(client.requests.some((request) => request.method === "message.stream")).toBe(true));
      await session.cancelActiveTurn?.("interrupt pending");
      if (outcome === "rejected") {
        rejectSubmit(new Error("admission rejected"));
      } else {
        resolveSubmit({ disposition: "duplicate", duplicateState: "incomplete" });
      }
      await expect(submitted).rejects.toThrow();
      client.emit("session_1", {
        method: "event.agent_status",
        params: { eventId: "later-start", status: "running", turnId: "later-turn", clientMessageId: "settled-message" },
      });
      expect(client.requests.filter((request) => request.method === "session.cancelTurn")).toEqual([]);
    },
  );

  it("closes only the matching explicit failed turn and permits the next turn", () => {
    const client = createClient();
    const session = createDaemonTuiSession({ baseSession: createBaseSession(), client, sessionId: "session_1", clientId: "tui_1" });
    const unsubscribe = session.subscribeToEvents(() => undefined);
    const emit = (id: string, type: string, payload: JsonObject) => client.emit("session_1", {
      method: "event.session_event", params: { eventId: id, event: { id, type, payload } },
    });
    emit("start", "turn_started", { turnId: "turn-1" });
    emit("diagnostic", "error", { turnId: "turn-1", cause: "stop_hook_threw", message: "diagnostic" });
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "turn-1" });
    emit("stale", "turn_failed", { turnId: "turn-old", code: "provider_error", message: "stale" });
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "turn-1" });
    emit("failure", "turn_failed", { turnId: "turn-1", code: "provider_error", message: "failed" });
    expect(session.activeTurn?.unsafePeek()).toBeNull();
    emit("next", "turn_started", { turnId: "turn-2" });
    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "turn-2" });
    client.emit("session_1", { method: "event.agent_status", params: { eventId: "idle-step", turnId: "turn-2", status: "idle" } });
    const observed: unknown[] = [];
    const unsubscribeObserved = session.subscribeToEvents((event) => observed.push(event));
    client.emit("session_1", { method: "event.agent_status", params: { eventId: "run-failure", status: "error", message: "run failed" } });
    expect(observed).toContainEqual(expect.objectContaining({ type: "turn_failed", payload: expect.objectContaining({ turnId: "turn-2" }) }));
    expect(session.activeTurn?.unsafePeek()).toBeNull();
    unsubscribeObserved();
    unsubscribe();
  });

  it.each([false, true])("clears activeTurn on an agent failure (turn-scoped: %s)", async (turnScoped) => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    // Subscribing wires up the daemon event stream into noteDaemonActivity.
    const unsubscribe = session.subscribeToEvents(() => undefined);

    expect(session.activeTurn?.unsafePeek()).toBeNull();

    await session.submit("run the tool");
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
        ...(turnScoped ? { turnId: "turn_1" } : {}),
        status: "error",
        message: "provider API error",
      },
    });

    expect(session.activeTurn?.unsafePeek()).toBeNull();
    unsubscribe();
  });

  it("keeps activeTurn across an unmarked session error", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const unsubscribe = session.subscribeToEvents(() => undefined);

    await session.submit("run the tool");
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
      method: "event.session_event",
      params: {
        eventId: "stream-retry",
        event: {
          id: "stream-retry",
          type: "error",
          payload: {
            cause: "future_mid_turn_diagnostic",
            message: "diagnostic event",
          },
        },
      },
    });

    expect(session.activeTurn?.unsafePeek()).toEqual({ turnId: "turn_1" });
    unsubscribe();
  });
});
