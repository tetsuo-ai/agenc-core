import { PassThrough } from "node:stream";
import React, { type SetStateAction } from "react";
import { describe, expect, test, vi } from "vitest";

import type { ToolPermissionContext } from "../../permissions/types.js";
import { createRoot } from "../ink/root.js";
import type { AgenCBridgeSession } from "../session-types.js";

const providerProbe = vi.hoisted(() => ({
  fpsGetters: [] as unknown[],
  statsStores: [] as unknown[],
  appStateProps: [] as Array<{
    initialState: unknown;
    onChangeAppState: unknown;
  }>,
  onChangeAppState: vi.fn(),
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: () => {},
}));

vi.mock("src/utils/envUtils.js", () => ({
  isEnvTruthy: () => false,
}));

vi.mock("../../agenc/upstream/context/fpsMetrics.js", async () => {
  const React = await import("react");
  return {
    FpsMetricsProvider: ({
      children,
      getFpsMetrics,
    }: {
      children: React.ReactNode;
      getFpsMetrics: unknown;
    }) => {
      providerProbe.fpsGetters.push(getFpsMetrics);
      return React.createElement(React.Fragment, null, children);
    },
  };
});

vi.mock("../../agenc/upstream/context/stats.js", async () => {
  const React = await import("react");
  return {
    StatsProvider: ({
      children,
      store,
    }: {
      children: React.ReactNode;
      store: unknown;
    }) => {
      providerProbe.statsStores.push(store);
      return React.createElement(React.Fragment, null, children);
    },
  };
});

vi.mock("../../agenc/upstream/state/onChangeAppState.js", () => ({
  onChangeAppState: providerProbe.onChangeAppState,
}));

vi.mock("../ink.js", async () => {
  const React = await import("react");
  return {
    Box: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("ink-box", null, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("ink-text", null, children),
    useApp: () => ({ exit: () => {} }),
    useTerminalFocus: () => true,
    useTerminalTitle: () => {},
  };
});

vi.mock("../../agenc/upstream/context/mailbox.js", async () => {
  const React = await import("react");
  return {
    MailboxProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("../../agenc/upstream/hooks/useEffectEventCompat.js", () => ({
  useEffectEventCompat: (callback: unknown) => callback,
}));

vi.mock("../../agenc/upstream/hooks/useSettingsChange.js", () => ({
  useSettingsChange: () => {},
}));

vi.mock("../../services/PromptSuggestion/promptSuggestion.js", () => ({
  shouldEnablePromptSuggestion: () => false,
}));

vi.mock("../../agenc/upstream/Tool.js", () => ({
  buildTool: (tool: unknown) => tool,
  getEmptyToolPermissionContext: () => ({
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }),
}));

vi.mock("../../tools/ask-user-question/tui-tool.js", () => ({
  AskUserQuestionTool: {
    name: "AskUserQuestion",
    aliases: [],
    inputSchema: {
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    isEnabled: () => true,
  },
}));

vi.mock("../../agenc/upstream/utils/commitAttribution.js", () => ({
  createEmptyAttributionState: () => ({}),
}));

vi.mock("../../agenc/upstream/utils/permissions/permissionSetup.js", () => ({
  createDisabledBypassPermissionsContext: (context: unknown) => context,
  isBypassPermissionsModeDisabled: () => false,
}));

vi.mock("../../agenc/upstream/utils/settings/applySettingsChange.js", () => ({
  applySettingsChange: () => {},
}));

vi.mock("../../agenc/upstream/utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
}));

vi.mock("../../agenc/upstream/utils/teammate.js", () => ({
  isPlanModeRequired: () => false,
  isTeammate: () => false,
}));

vi.mock("../../agenc/upstream/utils/thinking.js", () => ({
  shouldEnableThinkingByDefault: () => false,
}));

vi.mock("../../agenc/upstream/utils/envUtils.js", () => ({
  isEnvTruthy: () => false,
}));

vi.mock("../../agenc/upstream/utils/fullscreen.js", () => ({
  isMouseClicksDisabled: () => true,
}));

vi.mock("../../agenc/upstream/utils/log.js", () => ({
  logError: () => {},
}));

vi.mock("../state/AppState.js", async () => {
  const React = await import("react");
  const defaultPermissionContext = {
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  };
  const StateContext = React.createContext<{
    state: Record<string, unknown>;
    setState: (next: SetStateAction<Record<string, unknown>>) => void;
  } | null>(null);
  return {
    getDefaultAppState: () => ({
      mainLoopModel: null,
      mainLoopModelForSession: null,
      toolPermissionContext: defaultPermissionContext,
    }),
    AppStateProvider: ({
      children,
      initialState,
      onChangeAppState,
    }: {
      children: React.ReactNode;
      initialState?: Record<string, unknown>;
      onChangeAppState?: unknown;
    }) => {
      providerProbe.appStateProps.push({ initialState, onChangeAppState });
      const [state, setState] = React.useState(
        initialState ?? {
          mainLoopModel: null,
          mainLoopModelForSession: null,
          toolPermissionContext: defaultPermissionContext,
        },
      );
      return React.createElement(
        StateContext.Provider,
        { value: { state, setState } },
        children,
      );
    },
    useAppState: (selector: (state: Record<string, unknown>) => unknown) => {
      const context = React.useContext(StateContext);
      if (context === null) throw new Error("missing AppState test provider");
      return selector(context.state);
    },
    useSetAppState: () => {
      const context = React.useContext(StateContext);
      if (context === null) throw new Error("missing AppState test provider");
      return context.setState;
    },
    useAppStateStore: () => {
      const context = React.useContext(StateContext);
      if (context === null) throw new Error("missing AppState test provider");
      return {
        getState: () => context.state,
        setState: context.setState,
        subscribe: () => () => {},
      };
    },
  };
});

vi.mock("../../agenc/adapters/upstream-commands.js", () => ({
  loadUpstreamCommandList: () => [],
}));

vi.mock("../../agenc/adapters/upstream-agent-list.js", () => ({
  loadUpstreamAgentList: () => [],
}));

vi.mock("../keybindings/KeybindingProviderSetup.js", async () => {
  const React = await import("react");
  return {
    KeybindingSetup: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("./Messages.js", async () => {
  const React = await import("react");
  return {
    Messages: ({ messages }: { messages: readonly unknown[] }) =>
      React.createElement("ink-text", null, `messages:${messages.length}`),
  };
});

vi.mock("./PromptInput/PromptInput.js", async () => {
  const React = await import("react");
  return {
    default: ({ input }: { input: string }) =>
      React.createElement("ink-text", null, `prompt:${input}`),
  };
});

vi.mock("../components/permissions/PermissionRequest.js", async () => {
  const React = await import("react");
  return {
    PermissionRequest: () =>
      React.createElement("ink-text", null, "permission-request"),
  };
});

const PERMISSION_CONTEXT: ToolPermissionContext = {
  mode: "default",
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
};

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createTestStreams(): {
  stdout: PassThrough;
  stdin: TestStdin;
  output: () => string;
} {
  let rendered = "";
  const stdout = new PassThrough();
  stdout.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  return { stdout, stdin, output: () => rendered };
}

async function renderApp(node: React.ReactNode): Promise<string> {
  const { stdout, stdin, output } = createTestStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  try {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return output();
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
  }
}

function createSession(): AgenCBridgeSession {
  const modeSubscribers: Array<() => void> = [];
  return {
    conversationId: "conversation-app-smoke",
    services: {
      permissionModeRegistry: {
        current: () => PERMISSION_CONTEXT,
        subscribeToModeChange: (cb) => {
          modeSubscribers.push(cb);
          return () => {
            const index = modeSubscribers.indexOf(cb);
            if (index !== -1) modeSubscribers.splice(index, 1);
          };
        },
      },
    },
    eventLog: {
      subscribe: () => () => {},
    },
    getInitialTranscriptEvents: () => [],
    subscribeToEvents: () => () => {},
    submit: async () => {},
    enqueueIdleInput: () => 1,
    sessionConfiguration: {
      provider: { slug: "test-provider" },
      collaborationMode: { model: "test-model" },
    },
    listMcpClients: () => [],
  };
}

describe("AgenCTuiApp render smoke", () => {
  test("App wrapper preserves provider wiring", async () => {
    const { App } = await import("./App.js");
    providerProbe.fpsGetters.length = 0;
    providerProbe.statsStores.length = 0;
    providerProbe.appStateProps.length = 0;
    const getFpsMetrics = vi.fn();
    const stats = { kind: "stats-store" };
    const initialState = {
      marker: "initial-state",
      toolPermissionContext: PERMISSION_CONTEXT,
    };

    const output = await renderApp(
      <App
        getFpsMetrics={getFpsMetrics}
        stats={stats as never}
        initialState={initialState as never}
      >
        {React.createElement("ink-text", null, "wrapped-child")}
      </App>,
    );

    expect(output).toContain("wrapped-child");
    expect(providerProbe.fpsGetters).toEqual([getFpsMetrics]);
    expect(providerProbe.statsStores).toEqual([stats]);
    expect(providerProbe.appStateProps).toHaveLength(1);
    expect(providerProbe.appStateProps[0]?.initialState).toBe(initialState);
    expect(providerProbe.appStateProps[0]?.onChangeAppState).toBe(
      providerProbe.onChangeAppState,
    );
  });

  test("renders the absorbed App shell with a stub session", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();

    const output = await renderApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        initialComposerText="draft"
      />,
    );

    expect(output).toContain("messages:0");
    expect(output).toContain("prompt:draft");
  });
});
