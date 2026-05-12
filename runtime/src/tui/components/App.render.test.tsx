import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { type SetStateAction } from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolPermissionContext } from "../../permissions/types.js";
import type {
  McpElicitationRequestEvent,
  McpPrimitiveSchemaDefinition,
  RequestUserInputEvent,
} from "../../elicitation/types.js";
import type { AgenCBridgeSession } from "../session-types.js";
import type { AgenCRealtimeTuiControls } from "../realtime/controller.js";
import type { McpFormPending, McpUrlPending, PendingElicitation } from "./App.js";

if (process.versions.bun !== undefined) {
  test("App render suite requires Vitest module mocks", () => {
    expect(true).toBe(true);
  });
}

let createRoot: any;
let defaultConfig: any;
let markFirstRunOnboardingComplete: any;
let readOnboardingState: any;
let mockTotalCost = 0;
let mockHasConsoleBillingAccess = false;
let mockWorktreeSession: unknown = null;
let mockGlobalConfig: Record<string, unknown> = {};

const providerProbe = {
  fpsGetters: [] as unknown[],
  costSummaryGetters: [] as unknown[],
  statsStores: [] as unknown[],
  appStateProps: [] as Array<{
    initialState: unknown;
    onChangeAppState: unknown;
  }>,
  globalKeybindingProps: [] as Array<Record<string, unknown>>,
  exitFlowProps: [] as Array<Record<string, unknown>>,
  costThresholdDialogProps: [] as Array<Record<string, unknown>>,
  messageProps: [] as Array<Record<string, unknown>>,
  messageSelectorProps: [] as Array<Record<string, unknown>>,
  mcpConnectivityProps: [] as Array<Record<string, unknown>>,
  promptSubmits: [] as Array<(input: string, helpers: {
    clearBuffer(): void;
    resetHistory(): void;
    setCursorOffset(offset: number): void;
  }) => Promise<void>>,
  promptProps: [] as Array<Record<string, unknown>>,
  processBashCommand: typeof vi.fn === "function"
    ? vi.fn(async () => ({
        messages: [],
        shouldQuery: false,
      }))
    : async () => ({ messages: [], shouldQuery: false }),
  onChangeAppState: typeof vi.fn === "function" ? vi.fn() : () => {},
  inkExit: typeof vi.fn === "function" ? vi.fn() : () => {},
  logEvent: typeof vi.fn === "function" ? vi.fn() : () => {},
  fileHistoryRewind: typeof vi.fn === "function" ? vi.fn() : () => {},
};

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: () => {},
}));

vi.mock("src/utils/envUtils.js", () => ({
  isEnvTruthy: () => false,
}));

vi.mock("../context/fpsMetrics.js", async () => {
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
    useFpsMetrics: () => providerProbe.fpsGetters.at(-1),
  };
});

vi.mock("../../cost/hook.js", () => ({
  useCostSummary: (getFpsMetrics: unknown) => {
    providerProbe.costSummaryGetters.push(getFpsMetrics);
  },
}));

vi.mock("../../cost/tracker.js", () => ({
  getTotalCost: () => mockTotalCost,
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: providerProbe.logEvent,
}));

vi.mock("../../utils/billing.js", () => ({
  hasConsoleBillingAccess: () => mockHasConsoleBillingAccess,
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: () => mockGlobalConfig,
  saveGlobalConfig: (updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
    mockGlobalConfig = updater(mockGlobalConfig);
  },
}));

vi.mock("../../utils/fileHistory.js", () => ({
  fileHistoryRewind: providerProbe.fileHistoryRewind,
}));

vi.mock("../../utils/worktree.js", () => ({
  getCurrentWorktreeSession: () => mockWorktreeSession,
}));

vi.mock("../context/stats.js", async () => {
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

vi.mock("../state/onChangeAppState.js", () => ({
  onChangeAppState: providerProbe.onChangeAppState,
}));

vi.mock("../ink.js", async () => {
  const React = await import("react");
  return {
    Box: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("ink-box", null, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("ink-text", null, children),
    useApp: () => ({ exit: providerProbe.inkExit }),
    useInput: () => {},
    useTerminalFocus: () => true,
    useTerminalTitle: () => {},
    useAnimationFrame: () => [{ current: null }, 0],
    useTheme: () => ["dark", () => {}],
    useThemeSetting: () => "dark",
  };
});

vi.mock("../context/mailbox.js", async () => {
  const React = await import("react");
  return {
    MailboxProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("../hooks/useEffectEventCompat.js", () => ({
  useEffectEventCompat: (callback: unknown) => callback,
}));

vi.mock("../hooks/useSettingsChange.js", () => ({
  useSettingsChange: () => {},
}));

vi.mock("../../services/PromptSuggestion/promptSuggestion.js", () => ({
  shouldEnablePromptSuggestion: () => false,
}));

vi.mock("../../tools/Tool.js", () => ({
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

vi.mock("../../utils/commitAttribution.js", () => ({
  createEmptyAttributionState: () => ({}),
}));

vi.mock("../../utils/permissions/permissionSetup.js", () => ({
  createDisabledBypassPermissionsContext: (context: unknown) => context,
  isBypassPermissionsModeDisabled: () => false,
}));

vi.mock("../../utils/settings/applySettingsChange.js", () => ({
  applySettingsChange: () => {},
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
  getSettings_DEPRECATED: () => ({}),
}));

vi.mock("../../utils/teammate.js", () => ({
  isPlanModeRequired: () => false,
  isTeammate: () => false,
}));

vi.mock("../../utils/thinking.js", () => ({
  shouldEnableThinkingByDefault: () => false,
}));

vi.mock("../../utils/envUtils.js", () => ({
  isEnvTruthy: () => false,
}));

vi.mock("../../utils/fullscreen.js", () => ({
  isFullscreenEnvEnabled: () => false,
  isMouseClicksDisabled: () => true,
  isMouseTrackingEnabled: () => false,
}));

vi.mock("../../utils/log.js", () => ({
  logError: () => {},
}));

vi.mock("../input/processBashCommand.js", () => ({
  processBashCommand: providerProbe.processBashCommand,
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
      activeOverlays: new Set(),
      notifications: { current: null, queue: [] },
      elicitation: { queue: [] },
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
        {
          mainLoopModel: null,
          mainLoopModelForSession: null,
          toolPermissionContext: defaultPermissionContext,
          activeOverlays: new Set<string>(),
          notifications: {
            current: null,
            queue: [],
          },
          elicitation: {
            queue: [],
          },
          ...(initialState ?? {}),
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

vi.mock("../../commands.js", () => ({
  listTuiCommandList: () => [],
}));

vi.mock("../../agents/role-definitions.js", () => ({
  listAgentRoleDefinitions: () => [],
}));

vi.mock("../keybindings/KeybindingProviderSetup.js", async () => {
  const React = await import("react");
  return {
    KeybindingSetup: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("../hooks/useGlobalKeybindings.js", async () => {
  const React = await import("react");
  return {
    GlobalKeybindingHandlers: (props: Record<string, unknown>) => {
      providerProbe.globalKeybindingProps.push(props);
      return React.createElement(React.Fragment, null);
    },
  };
});

vi.mock("../hooks/notifs/useMcpConnectivityStatus.js", () => ({
  useMcpConnectivityStatus: (props: Record<string, unknown>) => {
    providerProbe.mcpConnectivityProps.push(props);
  },
}));

vi.mock("./Messages.js", async () => {
  const React = await import("react");
  return {
    Messages: (props: { messages: readonly unknown[] } & Record<string, unknown>) => {
      providerProbe.messageProps.push(props);
      return React.createElement(
        "ink-text",
        null,
        `messages:${props.messages.length}`,
      );
    },
  };
});

vi.mock("./MessageSelector.js", async () => {
  const React = await import("react");
  return {
    selectableUserMessagesFilter: (message: { type?: unknown; message?: { content?: unknown } }) => {
      const content = message.message?.content;
      return message.type === "user" && typeof content === "string" && content.trim().length > 0;
    },
    MessageSelector: (props: Record<string, unknown>) => {
      providerProbe.messageSelectorProps.push(props);
      const messages = props.messages as readonly unknown[];
      return React.createElement(
        "ink-text",
        null,
        `message-selector:${messages.length}`,
      );
    },
  };
});

vi.mock("./Message.js", async () => {
  const React = await import("react");
  return {
    Message: (props: Record<string, unknown>) =>
      React.createElement("ink-text", null, `queued-message:${String(props.message ?? "")}`),
  };
});

vi.mock("./ExitFlow.js", async () => {
  const React = await import("react");
  return {
    ExitFlow: (props: Record<string, unknown>) => {
      providerProbe.exitFlowProps.push(props);
      return React.createElement("ink-text", null, "exit-flow");
    },
  };
});

vi.mock("./dialogs/CostThresholdDialog.js", async () => {
  const React = await import("react");
  return {
    CostThresholdDialog: (props: Record<string, unknown>) => {
      providerProbe.costThresholdDialogProps.push(props);
      return React.createElement("ink-text", null, "cost-threshold-dialog");
    },
  };
});

vi.mock("./PromptInput/PromptInput.js", async () => {
  const React = await import("react");
  return {
    default: ({
      input,
      onSubmit,
      onShowMessageSelector,
      onMessageActionsEnter,
      onExit,
      vimMode,
      setVimMode,
      mcpClients,
      getToolUseContext,
      isLoading,
      pastedContents,
      setPastedContents,
      mode,
      onModeChange,
    }: {
      input: string;
      onSubmit: (input: string, helpers: {
        clearBuffer(): void;
        resetHistory(): void;
        setCursorOffset(offset: number): void;
      }) => Promise<void>;
      onShowMessageSelector?: () => void;
      onMessageActionsEnter?: () => void;
      onExit?: () => void;
      vimMode?: unknown;
      setVimMode?: unknown;
      mcpClients?: unknown;
      getToolUseContext?: unknown;
      isLoading?: boolean;
      pastedContents?: unknown;
      setPastedContents?: unknown;
      mode?: unknown;
      onModeChange?: unknown;
    }) => {
      providerProbe.promptSubmits.push(onSubmit);
      providerProbe.promptProps.push({
        input,
        onShowMessageSelector,
        onMessageActionsEnter,
        onExit,
        vimMode,
        setVimMode,
        mcpClients,
        getToolUseContext,
        isLoading,
        pastedContents,
        setPastedContents,
        mode,
        onModeChange,
      });
      return React.createElement("ink-text", null, `prompt:${input}`);
    },
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

function resetShellSurfaceProbe(): void {
  providerProbe.costSummaryGetters.length = 0;
  providerProbe.exitFlowProps.length = 0;
  providerProbe.costThresholdDialogProps.length = 0;
  providerProbe.messageSelectorProps.length = 0;
  providerProbe.messageProps.length = 0;
  providerProbe.mcpConnectivityProps.length = 0;
  providerProbe.promptProps.length = 0;
  providerProbe.promptSubmits.length = 0;
  providerProbe.inkExit.mockClear?.();
  providerProbe.logEvent.mockClear?.();
  providerProbe.fileHistoryRewind.mockReset?.();
  providerProbe.processBashCommand.mockClear?.();
  mockTotalCost = 0;
  mockHasConsoleBillingAccess = false;
  mockWorktreeSession = null;
  mockGlobalConfig = {};
}

let installElicitationResolvers: any;
let settlePendingOnSubmit: any;
const supportsVitestModuleMocks = process.versions.bun === undefined;
const describeWithVitestMocks = supportsVitestModuleMocks ? describe : describe.skip;

beforeAll(async () => {
  if (!supportsVitestModuleMocks) return;
  ({ createRoot } = await import("../ink/root.js"));
  ({ defaultConfig } = await import("../../config/schema.js"));
  ({
    markFirstRunOnboardingComplete,
    readOnboardingState,
  } = await import("../../onboarding/projectOnboardingState.js"));
  const app = await import("./App.js");
  installElicitationResolvers = app.installElicitationResolvers;
  settlePendingOnSubmit = app.settlePendingOnSubmit;
});

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

async function withRenderedApp(
  node: React.ReactNode,
  run: (ctx: { readonly output: () => string }) => Promise<void>,
): Promise<void> {
  const { stdout, stdin, output } = createTestStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  try {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await run({ output });
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
    rewindConversationToMessage: async () => ({
      ok: true,
      sessionId: "conversation-app-smoke",
      eventAlreadyEmitted: true,
      displayText: "Conversation rewound",
    }),
    sessionConfiguration: {
      provider: { slug: "test-provider" },
      collaborationMode: { model: "test-model" },
    },
    listMcpClients: () => [],
    listMcpTools: () => [],
  };
}

function createRealtimeControls(): AgenCRealtimeTuiControls {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    appendText: vi.fn(async () => {}),
    appendAudio: vi.fn(async () => {}),
    setMuted: vi.fn(),
    setPushToTalk: vi.fn(),
    setPushToTalkHeld: vi.fn(),
    getState: vi.fn(),
    subscribe: vi.fn(),
    handleTranscriptEvent: vi.fn(),
  } as unknown as AgenCRealtimeTuiControls;
}

describeWithVitestMocks("AgenCTuiApp render smoke", () => {
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
    providerProbe.promptProps.length = 0;

    const output = await renderApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
        initialComposerText="draft"
      />,
    );

    expect(output).toContain("messages:0");
    expect(output).toContain("prompt:draft");
    expect(providerProbe.promptProps.at(-1)).toEqual(
      expect.objectContaining({
        input: "draft",
        vimMode: "INSERT",
        setVimMode: expect.any(Function),
      }),
    );
  });

  test("passes live MCP clients and tools through the App shell", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const failedClient = {
      name: "files",
      type: "failed",
      config: {
        type: "stdio",
        command: "npx",
        args: ["server"],
        scope: "user",
      },
      error: "spawn ENOENT",
    } as const;
    const mcpTool = {
      name: "mcp.files.search",
      description: "Search files",
      inputSchema: { type: "object", properties: {} },
      execute: vi.fn(async () => ({ content: "ok" })),
    };
    const mcpClients = [failedClient];
    const mcpTools = [mcpTool];
    const session = {
      ...createSession(),
      listMcpClients: vi.fn(() => mcpClients),
      listMcpTools: vi.fn(() => mcpTools),
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        expect(providerProbe.mcpConnectivityProps.at(-1)).toEqual({
          mcpClients,
        });
        const promptProps = providerProbe.promptProps.at(-1)!;
        expect(promptProps).toEqual(
          expect.objectContaining({
            mcpClients,
            getToolUseContext: expect.any(Function),
          }),
        );

        const context = (promptProps.getToolUseContext as (
          messages: unknown[],
          newMessages: unknown[],
          abortController: AbortController,
        ) => {
          readonly options: {
            readonly tools: readonly unknown[];
            readonly mcpClients: readonly unknown[];
            readonly refreshTools: () => readonly unknown[];
          };
        })([], [], new AbortController());

        expect(context.options.mcpClients).toBe(mcpClients);
        expect(context.options.tools).toContain(mcpTool);
        expect(context.options.refreshTools()).toContain(mcpTool);
      },
    );
  });

  test("refreshes MCP clients and tools when same-metadata objects are replaced", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    let notifySessionEvent: (() => void) | undefined;
    let generation = 0;
    const firstClient = {
      name: "files",
      type: "connected",
      config: {
        type: "stdio",
        command: "npx",
        args: ["server"],
        scope: "user",
      },
      capabilities: { tools: {} },
      client: { setNotificationHandler: vi.fn() },
      cleanup: vi.fn(async () => {}),
    } as const;
    const secondClient = {
      ...firstClient,
      client: { setNotificationHandler: vi.fn() },
      cleanup: vi.fn(async () => {}),
    };
    const firstTool = {
      name: "mcp.files.search",
      description: "Search files",
      inputSchema: { type: "object", properties: {} },
      execute: vi.fn(async () => ({ content: "first" })),
    };
    const secondTool = {
      name: "mcp.files.search",
      description: "Search files",
      inputSchema: { type: "object", properties: {} },
      execute: vi.fn(async () => ({ content: "second" })),
    };
    const clientGenerations = [[firstClient], [secondClient]];
    const toolGenerations = [[firstTool], [secondTool]];
    const session = {
      ...createSession(),
      subscribeToEvents: vi.fn((callback: () => void) => {
        notifySessionEvent = callback;
        return () => {};
      }),
      listMcpClients: vi.fn(() => clientGenerations[generation]),
      listMcpTools: vi.fn(() => toolGenerations[generation]),
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        let promptProps = providerProbe.promptProps.at(-1)!;
        let context = (promptProps.getToolUseContext as (
          messages: unknown[],
          newMessages: unknown[],
          abortController: AbortController,
        ) => {
          readonly options: {
            readonly tools: readonly unknown[];
            readonly mcpClients: readonly unknown[];
          };
        })([], [], new AbortController());

        expect(context.options.mcpClients).toBe(clientGenerations[0]);
        expect(context.options.tools).toContain(firstTool);

        generation = 1;
        notifySessionEvent?.();
        await new Promise((resolve) => setTimeout(resolve, 25));

        promptProps = providerProbe.promptProps.at(-1)!;
        context = (promptProps.getToolUseContext as (
          messages: unknown[],
          newMessages: unknown[],
          abortController: AbortController,
        ) => {
          readonly options: {
            readonly tools: readonly unknown[];
            readonly mcpClients: readonly unknown[];
          };
        })([], [], new AbortController());

        expect(context.options.mcpClients).toBe(clientGenerations[1]);
        expect(context.options.tools).toContain(secondTool);
        expect(context.options.tools).not.toContain(firstTool);
      },
    );
  });

  test("mounts global keybindings against the live transcript state", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    providerProbe.globalKeybindingProps.length = 0;
    providerProbe.messageProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        expect(providerProbe.globalKeybindingProps.at(-1)).toEqual(
          expect.objectContaining({
            screen: "prompt",
            setScreen: expect.any(Function),
            showAllInTranscript: false,
            setShowAllInTranscript: expect.any(Function),
            messageCount: 0,
          }),
        );
        expect(providerProbe.messageProps.at(-1)).toEqual(
          expect.objectContaining({
            screen: "prompt",
            verbose: false,
            showAllInTranscript: false,
          }),
        );

        const handlerProps = providerProbe.globalKeybindingProps.at(-1)!;
        (handlerProps.setScreen as (next: "transcript") => void)("transcript");
        (handlerProps.setShowAllInTranscript as (next: boolean) => void)(true);
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.globalKeybindingProps.at(-1)).toEqual(
          expect.objectContaining({
            screen: "transcript",
            showAllInTranscript: true,
          }),
        );
        expect(providerProbe.messageProps.at(-1)).toEqual(
          expect.objectContaining({
            screen: "transcript",
            verbose: true,
            showAllInTranscript: true,
            hidePastThinking: true,
          }),
        );
      },
    );
  });

  test("opens the message selector from PromptInput callbacks", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    providerProbe.messageProps.length = 0;
    providerProbe.messageSelectorProps.length = 0;
    providerProbe.promptProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
        initialUserMessages={[{ role: "user", content: "revise this" }]}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1);
        expect(promptProps).toEqual(
          expect.objectContaining({
            onShowMessageSelector: expect.any(Function),
            onMessageActionsEnter: expect.any(Function),
          }),
        );

        (promptProps!.onMessageActionsEnter as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.messageSelectorProps.at(-1)).toEqual(
          expect.objectContaining({
            messages: [expect.objectContaining({ type: "user" })],
            onRestoreMessage: expect.any(Function),
            onClose: expect.any(Function),
          }),
        );
        expect(providerProbe.messageProps.at(-1)).toEqual(
          expect.objectContaining({
            isMessageSelectorVisible: true,
          }),
        );

        const selectorProps = providerProbe.messageSelectorProps.at(-1)!;
        await (selectorProps.onRestoreMessage as (message: unknown) => Promise<void>)(
          (selectorProps.messages as unknown[])[0],
        );
        (selectorProps.onClose as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.promptProps.at(-1)).toEqual(
          expect.objectContaining({
            input: "revise this",
          }),
        );
      },
    );
  });

  test("installs compact progress controls and restores them on unmount", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession() as AgenCBridgeSession & {
      setStreamMode?: (mode: "requesting" | "responding" | null) => void;
      setResponseLength?: (updater: (length: number) => number) => void;
      onCompactProgress?: (event: unknown) => void;
      setSDKStatus?: (status: "compacting" | null) => void;
    };
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async ({ output }) => {
        expect(providerProbe.costSummaryGetters.at(-1)).toBe(
          providerProbe.fpsGetters.at(-1),
        );
        expect(session.setStreamMode).toEqual(expect.any(Function));
        expect(session.setResponseLength).toEqual(expect.any(Function));
        expect(session.onCompactProgress).toEqual(expect.any(Function));
        expect(session.setSDKStatus).toEqual(expect.any(Function));

        session.onCompactProgress?.({ type: "compact_start" });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(output()).toMatch(/Compacting[\s\S]*conversation/);

        session.setResponseLength?.((length) => length + 8);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(output()).toMatch(/8[\s\S]*chars/);

        session.onCompactProgress?.({ type: "compact_end" });
        session.setSDKStatus?.(null);
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    );

    expect(session.setStreamMode).toBeUndefined();
    expect(session.setResponseLength).toBeUndefined();
    expect(session.onCompactProgress).toBeUndefined();
    expect(session.setSDKStatus).toBeUndefined();
  });

  test("routes exit through worktree ExitFlow only for active worktree sessions", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    resetShellSurfaceProbe();
    mockWorktreeSession = { worktreePath: "/tmp/worktree" };

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.onExit as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.inkExit).not.toHaveBeenCalled();
        expect(providerProbe.exitFlowProps.at(-1)).toEqual(
          expect.objectContaining({
            showWorktree: true,
            onDone: expect.any(Function),
            onCancel: expect.any(Function),
          }),
        );

        (providerProbe.exitFlowProps.at(-1)!.onCancel as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    );

    resetShellSurfaceProbe();
    await withRenderedApp(
      <AgenCTuiApp
        session={createSession()}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.onExit as () => void)();
        expect(providerProbe.inkExit).toHaveBeenCalledTimes(1);
        expect(providerProbe.exitFlowProps).toHaveLength(0);
      },
    );
  });

  test("renders and acknowledges the cost threshold dialog when billing access is available", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    resetShellSurfaceProbe();
    mockTotalCost = 5;
    mockHasConsoleBillingAccess = true;

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async ({ output }) => {
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(output()).toMatch(/cost-[\s\S]*hreshold-dialog/);
        expect(providerProbe.costThresholdDialogProps.at(-1)).toEqual(
          expect.objectContaining({
            onDone: expect.any(Function),
          }),
        );
        expect(providerProbe.logEvent).toHaveBeenCalledWith(
          "tengu_cost_threshold_reached",
          {},
        );

        (providerProbe.costThresholdDialogProps.at(-1)!.onDone as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(mockGlobalConfig.hasAcknowledgedCostThreshold).toBe(true);
        expect(providerProbe.logEvent).toHaveBeenCalledWith(
          "tengu_cost_threshold_acknowledged",
          {},
        );
      },
    );
  });

  test("marks the cost threshold as shown without rendering when billing access is unavailable", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    resetShellSurfaceProbe();
    mockTotalCost = 5;
    mockHasConsoleBillingAccess = false;

    await withRenderedApp(
      <AgenCTuiApp
        session={createSession()}
        configStore={{}}
        isInteractive={false}
      />,
      async ({ output }) => {
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(output()).not.toContain("cost-threshold-dialog");
        expect(providerProbe.costThresholdDialogProps).toHaveLength(0);
        expect(providerProbe.logEvent).toHaveBeenCalledWith(
          "tengu_cost_threshold_reached",
          {},
        );
      },
    );
  });

  test("wires MessageSelector code restore, conversation rewind, and partial summarize", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      clearDaemonSession: vi.fn(async () => {}),
      emitPhaseEvent: vi.fn(),
      rewindConversationToMessage: vi.fn(async () => ({
        ok: true,
        sessionId: "conversation-app-smoke",
        eventAlreadyEmitted: false,
        event: {
          id: "history-rewound-test",
          type: "history_replaced",
          acceptedAt: "2026-05-07T00:00:00.000Z",
          payload: {
            reason: "rewind",
            messages: [],
          },
        },
        displayText: "Conversation rewound",
      })),
      partialCompactFromMessage: vi.fn(async () => ({
        ok: true,
        sessionId: "conversation-app-smoke",
        eventAlreadyEmitted: false,
        event: {
          id: "history-replaced-test",
          type: "history_replaced",
          acceptedAt: "2026-05-07T00:00:00.000Z",
          payload: {
            reason: "partial_compact",
            messages: [],
          },
        },
        displayText: "Conversation summarized",
      })),
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
        initialUserMessages={[{ role: "user", content: "summarize this" }]}
      />,
      async ({ output }) => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.onMessageActionsEnter as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        const selectorProps = providerProbe.messageSelectorProps.at(-1)!;
        await (selectorProps.onRestoreCode as (message: unknown) => Promise<void>)({
          type: "user",
          uuid: "restore-code",
          message: { role: "user", content: "edit this" },
        });
        expect(providerProbe.fileHistoryRewind).toHaveBeenCalledWith(
          expect.any(Function),
          "restore-code",
        );

        const selectedMessage = (selectorProps.messages as unknown[])[0]!;
        await (selectorProps.onRestoreMessage as (
          message: unknown,
        ) => Promise<void>)(selectedMessage);
        await (selectorProps.onSummarize as (
          message: unknown,
          feedback?: string,
          direction?: "from" | "up_to",
        ) => Promise<void>)(selectedMessage, "keep decisions", "from");
        (selectorProps.onClose as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(session.rewindConversationToMessage).toHaveBeenCalledWith({
          messageOrdinal: 0,
        });
        expect(session.partialCompactFromMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            messageOrdinal: 0,
            direction: "from",
            feedback: "keep decisions",
            signal: expect.any(AbortSignal),
          }),
        );
        expect(session.emitPhaseEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "history_replaced",
          }),
        );
        expect(session.clearDaemonSession).not.toHaveBeenCalled();
        expect(providerProbe.promptProps.at(-1)).toEqual(
          expect.objectContaining({
            input: "summarize this",
          }),
        );
        expect(output()).toMatch(/Conversation[\s\S]*summarized/);
      },
    );
  });

  test("blocks MessageSelector conversation actions while a turn is active", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      activeTurn: {
        unsafePeek: () => ({ turnId: "active-turn" }),
      },
      rewindConversationToMessage: vi.fn(async () => ({
        ok: true,
        sessionId: "conversation-app-smoke",
        eventAlreadyEmitted: true,
      })),
      partialCompactFromMessage: vi.fn(async () => ({
        ok: true,
        sessionId: "conversation-app-smoke",
        eventAlreadyEmitted: true,
        displayText: "Conversation summarized",
      })),
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
        initialUserMessages={[{ role: "user", content: "busy turn" }]}
      />,
      async ({ output }) => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.onMessageActionsEnter as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        const selectorProps = providerProbe.messageSelectorProps.at(-1)!;
        const selectedMessage = (selectorProps.messages as unknown[])[0]!;
        await expect(
          (selectorProps.onRestoreMessage as (
            message: unknown,
          ) => Promise<void>)(selectedMessage),
        ).rejects.toThrow(/current turn/);
        await expect(
          (selectorProps.onSummarize as (
            message: unknown,
            feedback?: string,
            direction?: "from" | "up_to",
          ) => Promise<void>)(selectedMessage, undefined, "up_to"),
        ).rejects.toThrow(/current turn/);
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(session.rewindConversationToMessage).not.toHaveBeenCalled();
        expect(session.partialCompactFromMessage).not.toHaveBeenCalled();
        expect(output()).toMatch(/current[\s\S]*turn[\s\S]*finishes/);
      },
    );
  });

  test("renders first-run onboarding before the normal transcript when enabled", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    try {
      const output = await renderApp(
        <AgenCTuiApp
          session={session}
          isInteractive={true}
          configStore={{
            agencHome,
            current: () => defaultConfig(),
          }}
        />,
      );

      expect(output).toContain("Welcome");
      expect(output).toContain("AgenC");
      expect(output).toContain("Preflight");
      expect(output).not.toContain("messages:0");
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("suppresses first-run onboarding in noninteractive renders", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    try {
      const output = await renderApp(
        <AgenCTuiApp
          session={session}
          isInteractive={false}
          configStore={{
            agencHome,
            current: () => defaultConfig(),
          }}
        />,
      );

      expect(output).toContain("messages:0");
      expect(output).not.toContain("Preflight");
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("routes realtime composer commands before ordinary session submit", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const realtime = createRealtimeControls();
    const submit = vi.fn(async () => {});
    const session = {
      ...createSession(),
      realtime,
      submit,
    };
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    providerProbe.promptSubmits.length = 0;

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        const onSubmit = providerProbe.promptSubmits.at(-1);
        expect(onSubmit).toBeDefined();

        await onSubmit!("/realtime webrtc", helpers);

        expect(realtime.start).toHaveBeenCalledWith({ transport: "webrtc" });
        expect(submit).not.toHaveBeenCalled();
        expect(helpers.clearBuffer).toHaveBeenCalledTimes(1);
        expect(helpers.resetHistory).toHaveBeenCalledTimes(1);
        expect(helpers.setCursorOffset).toHaveBeenCalledWith(0);

        await onSubmit!("ordinary message", helpers);

        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit).toHaveBeenCalledWith("ordinary message", {
          displayUserMessage: "ordinary message",
        });
      },
    );
  });

  test("queues prompt submissions visibly while the live session is busy", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { getCommandQueue, resetCommandQueue } = await import("../../utils/messageQueueManager.js");
    const submit = vi.fn(async () => {});
    const session = {
      ...createSession(),
      activeTurn: {
        unsafePeek: () => ({ turnId: "busy-turn" }),
      },
      submit,
    };
    const queuedHelpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    resetShellSurfaceProbe();
    resetCommandQueue();

    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          configStore={{}}
          isInteractive={false}
        />,
        async () => {
          const onSubmit = providerProbe.promptSubmits.at(-1);
          expect(onSubmit).toBeDefined();

          await new Promise((resolve) => setTimeout(resolve, 25));

          expect(providerProbe.promptProps.at(-1)?.isLoading).toBe(true);

          await onSubmit!("queued message", queuedHelpers);

          expect(submit).not.toHaveBeenCalled();
          expect(getCommandQueue()).toMatchObject([
            { value: "queued message", mode: "prompt" },
          ]);
          expect(queuedHelpers.clearBuffer).toHaveBeenCalledTimes(1);
          expect(queuedHelpers.resetHistory).toHaveBeenCalledTimes(1);
          expect(queuedHelpers.setCursorOffset).toHaveBeenCalledWith(0);
        },
      );
    } finally {
      resetCommandQueue();
    }
  });

  test("queues image-only submissions while the live session is busy", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { getCommandQueue, resetCommandQueue } = await import("../../utils/messageQueueManager.js");
    const submit = vi.fn(async () => {});
    const session = {
      ...createSession(),
      activeTurn: {
        unsafePeek: () => ({ turnId: "busy-turn" }),
      },
      submit,
    };
    const queuedHelpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    resetShellSurfaceProbe();
    resetCommandQueue();

    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          configStore={{}}
          isInteractive={false}
        />,
        async () => {
          const promptProps = providerProbe.promptProps.at(-1)!;
          (promptProps.setPastedContents as (next: Record<number, unknown>) => void)({
            0: {
              id: 0,
              type: "image",
              content: "base64-image",
              mediaType: "image/png",
              filename: "pasted.png",
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 25));

          const onSubmit = providerProbe.promptSubmits.at(-1);
          expect(onSubmit).toBeDefined();
          await onSubmit!("", queuedHelpers);

          expect(submit).not.toHaveBeenCalled();
          expect(getCommandQueue()).toMatchObject([
            {
              value: "",
              mode: "prompt",
              pastedContents: {
                0: expect.objectContaining({ type: "image" }),
              },
            },
          ]);
          expect(queuedHelpers.clearBuffer).toHaveBeenCalledTimes(1);
          expect(queuedHelpers.resetHistory).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      resetCommandQueue();
    }
  });

  test("drains queued bash commands without forwarding them to the model", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { enqueue, getCommandQueue, resetCommandQueue } = await import("../../utils/messageQueueManager.js");
    const submit = vi.fn(async () => {});
    const emit = vi.fn();
    let id = 0;
    const session = {
      ...createSession(),
      submit,
      emit,
      nextInternalSubId: () => `bash-id-${++id}`,
    };
    resetShellSurfaceProbe();
    resetCommandQueue();
    providerProbe.processBashCommand.mockResolvedValueOnce({
      messages: [
        {
          type: "user",
          message: {
            content: "<bash-stdout>queued ok</bash-stdout><bash-stderr></bash-stderr>",
          },
        },
      ],
      shouldQuery: false,
    });
    enqueue({
      value: "echo queued",
      preExpansionValue: "!echo queued",
      mode: "bash",
    });

    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          configStore={{}}
          isInteractive={false}
        />,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 75));

          expect(providerProbe.processBashCommand).toHaveBeenCalledWith(
            "echo queued",
            [],
            [],
            expect.any(Object),
            expect.any(Function),
          );
          expect(submit).not.toHaveBeenCalled();
          expect(getCommandQueue()).toEqual([]);
          expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({
              msg: expect.objectContaining({
                type: "user_message",
                payload: expect.objectContaining({
                  message: "<bash-input>echo queued</bash-input>",
                }),
              }),
            }),
          );
          expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({
              msg: expect.objectContaining({
                type: "user_message",
                payload: expect.objectContaining({
                  message: "<bash-stdout>queued ok</bash-stdout><bash-stderr></bash-stderr>",
                }),
              }),
            }),
          );
        },
      );
    } finally {
      resetCommandQueue();
    }
  });

  test("queues slash command prompt results for next-turn drain", async () => {
    const { enqueueSlashPromptResult } = await import("./App.js");
    const { getCommandQueue, resetCommandQueue } = await import("../../utils/messageQueueManager.js");
    const scheduleQueueDrain = vi.fn();
    resetCommandQueue();

    try {
      expect(
        enqueueSlashPromptResult(
          "review queued prompt result",
          scheduleQueueDrain,
        ),
      ).toBe(true);

      expect(getCommandQueue()).toMatchObject([
        {
          value: "review queued prompt result",
          preExpansionValue: "review queued prompt result",
          mode: "prompt",
        },
      ]);
      expect(scheduleQueueDrain).toHaveBeenCalledTimes(1);
    } finally {
      resetCommandQueue();
    }
  });

  test("skips first-run onboarding after completion is persisted", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    try {
      markFirstRunOnboardingComplete({
        agencHome,
        selectedProvider: "grok",
        selectedModel: "grok-4-fast",
        selectedTheme: "dark",
        completedStepIds: ["terminal-setup"],
      });
      const output = await renderApp(
        <AgenCTuiApp
          session={session}
          isInteractive={true}
          configStore={{
            agencHome,
            current: () => defaultConfig(),
          }}
        />,
      );

      expect(output).toContain("messages:0");
      expect(output).not.toContain("Welcome to AgenC");
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("routes composer submissions through onboarding and stages provider switch on completion", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      setPendingProviderSwitch: vi.fn(),
    };
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    providerProbe.promptSubmits.length = 0;
    try {
      const helpers = {
        clearBuffer: vi.fn(),
        resetHistory: vi.fn(),
        setCursorOffset: vi.fn(),
      };
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          isInteractive={true}
          configStore={{
            agencHome,
            current: () => defaultConfig(),
          }}
        />,
        async ({ output }) => {
          const submit = async (value: string): Promise<void> => {
            const onSubmit = providerProbe.promptSubmits.at(-1);
            expect(onSubmit).toBeDefined();
            await onSubmit!(value, helpers);
            await new Promise((resolve) => setTimeout(resolve, 25));
          };

          expect(output()).toContain("Preflight");
          await submit("summarize this repository");
          expect(output()).toContain("Preflight");
          expect(session.setPendingProviderSwitch).not.toHaveBeenCalled();
          await submit("next");
          await submit("1");
          await submit("2");
          await submit("test");
          await submit("next");
          await submit("next");
          await submit("done");

          expect(session.setPendingProviderSwitch).toHaveBeenLastCalledWith({
            provider: "openai",
            model: "gpt-5",
          });
          expect(readOnboardingState({ agencHome }).completed).toBe(true);
          expect(output()).toContain("messages:0");
        },
      );
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("routes BYOK key approval through the real first-run TUI submission path", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { LocalAuthBackend } = await import("../../auth/backends/local.js");
    const session = {
      ...createSession(),
      setPendingProviderSwitch: vi.fn(),
    };
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    providerProbe.promptSubmits.length = 0;
    try {
      const helpers = {
        clearBuffer: vi.fn(),
        resetHistory: vi.fn(),
        setCursorOffset: vi.fn(),
      };
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          isInteractive={true}
          configStore={{
            agencHome,
            current: () => defaultConfig(),
          }}
        />,
        async ({ output }) => {
          const submit = async (value: string): Promise<void> => {
            const onSubmit = providerProbe.promptSubmits.at(-1);
            expect(onSubmit).toBeDefined();
            await onSubmit!(value, helpers);
            await new Promise((resolve) => setTimeout(resolve, 25));
          };

          await submit("next");
          await submit("1");
          await submit("1");
          await submit("test");
          await submit("xai-app-key");

          expect(output()).toContain("Approve BYOK API key");
          expect(output()).toContain("...-key");
          expect(output()).not.toContain("xai-app-key");

          await submit("yes");
          await expect(
            new LocalAuthBackend({ agencHome }).readByokKey("grok"),
          ).resolves.toBe("xai-app-key");
        },
      );
    } finally {
      fetchSpy.mockRestore();
      rmSync(agencHome, { recursive: true, force: true });
    }
  });
});

function createRendererSession(): Parameters<typeof installElicitationResolvers>[0] {
  return { services: {} } as Parameters<typeof installElicitationResolvers>[0];
}

function userRequest(callId: string): RequestUserInputEvent {
  return {
    requestId: callId,
    callId,
    turnId: "turn-1",
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Pick one",
        options: [
          { label: "Yes", description: "Accept" },
          { label: "No", description: "Decline" },
        ],
      },
    ],
  };
}

function formPending(
  schema: McpPrimitiveSchemaDefinition,
  resolve = vi.fn(),
): McpFormPending {
  return {
    kind: "mcp-form",
    request: {
      turnId: "turn-1",
      serverName: "srv",
      requestId: "request-1",
      request: {
        mode: "form",
        message: "Provide value",
        requestedSchema: {
          type: "object",
          properties: { value: schema },
        },
      },
    },
    resolve,
    fields: ["value"],
    content: {},
    index: 0,
  };
}

function mcpFormRequest(callId: string): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "srv",
    requestId: callId,
    request: {
      mode: "form",
      message: "Provide value",
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  };
}

function expectInvalidFormValue(
  schema: McpPrimitiveSchemaDefinition,
  raw: string,
  expectedMessage: string,
): void {
  const resolve = vi.fn();
  const next = settlePendingOnSubmit(formPending(schema, resolve), raw);

  expect(resolve).not.toHaveBeenCalled();
  expect(next).not.toBeNull();
  expect(next?.kind).toBe("mcp-form");
  expect((next as McpFormPending).index).toBe(0);
  expect((next as McpFormPending).content).toEqual({});
  expect((next as McpFormPending).error).toContain(expectedMessage);
}

describeWithVitestMocks("elicitation TUI renderer", () => {
  test("queues resolver requests that arrive before the first submit", async () => {
    const session = createRendererSession();
    const prompted: (PendingElicitation | null)[] = [];
    const controller = installElicitationResolvers(
      session,
      (pending) => prompted.push(pending),
    );

    const first = session.services.requestUserInputResolver!.request(userRequest("first"));
    const second = session.services.requestUserInputResolver!.request(userRequest("second"));

    expect(prompted.at(-1)?.kind).toBe("user");
    expect((prompted.at(-1) as PendingElicitation & { kind: "user" }).request.callId)
      .toBe("first");

    expect(controller.submit("2")).toBe(true);
    await expect(first).resolves.toEqual({
      answers: { choice: { answers: ["No"] } },
    });
    expect(prompted.at(-1)?.kind).toBe("user");
    expect((prompted.at(-1) as PendingElicitation & { kind: "user" }).request.callId)
      .toBe("second");

    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    expect(controller.submit("Yes")).toBe(true);
    await expect(second).resolves.toEqual({
      answers: { choice: { answers: ["Yes"] } },
    });
    controller.cleanup();
  });

  test("cleanup cancels unresolved user-input resolver requests", async () => {
    const session = createRendererSession();
    const controller = installElicitationResolvers(session, () => {});
    const pending = session.services.requestUserInputResolver!.request(
      userRequest("cancelled"),
    );

    controller.cleanup();

    await expect(pending).resolves.toBeNull();
  });

  test("aborts unresolved direct user-input resolver requests", async () => {
    const session = createRendererSession();
    const prompted: (PendingElicitation | null)[] = [];
    const controller = installElicitationResolvers(
      session,
      (pending) => prompted.push(pending),
    );
    const abort = new AbortController();

    const pending = session.services.requestUserInputResolver!.request(
      userRequest("aborted"),
      abort.signal,
    );
    expect(prompted.at(-1)?.kind).toBe("user");

    abort.abort();

    await expect(pending).resolves.toBeNull();
    expect(prompted.at(-1)).toBeNull();
    controller.cleanup();
  });

  test("removes direct user-input abort listeners after normal completion", async () => {
    const session = createRendererSession();
    const listeners = new Set<() => void>();
    const signal = {
      aborted: false,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        listeners.add(listener);
      }),
      removeEventListener: vi.fn((_event: string, listener: () => void) => {
        listeners.delete(listener);
      }),
    } as unknown as AbortSignal;
    const controller = installElicitationResolvers(session, () => {});

    const pending = session.services.requestUserInputResolver!.request(
      userRequest("settled"),
      signal,
    );
    expect(listeners.size).toBe(1);

    expect(controller.submit("done")).toBe(true);

    await expect(pending).resolves.toEqual({
      answers: {
        choice: { answers: ["done"] },
      },
    });
    expect(signal.removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
    expect(listeners.size).toBe(0);
    controller.cleanup();
  });

  test("aborts unresolved direct MCP resolver requests", async () => {
    const session = createRendererSession();
    const prompted: (PendingElicitation | null)[] = [];
    const controller = installElicitationResolvers(
      session,
      (pending) => prompted.push(pending),
    );
    const abort = new AbortController();

    const pending = session.services.mcpElicitationResolver!.request(
      mcpFormRequest("aborted"),
      abort.signal,
    );
    expect(prompted.at(-1)?.kind).toBe("mcp-form");

    abort.abort();

    await expect(pending).resolves.toBeNull();
    expect(prompted.at(-1)).toBeNull();
    controller.cleanup();
  });

  test("rejects invalid boolean MCP form input", () => {
    expectInvalidFormValue({ type: "boolean" }, "sometimes", "true or false");
  });

  test("rejects non-integral integer MCP form input", () => {
    expectInvalidFormValue({ type: "integer" }, "1.5", "integer");
  });

  test("rejects string MCP form input outside enum values", () => {
    expectInvalidFormValue(
      { type: "string", enum: ["red", "blue"] },
      "green",
      "one of",
    );
  });

  test("accepts string MCP form input from titled enum values", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(
      formPending({
        type: "string",
        oneOf: [
          { const: "red", title: "Red" },
          { const: "blue", title: "Blue" },
        ],
      }, resolve),
      "red",
    );

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { value: "red" },
    });
    expectInvalidFormValue(
      {
        type: "string",
        oneOf: [
          { const: "red", title: "Red" },
          { const: "blue", title: "Blue" },
        ],
      },
      "green",
      "one of",
    );
  });

  test("rejects array MCP form input outside item enum values", () => {
    expectInvalidFormValue(
      {
        type: "array",
        items: { type: "string", enum: ["read", "write"] },
        minItems: 1,
      },
      "read, delete",
      "delete",
    );
  });

  test("accepts array MCP form input from titled enum values", () => {
    const resolve = vi.fn();
    const schema: McpPrimitiveSchemaDefinition = {
      type: "array",
      items: {
        anyOf: [
          { const: "read", title: "Read" },
          { const: "write", title: "Write" },
        ],
      },
      minItems: 1,
    };

    const next = settlePendingOnSubmit(formPending(schema, resolve), "read, write");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { value: ["read", "write"] },
    });
    expectInvalidFormValue(schema, "read, delete", "delete");
  });

  test("omits blank optional string MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "string" }, resolve), "");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("omits blank optional number MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "number" }, resolve), "");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("omits blank optional boolean MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "boolean" }, resolve), "");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("accepts valid MCP form input with collected content", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "string" }, resolve), "done");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { value: "done" },
    });
  });

  test("declines MCP URL prompts when requested", () => {
    const resolve = vi.fn();
    const pending: McpUrlPending = {
      kind: "mcp-url",
      request: {
        turnId: "turn-1",
        serverName: "srv",
        requestId: "request-1",
        request: {
          mode: "url",
          message: "Authorize",
          elicitationId: "url-1",
          url: "https://127.0.0.1/auth",
        },
      },
      resolve,
    };

    expect(settlePendingOnSubmit(pending, "decline")).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "decline" });
  });

  test("cancels MCP form prompts when requested", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "string" }, resolve), "cancel");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "cancel" });
  });
});
