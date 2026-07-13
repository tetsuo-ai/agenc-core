import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const mockTuiCommandList = vi.hoisted(() => [] as Array<Record<string, any>>);
const fullscreenProbe = vi.hoisted(() => ({
  fullscreen: false,
  mouseTracking: false,
}));
const apiKeyVerificationProbe = vi.hoisted(() => ({
  reverify: vi.fn(async () => {}),
  status: "valid" as "loading" | "valid" | "invalid" | "missing" | "error",
}));

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
  fullscreenLayoutProps: [] as Array<Record<string, React.ReactNode>>,
  scrollKeybindingProps: [] as Array<Record<string, unknown>>,
  workbenchLayoutProps: [] as Array<Record<string, React.ReactNode>>,
  spinnerProps: [] as Array<Record<string, unknown>>,
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
  fileHistoryRewind: typeof vi.fn === "function" ? vi.fn() : () => {},
  historyEntries: [] as unknown[],
};

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: () => {},
}));

vi.mock("src/utils/envUtils.js", () => ({
  isEnvTruthy: () => false,
  isBareMode: () => false,
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

vi.mock("../history/history.js", () => ({
  addToHistory: (entry: unknown) => {
    providerProbe.historyEntries.push(entry);
  },
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

vi.mock("../hooks/useApiKeyVerification.js", () => ({
  useApiKeyVerification: () => ({
    error: null,
    reverify: apiKeyVerificationProbe.reverify,
    status: apiKeyVerificationProbe.status,
  }),
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
  parseToolListFromCLI: (tools: string[] = []) => tools,
}));

vi.mock("../../utils/settings/applySettingsChange.js", () => ({
  applySettingsChange: () => {},
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
  getSettingsForSource: () => null,
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
  isBareMode: () => false,
}));

vi.mock("../../utils/fullscreen.js", () => ({
  isFullscreenEnvEnabled: () => fullscreenProbe.fullscreen,
  isMouseClicksDisabled: () => true,
  isMouseTrackingEnabled: () => fullscreenProbe.mouseTracking,
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
  findCommand: (name: string, commands: Array<Record<string, any>> = mockTuiCommandList) =>
    commands.find((command) => command.name === name || command.aliases?.includes(name)) ?? null,
  listTuiCommandList: () => mockTuiCommandList,
}));

vi.mock("../../agents/role-definitions.js", () => ({
  listAgentRoleDefinitions: () => [
    {
      agentType: "default",
      whenToUse: "Default agent.",
      source: "built-in",
      baseDir: "built-in",
      getSystemPrompt: () => "",
    },
    {
      agentType: "explorer",
      whenToUse: "Explore code.",
      source: "built-in",
      baseDir: "built-in",
      getSystemPrompt: () => "",
    },
    {
      agentType: "worker",
      whenToUse: "Execute work.",
      source: "built-in",
      baseDir: "built-in",
      getSystemPrompt: () => "",
    },
  ],
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

vi.mock("./FullscreenLayout.js", async () => {
  const React = await import("react");
  return {
    FullscreenLayout: (props: {
      scrollable?: React.ReactNode;
      bottom?: React.ReactNode;
      overlay?: React.ReactNode;
      modal?: React.ReactNode;
    }) => {
      providerProbe.fullscreenLayoutProps.push(props);
      return React.createElement(
        React.Fragment,
        null,
        props.scrollable,
        props.bottom,
        props.overlay,
        props.modal,
      );
    },
  };
});

vi.mock("./ScrollKeybindingHandler.js", async () => {
  const React = await import("react");
  return {
    ScrollKeybindingHandler: (props: Record<string, unknown>) => {
      providerProbe.scrollKeybindingProps.push(props);
      return React.createElement(React.Fragment, null);
    },
  };
});

vi.mock("../workbench/WorkbenchLayout.js", async () => {
  const React = await import("react");
  return {
    WorkbenchLayout: (props: {
      transcript?: React.ReactNode;
      composer?: React.ReactNode;
      overlay?: React.ReactNode;
      modal?: React.ReactNode;
    } & Record<string, unknown>) => {
      providerProbe.workbenchLayoutProps.push(props);
      return React.createElement(
        React.Fragment,
        null,
        props.transcript,
        props.composer,
        props.overlay,
        props.modal,
      );
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
      commands,
      getToolUseContext,
      onInputChange,
      isLoading,
      isLocalJSXCommandActive,
      apiKeyStatus,
      pastedContents,
      setPastedContents,
      mode,
      onModeChange,
      setToolPermissionContext,
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
      commands?: unknown;
      getToolUseContext?: unknown;
      onInputChange?: (input: string) => void;
      isLoading?: boolean;
      isLocalJSXCommandActive?: boolean;
      apiKeyStatus?: unknown;
      pastedContents?: unknown;
      setPastedContents?: unknown;
      mode?: unknown;
      onModeChange?: unknown;
      setToolPermissionContext?: unknown;
    }) => {
      providerProbe.promptSubmits.push(onSubmit);
      providerProbe.promptProps.push({
        input,
        onSubmit,
        onShowMessageSelector,
        onMessageActionsEnter,
        onExit,
        vimMode,
        setVimMode,
        mcpClients,
        commands,
        getToolUseContext,
        onInputChange,
        isLoading,
        isLocalJSXCommandActive,
        apiKeyStatus,
        pastedContents,
        setPastedContents,
        mode,
        onModeChange,
        setToolPermissionContext,
      });
      return React.createElement("ink-text", null, `prompt:${input}`);
    },
  };
});

vi.mock("./spinner/Spinner.js", async () => {
  const React = await import("react");
  return {
    SpinnerWithVerb: (props: Record<string, unknown>) => {
      providerProbe.spinnerProps.push(props);
      return React.createElement(
        "ink-text",
        null,
        `spinner:${String(props.mode)}:${String(props.overrideMessage ?? "")}`,
      );
    },
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
  providerProbe.fullscreenLayoutProps.length = 0;
  providerProbe.scrollKeybindingProps.length = 0;
  providerProbe.workbenchLayoutProps.length = 0;
  providerProbe.spinnerProps.length = 0;
  providerProbe.promptProps.length = 0;
  providerProbe.promptSubmits.length = 0;
  providerProbe.inkExit.mockClear?.();
  providerProbe.fileHistoryRewind.mockReset?.();
  providerProbe.processBashCommand.mockClear?.();
  providerProbe.historyEntries.length = 0;
  mockTuiCommandList.length = 0;
  mockTotalCost = 0;
  mockHasConsoleBillingAccess = false;
  mockWorktreeSession = null;
  mockGlobalConfig = {};
  fullscreenProbe.fullscreen = false;
  fullscreenProbe.mouseTracking = false;
  delete process.env.AGENC_TUI_WORKBENCH;
}

function containsElementNamed(node: React.ReactNode, name: string): boolean {
  if (node === null || node === undefined || typeof node === "boolean") return false;
  if (Array.isArray(node)) {
    return node.some((child) => containsElementNamed(child, name));
  }
  if (!React.isValidElement(node)) return false;
  const type = node.type as { displayName?: string; name?: string } | string;
  if (typeof type !== "string" && (type.displayName === name || type.name === name)) {
    return true;
  }
  return containsElementNamed(
    (node.props as { readonly children?: React.ReactNode }).children,
    name,
  );
}

let installElicitationResolvers: any;
let settlePendingOnSubmit: any;
let visibleCancelStreamMode: any;
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
  visibleCancelStreamMode = app.visibleCancelStreamMode;
}, 30_000);

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

function createSession(opts: {
  readonly permissionContext?: ToolPermissionContext;
  readonly updatePermissionContext?: (next: ToolPermissionContext) => Promise<void> | void;
  readonly setDaemonPermissionMode?: (mode: ToolPermissionContext["mode"]) => Promise<unknown>;
  readonly emit?: AgenCBridgeSession["emit"];
  readonly nextInternalSubId?: AgenCBridgeSession["nextInternalSubId"];
} = {}): AgenCBridgeSession {
  const modeSubscribers: Array<() => void> = [];
  const permissionContext = opts.permissionContext ?? PERMISSION_CONTEXT;
  return {
    conversationId: "conversation-app-smoke",
    services: {
      permissionModeRegistry: {
        current: () => permissionContext,
        ...(opts.updatePermissionContext !== undefined
          ? { update: opts.updatePermissionContext }
          : {}),
        subscribeToModeChange: (cb) => {
          modeSubscribers.push(cb);
          return () => {
            const index = modeSubscribers.indexOf(cb);
            if (index !== -1) modeSubscribers.splice(index, 1);
          };
        },
      },
    },
    ...(opts.setDaemonPermissionMode !== undefined
      ? { setDaemonPermissionMode: opts.setDaemonPermissionMode }
      : {}),
    ...(opts.emit !== undefined ? { emit: opts.emit } : {}),
    ...(opts.nextInternalSubId !== undefined
      ? { nextInternalSubId: opts.nextInternalSubId }
      : {}),
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
  test("terminal title prefix honors ASCII glyph mode", async () => {
    const { animatedTerminalTitlePrefix } = await import("./App.js");

    expect(animatedTerminalTitlePrefix(false, 0, {})).toBe("✳");
    expect(animatedTerminalTitlePrefix(true, 1, {})).toBe("⠐");
    expect(animatedTerminalTitlePrefix(false, 0, { AGENC_TUI_GLYPHS: "ascii" })).toBe("*");
    expect(animatedTerminalTitlePrefix(true, 1, { AGENC_TUI_GLYPHS: "ascii" })).toBe("+");
  });

  test("cancel stream mode follows the visible spinner mode", () => {
    for (const mode of [
      "requesting",
      "responding",
      "thinking",
      "tool-use",
      "tool-input",
    ]) {
      expect(visibleCancelStreamMode(true, mode)).toBe(mode);
      expect(visibleCancelStreamMode(false, mode)).toBeUndefined();
    }
  });

  test("formats render health warnings only for sustained low FPS", async () => {
    const { formatRenderHealthWarning } = await import("./App.js");

    expect(formatRenderHealthWarning(undefined)).toBeNull();
    expect(
      formatRenderHealthWarning({
        averageFps: Number.NaN,
        low1PctFps: Number.POSITIVE_INFINITY,
        sampleCount: 10,
      }),
    ).toBe("Render health: average 0.0 FPS, 1% low 0.0 FPS");
    expect(
      formatRenderHealthWarning({
        averageFps: 8,
        low1PctFps: 2,
        sampleCount: 9,
      }),
    ).toBeNull();
    expect(
      formatRenderHealthWarning({
        averageFps: 25,
        low1PctFps: 15,
        sampleCount: 20,
      }),
    ).toBeNull();
    expect(
      formatRenderHealthWarning({
        averageFps: 18.234,
        low1PctFps: 30,
        sampleCount: 20,
      }),
    ).toBe("Render health: average 18.2 FPS, 1% low 18.2 FPS");
  });

  test("formats stopped-agent notifications by count and description", async () => {
    const { formatAgentsKilledNotification } = await import("./App.js");

    expect(formatAgentsKilledNotification([])).toBeNull();
    expect(formatAgentsKilledNotification([{ taskId: "task-1" }])).toBe(
      "Stopped 1 background agent",
    );
    expect(
      formatAgentsKilledNotification([
        { taskId: "task-1" },
        { description: " " },
      ]),
    ).toBe("Stopped 2 background agents");
    expect(
      formatAgentsKilledNotification([{ description: "Fix tests" }]),
    ).toBe("Stopped background agent: Fix tests");
    expect(
      formatAgentsKilledNotification([
        { description: "Fix tests" },
        { description: "Review diff" },
      ]),
    ).toBe("Stopped 2 background agents: Fix tests, Review diff");
  });

  test("gates prompt input when another TUI surface owns input", async () => {
    const {
      shouldEnableTranscriptScrollKeybindings,
      shouldShowPromptInputState,
    } = await import("./App.js");

    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: false,
        permissionRequestCount: 0,
        hasElicitationPrompt: false,
        completionPipelineOwnsPrompt: false,
      }),
    ).toBe(true);
    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: true,
        permissionRequestCount: 0,
        hasElicitationPrompt: false,
        completionPipelineOwnsPrompt: false,
      }),
    ).toBe(false);
    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: false,
        permissionRequestCount: 1,
        hasElicitationPrompt: false,
        completionPipelineOwnsPrompt: false,
      }),
    ).toBe(false);
    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: false,
        permissionRequestCount: 0,
        hasElicitationPrompt: true,
        completionPipelineOwnsPrompt: false,
      }),
    ).toBe(false);
    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: false,
        permissionRequestCount: 0,
        hasElicitationPrompt: false,
        completionPipelineOwnsPrompt: true,
      }),
    ).toBe(false);
    expect(
      shouldShowPromptInputState({
        isMessageSelectorVisible: false,
        permissionRequestCount: 0,
        hasElicitationPrompt: false,
        completionPipelineOwnsPrompt: false,
        toolShouldHidePromptInput: true,
      }),
    ).toBe(false);

    expect(shouldEnableTranscriptScrollKeybindings({
      fullscreen: false,
      workbenchEnabled: false,
      permissionRequestCount: 0,
      modalVisible: false,
      activeSurfaceMode: "transcript",
    })).toBe(false);
    expect(shouldEnableTranscriptScrollKeybindings({
      fullscreen: true,
      workbenchEnabled: false,
      permissionRequestCount: 0,
      modalVisible: false,
      activeSurfaceMode: "preview",
    })).toBe(true);
    expect(shouldEnableTranscriptScrollKeybindings({
      fullscreen: true,
      workbenchEnabled: true,
      permissionRequestCount: 1,
      modalVisible: false,
      activeSurfaceMode: "transcript",
    })).toBe(false);
    expect(shouldEnableTranscriptScrollKeybindings({
      fullscreen: true,
      workbenchEnabled: true,
      permissionRequestCount: 0,
      modalVisible: true,
      activeSurfaceMode: "preview",
    })).toBe(true);
    expect(shouldEnableTranscriptScrollKeybindings({
      fullscreen: true,
      workbenchEnabled: true,
      permissionRequestCount: 0,
      modalVisible: false,
      activeSurfaceMode: "preview",
    })).toBe(false);
    expect(shouldEnableTranscriptScrollKeybindings({
      fullscreen: true,
      workbenchEnabled: true,
      permissionRequestCount: 0,
      modalVisible: false,
      activeSurfaceMode: "transcript",
    })).toBe(true);
  });

  test("parses MCP primitive field edge cases", async () => {
    const { parseMcpField } = await import("./App.js");

    expect(parseMcpField("", { type: "number" })).toEqual({
      ok: false,
      message: "must be a number",
    });
    expect(parseMcpField("abc", { type: "number" })).toEqual({
      ok: false,
      message: "must be a number",
    });
    expect(parseMcpField("0", { type: "number", minimum: 1 })).toEqual({
      ok: false,
      message: "must be at least 1",
    });
    expect(parseMcpField("3", { type: "number", maximum: 2 })).toEqual({
      ok: false,
      message: "must be at most 2",
    });
    expect(parseMcpField("2", { type: "integer" })).toEqual({
      ok: true,
      value: 2,
    });
    expect(parseMcpField("YES", { type: "boolean" })).toEqual({
      ok: true,
      value: true,
    });
    expect(parseMcpField("0", { type: "boolean" })).toEqual({
      ok: true,
      value: false,
    });
    expect(
      parseMcpField("one, one", {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
      }),
    ).toEqual({
      ok: false,
      message: "must not include duplicate values",
    });
    expect(
      parseMcpField("", {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      }),
    ).toEqual({
      ok: false,
      message: "must include at least 1 item(s)",
    });
    expect(
      parseMcpField("one, two, three", {
        type: "array",
        items: { type: "string" },
        maxItems: 2,
      }),
    ).toEqual({
      ok: false,
      message: "must include at most 2 item(s)",
    });
    expect(parseMcpField("fallback", undefined)).toEqual({
      ok: true,
      value: "fallback",
    });
  });

  test("renders elicitation overlays and null prompts", async () => {
    const { ElicitationOverlay } = await import("./App.js");

    expect(await renderApp(<ElicitationOverlay prompt={null} />)).not.toContain(
      "MCP:",
    );
    const output = await renderApp(
      <ElicitationOverlay
        prompt={{
          title: "MCP: files",
          message: "Authorize files",
          detailLines: ["https://127.0.0.1/auth", "Type decline to reject"],
          placeholder: "Enter to accept",
        }}
      />,
    );

    expect(output).toContain("MCP:");
    expect(output).toContain("files");
    expect(output).toContain("Authorize");
    expect(output).toContain("https://127.0.0.1/auth");
    expect(output).toContain("Enter");
    expect(output).toContain("accept");
  });

  test("subscribes to MCP URL completion events from session events", async () => {
    const { subscribeToMcpUrlCompletions } = await import("./App.js");
    let listener: ((event: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const completeMcpUrl = vi.fn();
    const session = {
      subscribeToEvents: vi.fn((callback: (event: unknown) => void) => {
        listener = callback;
        return unsubscribe;
      }),
    };

    const stop = subscribeToMcpUrlCompletions(session, { completeMcpUrl });

    listener?.(null);
    listener?.({ type: "other" });
    listener?.({
      type: "mcp_elicitation_complete",
      payload: { serverName: 1, elicitationId: "url-1" },
    });
    expect(completeMcpUrl).not.toHaveBeenCalled();

    listener?.({
      type: "mcp_elicitation_complete",
      payload: { serverName: "srv", elicitationId: "url-1" },
    });
    expect(completeMcpUrl).toHaveBeenCalledWith(
      "srv",
      "url-1",
      expect.objectContaining({ action: "accept" }),
    );

    listener?.({
      type: "mcp_elicitation_complete",
      payload: { serverName: "srv", elicitationId: 42 },
    });
    expect(completeMcpUrl).toHaveBeenCalledWith(
      "srv",
      42,
      expect.objectContaining({ action: "accept" }),
    );

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(
      subscribeToMcpUrlCompletions({}, { completeMcpUrl: vi.fn() }),
    ).toEqual(expect.any(Function));
  });

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

  test("syncs PromptInput permission mode changes through the daemon before the local shim", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const calls: string[] = [];
    const modeContext = {
      ...PERMISSION_CONTEXT,
      mode: "plan" as const,
    };
    const setDaemonPermissionMode = vi.fn(async (mode: ToolPermissionContext["mode"]) => {
      calls.push(`daemon:${mode}`);
      return { applied: true, previousMode: "default", mode };
    });
    const updatePermissionContext = vi.fn(async (next: ToolPermissionContext) => {
      calls.push(`local:${next.mode}`);
    });
    providerProbe.promptProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp
        session={createSession({
          updatePermissionContext,
          setDaemonPermissionMode,
        })}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.setToolPermissionContext as (next: ToolPermissionContext) => void)(
          modeContext,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    );

    expect(setDaemonPermissionMode).toHaveBeenCalledWith("plan");
    expect(updatePermissionContext).toHaveBeenCalledWith(modeContext);
    expect(calls).toEqual(["daemon:plan", "local:plan"]);
  });

  test("rolls PromptInput permission mode changes back when daemon sync fails", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const warningEvents: unknown[] = [];
    const setDaemonPermissionMode = vi.fn(async () => {
      throw new Error("daemon refused mode");
    });
    const updatePermissionContext = vi.fn();
    providerProbe.promptProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp
        session={createSession({
          updatePermissionContext,
          setDaemonPermissionMode,
          emit: (event) => {
            warningEvents.push(event);
          },
          nextInternalSubId: () => "permission-sync-warning",
        })}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.setToolPermissionContext as (next: ToolPermissionContext) => void)({
          ...PERMISSION_CONTEXT,
          mode: "plan",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    );

    expect(setDaemonPermissionMode).toHaveBeenCalledWith("plan");
    expect(updatePermissionContext).not.toHaveBeenCalled();
    expect(warningEvents).toContainEqual(
      expect.objectContaining({
        id: "permission-sync-warning",
        msg: expect.objectContaining({
          type: "warning",
          payload: expect.objectContaining({
            cause: "permission_mode_sync_failed",
          }),
        }),
      }),
    );
  });

  test("connects fullscreen workbench transcript to the scroll owner", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    resetShellSurfaceProbe();
    fullscreenProbe.fullscreen = true;
    process.env.AGENC_TUI_WORKBENCH = "1";

    await renderApp(
      <AgenCTuiApp
        session={createSession()}
        configStore={{}}
        isInteractive={false}
      />,
    );

    const messageScrollRef = providerProbe.messageProps.at(-1)?.scrollRef;
    const workbenchProps = providerProbe.workbenchLayoutProps.at(-1);
    const scrollProps = providerProbe.scrollKeybindingProps.at(-1);

    expect(messageScrollRef).toBeDefined();
    expect(workbenchProps).toEqual(
      expect.objectContaining({
        scrollRef: messageScrollRef,
        modalScrollRef: expect.any(Object),
      }),
    );
    expect(scrollProps).toEqual(
      expect.objectContaining({
        scrollRef: messageScrollRef,
        isActive: true,
        isModal: false,
      }),
    );
    expect(providerProbe.fullscreenLayoutProps).toHaveLength(0);
  });

  test("passes API key verification status into PromptInput and verifies on startup", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const previousStatus = apiKeyVerificationProbe.status;
    apiKeyVerificationProbe.status = "missing";
    apiKeyVerificationProbe.reverify.mockClear();
    providerProbe.promptProps.length = 0;

    try {
      await renderApp(
        <AgenCTuiApp
          session={createSession()}
          configStore={{}}
          isInteractive={false}
          initialComposerText="draft"
        />,
      );

      expect(providerProbe.promptProps.at(-1)).toEqual(
        expect.objectContaining({
          apiKeyStatus: "missing",
        }),
      );
      expect(apiKeyVerificationProbe.reverify).toHaveBeenCalledTimes(1);
    } finally {
      apiKeyVerificationProbe.status = previousStatus;
      apiKeyVerificationProbe.reverify.mockClear();
    }
  });

  test("hydrates the TUI app state with registered agent roles", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    providerProbe.appStateProps.length = 0;

    await renderApp(
      <AgenCTuiApp
        session={createSession()}
        configStore={{}}
        isInteractive={false}
      />,
    );

    const initial = providerProbe.appStateProps.at(-1)?.initialState as {
      agentDefinitions?: {
        activeAgents?: Array<{ agentType?: string }>;
        allAgents?: Array<{ agentType?: string }>;
      };
    };
    const active = initial.agentDefinitions?.activeAgents?.map(agent => agent.agentType);
    const all = initial.agentDefinitions?.allAgents?.map(agent => agent.agentType);

    expect(active).toEqual(expect.arrayContaining(["default", "explorer", "worker"]));
    expect(all).toEqual(expect.arrayContaining(["default", "explorer", "worker"]));
  });

  test("prioritizes a pending permission overlay over an elicitation overlay", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        expect(session.services.requestUserInputResolver).toBeDefined();
        expect(session.services.approvalResolver).toBeDefined();

        const elicitationAbort = new AbortController();
        const permissionAbort = new AbortController();
        const elicitation = session.services.requestUserInputResolver!.request(
          userRequest("ask-while-permission-pending"),
          elicitationAbort.signal,
        );
        const permission = session.services.approvalResolver!.request({
          callId: "permission-while-eliciting",
          toolName: "FileRead",
          turnId: "turn-1",
          signal: permissionAbort.signal,
          invocation: {
            session: {} as never,
            turn: {} as never,
            tracker: {
              appendFileDiff() {},
              snapshot: () => [],
              clear() {},
            },
            callId: "permission-while-eliciting",
            toolName: { name: "FileRead" },
            payload: {
              kind: "function",
              arguments: "{\"file_path\":\"README.md\"}",
            },
            source: "direct",
          },
        } as never);

        await new Promise((resolve) => setTimeout(resolve, 25));

        const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
        expect(layoutProps).toBeDefined();
        expect(containsElementNamed(layoutProps?.overlay, "AgenCPermissionOverlay")).toBe(true);
        expect(containsElementNamed(layoutProps?.overlay, "ElicitationOverlay")).toBe(false);

        permissionAbort.abort();
        elicitationAbort.abort();
        await expect(permission).resolves.toEqual({ kind: "abort" });
        await expect(elicitation).resolves.toBeNull();
      },
    );
  });

  test("does not show model spinner while a local slash command error is pending", async () => {
    const dispatcher = await import("../../commands/dispatcher.js");
    let resolveDispatch: (outcome: any) => void = () => {};
    const dispatchPromise = new Promise<any>((resolve) => {
      resolveDispatch = resolve;
    });
    const dispatchSpy = vi
      .spyOn(dispatcher, "dispatchSlashCommand")
      .mockReturnValue(dispatchPromise as never);
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      submit: vi.fn(async () => {}),
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

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

          const submitPromise = onSubmit!("/zzzzz", {
            clearBuffer: vi.fn(),
            resetHistory: vi.fn(),
            setCursorOffset: vi.fn(),
          });
          await new Promise((resolve) => setTimeout(resolve, 25));

          expect(dispatchSpy).toHaveBeenCalled();
          expect(providerProbe.promptProps.some(props => props.isLoading === true)).toBe(false);

          resolveDispatch({
            result: {
              kind: "error",
              message: "Unknown command: /zzzzz",
            },
            immediate: false,
            trace: {
              name: "zzzzz",
              aliasUsed: "zzzzz",
              argsRaw: "",
              sensitive: false,
              immediate: false,
              isMcp: false,
              resultKind: "error",
            },
          });
          await submitPromise;
          await new Promise((resolve) => setTimeout(resolve, 25));

          expect(session.submit).not.toHaveBeenCalled();
        },
      );
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  test("keeps dollar-prefixed local commands out of model submit", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    resetShellSurfaceProbe();
    mockTuiCommandList.push({
      name: "help",
      type: "local",
      load: vi.fn(),
    });
    const session = {
      ...createSession(),
      enqueueIdleInput: vi.fn(() => 1),
      submit: vi.fn(async () => {}),
    } satisfies AgenCBridgeSession;
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async ({ output }) => {
        const onSubmit = providerProbe.promptSubmits.at(-1);
        expect(onSubmit).toBeDefined();

        await onSubmit!("$help", helpers);
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(session.submit).not.toHaveBeenCalled();
        expect(session.enqueueIdleInput).not.toHaveBeenCalled();
        expect(output()).toContain("Use /help");
        expect(output()).toContain("$skill-name");
      },
    );
  });

  test("passes current transcript messages to dollar skill commands", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    resetShellSurfaceProbe();
    const getPromptForCommand = vi.fn(async (_args: string, context: unknown) => {
      const messages = (context as { messages?: readonly unknown[] }).messages ?? [];
      return [{ type: "text", text: `message-count:${messages.length}` }];
    });
    mockTuiCommandList.push({
      name: "reviewer",
      type: "prompt",
      loadedFrom: "skills",
      progressMessage: "Loading reviewer",
      contentLength: 1,
      getPromptForCommand,
    });
    const session = {
      ...createSession(),
      getInitialTranscriptEvents: () => [
        {
          id: "prior-turn",
          type: "turn_complete",
          payload: {
            turnId: "prior-turn",
            lastAgentMessage: "Previous response",
          },
        },
      ],
      enqueueIdleInput: vi.fn(() => 1),
      submit: vi.fn(async () => {}),
    } satisfies AgenCBridgeSession;
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    const { stdout, stdin } = createTestStreams();
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    });

    try {
      root.render(
        <AgenCTuiApp
          session={session}
          configStore={{}}
          isInteractive={false}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(providerProbe.messageProps.at(-1)?.messages).toHaveLength(1);
      expect(providerProbe.promptProps.at(-1)?.commands).toContainEqual(
        expect.objectContaining({ name: "reviewer", type: "prompt" }),
      );

      const onSubmit = providerProbe.promptProps.at(-1)?.onSubmit as
        | ((input: string, helpers: typeof helpers) => Promise<void>)
        | undefined;
      expect(onSubmit).toBeDefined();

      await onSubmit!("$reviewer audit this", helpers);

      expect(getPromptForCommand).toHaveBeenCalledWith(
        "audit this",
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ type: "assistant" }),
          ]),
        }),
      );
      expect(session.submit).toHaveBeenCalledWith("", {
        displayUserMessage: "$reviewer audit this",
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("keeps unknown dollar skills out of model submit", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    resetShellSurfaceProbe();
    const session = {
      ...createSession(),
      enqueueIdleInput: vi.fn(() => 1),
      submit: vi.fn(async () => {}),
    } satisfies AgenCBridgeSession;
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async ({ output }) => {
        const onSubmit = providerProbe.promptSubmits.at(-1);
        expect(onSubmit).toBeDefined();

        await onSubmit!("$missing-skill now", helpers);
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(session.submit).not.toHaveBeenCalled();
        expect(session.enqueueIdleInput).not.toHaveBeenCalled();
        expect(output()).toContain("Unknown");
        expect(output()).toContain("$missing-skill");
        expect(output()).toContain("/skills");
      },
    );
  });

  test("shows spinner while a tool runs after buffered assistant text", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      getInitialTranscriptEvents: () => [
        {
          id: "turn-started",
          type: "turn_started",
          payload: { turnId: "turn-with-tool" },
        },
        {
          id: "assistant-delta",
          type: "agent_message_delta",
          payload: { delta: "I will inspect that now." },
        },
        {
          id: "tool-started",
          type: "tool_call_started",
          payload: {
            callId: "tool-read-1",
            toolName: "Read",
            args: "{}",
          },
        },
      ],
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    const output = await renderApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
    );

    expect(output).toContain("spinner:tool-use:Running");
    const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
    expect(layoutProps).toBeDefined();
    expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(true);
    expect(containsElementNamed(layoutProps?.scrollable, "SpinnerWithVerb")).toBe(false);
    expect(providerProbe.spinnerProps.at(-1)).toEqual(
      expect.objectContaining({
        mode: "tool-use",
        hasActiveTools: true,
        showLeaderTokenStats: false,
        overrideMessage: "Running tools",
      }),
    );
    expect(providerProbe.messageProps.at(-1)).toEqual(
      expect.objectContaining({
        streamingText: "I will inspect that now.",
      }),
    );
  });

  test("keeps spinner visible after first assistant row while submit is still in flight", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const subscribers = new Set<(event: unknown) => void>();
    let resolveSubmit: (() => void) | undefined;
    const session = {
      ...createSession(),
      submit: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSubmit = resolve;
          }),
      ),
      subscribeToEvents: (cb: (event: unknown) => void) => {
        subscribers.add(cb);
        return () => {
          subscribers.delete(cb);
        };
      },
    } satisfies AgenCBridgeSession;
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        const onSubmit = providerProbe.promptSubmits.at(-1);
        expect(onSubmit).toBeDefined();

        const submitPromise = onSubmit!("inspect the project", helpers);
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(session.submit).toHaveBeenCalledWith("inspect the project", {
          displayUserMessage: "inspect the project",
        });
        for (const subscriber of subscribers) {
          subscriber({
            id: "first-assistant-row",
            type: "turn_complete",
            payload: {
              turnId: "turn-1",
              lastAgentMessage: "I will inspect that now.",
            },
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.promptProps.at(-1)).toEqual(
          expect.objectContaining({ isLoading: true }),
        );
        expect(containsElementNamed(providerProbe.fullscreenLayoutProps.at(-1)?.bottom, "SpinnerWithVerb")).toBe(true);

        resolveSubmit?.();
        await submitPromise;
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.promptProps.at(-1)).toEqual(
          expect.objectContaining({ isLoading: false }),
        );
      },
    );
  });

  test("keeps spinner visible while assistant text is streaming", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      getInitialTranscriptEvents: () => [
        {
          id: "turn-started",
          type: "turn_started",
          payload: { turnId: "turn-with-text" },
        },
        {
          id: "assistant-delta",
          type: "agent_message_delta",
          payload: { delta: "Streaming response text." },
        },
      ],
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    const output = await renderApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
    );

    expect(output).toContain("spinner:responding:");
    const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
    expect(layoutProps).toBeDefined();
    expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(true);
    expect(providerProbe.spinnerProps.at(-1)).toEqual(
      expect.objectContaining({
        mode: "responding",
        hasActiveTools: false,
        showLeaderTokenStats: false,
      }),
    );
    expect(providerProbe.messageProps.at(-1)).toEqual(
      expect.objectContaining({
        streamingText: "Streaming response text.",
      }),
    );
  });

  test("keeps spinner visible while thinking and text coexist", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      getInitialTranscriptEvents: () => [
        {
          id: "turn-started",
          type: "turn_started",
          payload: { turnId: "turn-with-thinking" },
        },
        {
          id: "thinking-start",
          type: "assistant_thinking_block_start",
          payload: { kind: "thinking" },
        },
        {
          id: "thinking-delta",
          type: "assistant_thinking_delta",
          payload: { delta: "Planning.", kind: "thinking" },
        },
        {
          id: "assistant-delta",
          type: "agent_message_delta",
          payload: { delta: "Partial answer." },
        },
      ],
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    const output = await renderApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
    );

    expect(output).toContain("spinner:thinking:");
    const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
    expect(layoutProps).toBeDefined();
    expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(true);
    expect(providerProbe.spinnerProps.at(-1)).toEqual(
      expect.objectContaining({
        mode: "thinking",
        hasActiveTools: false,
        showLeaderTokenStats: false,
      }),
    );
  });

  test("uses tool-input spinner mode while provider tool input is streaming", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      getInitialTranscriptEvents: () => [
        {
          id: "turn-started",
          type: "turn_started",
          payload: { turnId: "turn-with-tool-input" },
        },
        {
          id: "tool-input-start",
          type: "tool_input_block_start",
          payload: {
            callId: "tool-read-1",
            index: 0,
            toolName: "Read",
            contentBlock: {
              type: "tool_use",
              id: "tool-read-1",
              name: "Read",
              input: {},
            },
          },
        },
        {
          id: "tool-input-delta",
          type: "tool_input_delta",
          payload: {
            index: 0,
            partialJson: "{\"file_path\":\"README.md\"",
          },
        },
      ],
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    const output = await renderApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
    );

    expect(output).toContain("spinner:tool-input:");
    const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
    expect(layoutProps).toBeDefined();
    expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(true);
    expect(providerProbe.spinnerProps.at(-1)).toEqual(
      expect.objectContaining({
        mode: "tool-input",
        hasActiveTools: true,
        showLeaderTokenStats: false,
        overrideMessage: null,
      }),
    );
  });

  test("pins the pending-submit spinner after a prior assistant turn", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    let resolveSubmit: () => void = () => {};
    const submitPromise = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });
    const session = {
      ...createSession(),
      getInitialTranscriptEvents: () => [
        {
          id: "prior-turn",
          type: "turn_complete",
          payload: {
            turnId: "prior-turn",
            lastAgentMessage: "Previous response",
          },
        },
      ],
      submit: vi.fn(() => submitPromise),
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async ({ output }) => {
        const onSubmit = providerProbe.promptSubmits.at(-1);
        expect(onSubmit).toBeDefined();

        const run = onSubmit!("second prompt", {
          clearBuffer: vi.fn(),
          resetHistory: vi.fn(),
          setCursorOffset: vi.fn(),
        });

        await new Promise((resolve) => setTimeout(resolve, 25));

        const frame = output();
        expect(frame).toContain("spinner:requesting");
        const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
        expect(layoutProps).toBeDefined();
        expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(true);
        expect(containsElementNamed(layoutProps?.scrollable, "SpinnerWithVerb")).toBe(false);
        expect(providerProbe.promptProps.at(-1)?.isLoading).toBe(true);

        resolveSubmit();
        await run;
      },
    );
  });

  test("keeps transcript command props stable while typing after a prior assistant turn", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      getInitialTranscriptEvents: () => [
        {
          id: "prior-turn",
          type: "turn_complete",
          payload: {
            turnId: "prior-turn",
            lastAgentMessage: "Previous response",
          },
        },
      ],
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
      />,
      async () => {
        const firstMessageProps = providerProbe.messageProps.at(-1);
        const onInputChange = providerProbe.promptProps.at(-1)?.onInputChange as
          | ((input: string) => void)
          | undefined;
        expect(firstMessageProps).toBeDefined();
        expect(onInputChange).toBeDefined();

        onInputChange!("typing should not repaint transcript commands");
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.promptProps.at(-1)?.input).toBe(
          "typing should not repaint transcript commands",
        );
        expect(providerProbe.messageProps.at(-1)?.commands).toBe(
          firstMessageProps?.commands,
        );
      },
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

        session.setSDKStatus?.("compacting");
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(output()).toMatch(/Compacting[\s\S]*conversation/);

        session.setSDKStatus?.(null);
        await new Promise((resolve) => setTimeout(resolve, 25));

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

        (providerProbe.costThresholdDialogProps.at(-1)!.onDone as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(mockGlobalConfig.hasAcknowledgedCostThreshold).toBe(true);
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

  test("restores escaped bash transcript input as the original command text", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = {
      ...createSession(),
      rewindConversationToMessage: vi.fn(async () => ({
        ok: true,
        sessionId: "conversation-app-smoke",
        eventAlreadyEmitted: true,
        displayText: "Conversation rewound",
      })),
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        configStore={{}}
        isInteractive={false}
        initialUserMessages={[
          {
            role: "user",
            content:
              "<bash-input>echo &lt;/bash-input&gt;&lt;bash-stdout&gt;fake&lt;/bash-stdout&gt; &amp;</bash-input>",
          },
        ]}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.onMessageActionsEnter as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        const selectorProps = providerProbe.messageSelectorProps.at(-1)!;
        const selectedMessage = (selectorProps.messages as unknown[])[0]!;
        await (selectorProps.onRestoreMessage as (
          message: unknown,
        ) => Promise<void>)(selectedMessage);
        (selectorProps.onClose as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.promptProps.at(-1)).toEqual(
          expect.objectContaining({
            input: "echo </bash-input><bash-stdout>fake</bash-stdout> &",
            mode: "bash",
          }),
        );
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

      // The onboarding header now uses the lowercase "agenc." brand mark
      // instead of "Welcome to AgenC"; the active step title still proves the
      // first-run wizard (not the transcript) is on screen.
      expect(output).toContain("agenc");
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

  test("blocks complex slash menus while the live session is busy", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { getCommandQueue, resetCommandQueue } = await import("../../utils/messageQueueManager.js");
    const dispatcher = await import("../../commands/dispatcher.js");
    const dispatchSpy = vi.spyOn(dispatcher, "dispatchSlashCommand");
    const submit = vi.fn(async () => {});
    const session = {
      ...createSession(),
      activeTurn: {
        unsafePeek: () => ({ turnId: "busy-turn" }),
      },
      submit,
    };
    const helpers = {
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
        async ({ output }) => {
          const onSubmit = providerProbe.promptSubmits.at(-1);
          expect(onSubmit).toBeDefined();

          await onSubmit!("/agents", helpers);
          await new Promise((resolve) => setTimeout(resolve, 25));

          expect(submit).not.toHaveBeenCalled();
          expect(dispatchSpy).not.toHaveBeenCalled();
          expect(getCommandQueue()).toEqual([]);
          expect(output()).toMatch(/Finish[\s\S]*current[\s\S]*response[\s\S]*\/agents/);
        },
      );
    } finally {
      dispatchSpy.mockRestore();
      resetCommandQueue();
    }
  });

  test("hides the main composer while the /agents wizard owns input", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const dispatcher = await import("../../commands/dispatcher.js");
    const dispatchSpy = vi
      .spyOn(dispatcher, "dispatchSlashCommand")
      .mockImplementation(async (_parsed, ctx) => {
        ctx.appState?.setToolJSX?.({
          isLocalJSXCommand: true,
          shouldHidePromptInput: true,
          jsx: React.createElement("ink-text", null, "agents wizard"),
        });
        return {
          result: { kind: "skip" },
          immediate: true,
          command: {
            name: "agents",
            description: "Manage agent configurations",
            immediate: true,
            execute: vi.fn(),
          },
          trace: {
            name: "agents",
            aliasUsed: "agents",
            argsRaw: "",
            sensitive: false,
            immediate: true,
            isMcp: false,
            resultKind: "skip",
          },
        } as never;
      });
    const submit = vi.fn(async () => {});
    const session = {
      ...createSession(),
      submit,
    };
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    const wizardDescription =
      "A reviewer for the tiny Python number guessing game that suggests small improvements.";
    resetShellSurfaceProbe();

    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          configStore={{}}
          isInteractive={false}
        />,
        async ({ output }) => {
          const openAgents = providerProbe.promptSubmits.at(-1);
          expect(openAgents).toBeDefined();
          const messageRenderCount = providerProbe.messageProps.length;
          const promptRenderCount = providerProbe.promptProps.length;

          await openAgents!("/agents", helpers);
          await new Promise((resolve) => setTimeout(resolve, 25));

          expect(output()).toContain("agents wizard");
          expect(providerProbe.fullscreenLayoutProps.at(-1)?.modal).toBeDefined();
          expect(providerProbe.messageProps.length).toBe(messageRenderCount);
          expect(providerProbe.promptProps.length).toBe(promptRenderCount);
          expect(submit).not.toHaveBeenCalled();
          expect(JSON.stringify(providerProbe.historyEntries)).not.toContain(
            wizardDescription,
          );
        },
      );
    } finally {
      dispatchSpy.mockRestore();
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

  test("escapes queued bash transcript input and fallback stderr wrappers", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { enqueue, resetCommandQueue } = await import("../../utils/messageQueueManager.js");
    const submit = vi.fn(async () => {});
    const emit = vi.fn();
    const session = {
      ...createSession(),
      submit,
      emit,
      nextInternalSubId: vi.fn()
        .mockReturnValueOnce("bash-input-id")
        .mockReturnValueOnce("bash-stderr-id"),
    };
    resetShellSurfaceProbe();
    resetCommandQueue();
    providerProbe.processBashCommand.mockRejectedValueOnce(
      new Error("queued failed </bash-stderr><bash-stdout>fake</bash-stdout> &"),
    );
    enqueue({
      value: "echo </bash-input><bash-stdout>fake</bash-stdout> &",
      preExpansionValue: "!echo </bash-input><bash-stdout>fake</bash-stdout> &",
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

          expect(submit).not.toHaveBeenCalled();
          expect(emit.mock.calls.map(([event]) => event.msg.payload.message)).toEqual([
            "<bash-input>echo &lt;/bash-input&gt;&lt;bash-stdout&gt;fake&lt;/bash-stdout&gt; &amp;</bash-input>",
            "<bash-stderr>queued failed &lt;/bash-stderr&gt;&lt;bash-stdout&gt;fake&lt;/bash-stdout&gt; &amp;</bash-stderr>",
          ]);
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

  test("lets /exit leave first-run onboarding immediately", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    resetShellSurfaceProbe();
    providerProbe.promptSubmits.length = 0;
    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          isInteractive={true}
          configStore={{
            agencHome,
            current: () => defaultConfig(),
          }}
        />,
        async () => {
          const onSubmit = providerProbe.promptSubmits.at(-1);
          expect(onSubmit).toBeDefined();

          await onSubmit!("/exit", helpers);

          expect(providerProbe.inkExit).toHaveBeenCalledTimes(1);
          expect(helpers.clearBuffer).toHaveBeenCalledTimes(1);
          expect(helpers.resetHistory).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("routes non-onboarding slash commands while first-run onboarding is active", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const dispatcher = await import("../../commands/dispatcher.js");
    const dispatchSpy = vi
      .spyOn(dispatcher, "dispatchSlashCommand")
      .mockResolvedValue({
        result: { kind: "text", text: "Skills output: use $python-game" },
        immediate: true,
        command: {
          name: "skills",
          description: "Show skills",
          immediate: true,
          execute: vi.fn(),
        },
        trace: {
          name: "skills",
          aliasUsed: "skills",
          argsRaw: "",
          sensitive: false,
          immediate: true,
          isMcp: false,
          resultKind: "text",
        },
      } as never);
    const session = {
      ...createSession(),
      submit: vi.fn(async () => {}),
    };
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    providerProbe.promptSubmits.length = 0;
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };

    try {
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
          const onSubmit = providerProbe.promptSubmits.at(-1);
          expect(onSubmit).toBeDefined();

          await onSubmit!("/skills", helpers);
          await new Promise((resolve) => setTimeout(resolve, 25));

          expect(dispatchSpy).toHaveBeenCalled();
          expect(session.submit).not.toHaveBeenCalled();
          expect(helpers.clearBuffer).toHaveBeenCalledTimes(1);
          expect(helpers.resetHistory).toHaveBeenCalledTimes(1);
          expect(output()).toContain("Skills output");
          expect(output()).toContain("$python-game");
        },
      );
    } finally {
      dispatchSpy.mockRestore();
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
    // Isolate AGENC_HOME: a real ~/.agenc/auth.json (hosted managed session)
    // would reorder the onboarding provider menu and swap the API-key step
    // for the hosted-access path, breaking the scripted anonymous flow.
    const previousAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
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
          await submit("skip");
          await submit("test");
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
      if (previousAgencHome === undefined) {
        delete process.env.AGENC_HOME;
      } else {
        process.env.AGENC_HOME = previousAgencHome;
      }
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
    // Isolate AGENC_HOME: a real ~/.agenc/auth.json (hosted managed session)
    // would replace the BYOK API-key step with the hosted-access path.
    const previousAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
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
      if (previousAgencHome === undefined) {
        delete process.env.AGENC_HOME;
      } else {
        process.env.AGENC_HOME = previousAgencHome;
      }
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("persists first-run BYOK provider selection for restarts", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { LocalAuthBackend } = await import("../../auth/backends/local.js");
    const session = {
      ...createSession(),
      setPendingProviderSwitch: vi.fn(),
    };
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-persist-"));
    const previousAgencHome = process.env.AGENC_HOME;
    const previousConfigDir = process.env.AGENC_CONFIG_DIR;
    process.env.AGENC_HOME = agencHome;
    delete process.env.AGENC_CONFIG_DIR;
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
            reload: vi.fn(async () => defaultConfig()),
          }}
        />,
        async () => {
          const submit = async (value: string): Promise<void> => {
            const onSubmit = providerProbe.promptSubmits.at(-1);
            expect(onSubmit).toBeDefined();
            await onSubmit!(value, helpers);
            await new Promise((resolve) => setTimeout(resolve, 50));
          };

          await submit("next");
          await submit("1");
          await submit("deepseek");
          await submit("sk-deepseek-onboarding-test");
          await submit("yes");
          await submit("next");
          await submit("done");

          expect(session.setPendingProviderSwitch).toHaveBeenLastCalledWith({
            provider: "deepseek",
            model: "deepseek-reasoner",
          });
          await expect(
            new LocalAuthBackend({ agencHome }).readByokKey("deepseek"),
          ).resolves.toBe("sk-deepseek-onboarding-test");
          expect(
            JSON.parse(readFileSync(join(agencHome, "settings.json"), "utf8")),
          ).toMatchObject({ model: "deepseek-reasoner" });
          const configToml = readFileSync(join(agencHome, "config.toml"), "utf8");
          expect(configToml).toContain('"model_provider" = "deepseek"');
          expect(configToml).toContain('"model" = "deepseek-reasoner"');
          expect(configToml).toContain('"default_model" = "deepseek-reasoner"');
        },
      );
    } finally {
      fetchSpy.mockRestore();
      providerProbe.promptSubmits.length = 0;
      if (previousAgencHome === undefined) {
        delete process.env.AGENC_HOME;
      } else {
        process.env.AGENC_HOME = previousAgencHome;
      }
      if (previousConfigDir === undefined) {
        delete process.env.AGENC_CONFIG_DIR;
      } else {
        process.env.AGENC_CONFIG_DIR = previousConfigDir;
      }
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
