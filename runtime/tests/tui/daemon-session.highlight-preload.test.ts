import { describe, expect, it, vi } from "vitest";

// The module graph of daemon-session.js needs the same UI stubs as
// daemon-session.ihunt-error-clears-active-turn.test.ts.
vi.mock("./ink.js", () => ({
  Box: () => null,
  Text: () => null,
  useApp: () => ({ exit: () => {} }),
  useTerminalFocus: () => true,
  useTerminalTitle: () => {},
}));
vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../commands.js", () => ({ listTuiCommandList: () => [] }));
vi.mock("../agents/role-definitions.js", () => ({ listAgentRoleDefinitions: () => [] }));
vi.mock("../llm/pasted-content.js", () => ({ pastedContentsToLLMMessage: () => null }));
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
vi.mock("./context/fpsMetrics.js", () => ({ FpsMetricsProvider: ({ children }: { children: unknown }) => children }));
vi.mock("./context/stats.js", () => ({ StatsProvider: ({ children }: { children: unknown }) => children }));
vi.mock("./state/onChangeAppState.js", () => ({ onChangeAppState: () => {} }));
vi.mock("./components/Messages.js", () => ({ Messages: () => null }));
vi.mock("./components/PromptInput/PromptInput.js", () => ({ default: () => null }));
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
vi.mock("./tool-jsx-state.js", () => ({ useToolJSX: () => [null, () => {}] }));
vi.mock("./tool-rendering.js", () => ({ createTuiTools: () => [] }));

const highlighter = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../utils/cliHighlight.js", () => ({
  getCliHighlightPromise: () => {
    highlighter.loads += 1;
    return Promise.resolve(null);
  },
}));

import type { AgenCDaemonTuiClient, AgenCTuiBridgeSession } from "./daemon-session.js";
import { createDaemonTuiSessionFixture as createDaemonTuiSession } from "../helpers/daemon-tui-session.js";
import type {
  AgenCDaemonInternalMethod,
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "../app-server/protocol/index.js";

function baseSession(): AgenCTuiBridgeSession {
  return {
    conversationId: "local_session",
    services: {
      permissionModeRegistry: {
        current: () => ({ mode: "default", plan: null, network: null }) as never,
      },
    },
  };
}

function client(response: Promise<unknown>): AgenCDaemonTuiClient & { readonly methods: string[] } {
  const methods: string[] = [];
  return {
    methods,
    async request(
      method: AgenCDaemonMethod | AgenCDaemonInternalMethod,
      _params?: JsonObject,
    ): Promise<AgenCDaemonResultByMethod[AgenCDaemonMethod]> {
      methods.push(method);
      if (method === "message.stream") return await response as AgenCDaemonResultByMethod[AgenCDaemonMethod];
      return {} as AgenCDaemonResultByMethod[AgenCDaemonMethod];
    },
    subscribeToSessionEvents: () => () => {},
    getConnectionState: () => null,
  };
}

describe("daemon TUI session highlighter preload", () => {
  it("starts loading the Markdown code highlighter while the model works on a submitted turn", async () => {
    let finish!: (value: unknown) => void;
    const response = new Promise((resolve) => { finish = resolve; });
    const daemon = client(response);
    const session = createDaemonTuiSession({
      baseSession: baseSession(), client: daemon, sessionId: "session_1", clientId: "tui_1",
    });
    const loadsBefore = highlighter.loads;
    const submitted = session.submit("explain this repo", { clientMessageId: "message-1" });
    await vi.waitFor(() => expect(daemon.methods).toContain("message.stream"));
    // The turn is still running: the load did not wait for its last reply.
    expect(highlighter.loads).toBeGreaterThan(loadsBefore);
    finish({ disposition: "started", turnId: "turn-1", terminal: { code: 0 } });
    await submitted;
  });
});
