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
  createDaemonTuiSession,
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "./daemon-session.js";
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
  it("clears activeTurn when the daemon agent/turn reports an error status", async () => {
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

    // A mid-turn failure arrives as event.agent_status { status: "error" },
    // which the bridge rewrites into a transcript event with type "error"
    // (NOT background_agent_status). Before the fix, noteDaemonActivity ignored
    // this event and left activeTurnSnapshot set forever, permanently blocking
    // /rewind and /compact-from-message.
    client.emit("session_1", {
      method: "event.agent_status",
      params: {
        eventId: "status_2",
        turnId: "turn_1",
        status: "error",
        message: "provider API error",
      },
    });

    expect(session.activeTurn?.unsafePeek()).toBeNull();
    unsubscribe();
  });
});
