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

function createClient(): AgenCDaemonTuiClient & {
  emit(sessionId: string, event: JsonObject): void;
} {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  return {
    async request(
      _method: AgenCDaemonMethod | AgenCDaemonInternalMethod,
      _params?: JsonObject,
    ): Promise<AgenCDaemonResultByMethod[AgenCDaemonMethod]> {
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
