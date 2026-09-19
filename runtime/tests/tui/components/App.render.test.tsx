import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { type SetStateAction } from "react";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolPermissionContext } from "../../permissions/types.js";
import type {
  McpElicitationRequestEvent,
  McpPrimitiveSchemaDefinition,
  RequestUserInputEvent,
} from "../../elicitation/types.js";
import type { AgenCBridgeSession } from "../session-types.js";
import type { McpSurfaceSnapshot } from "../../session/session.js";
import type { AgenCRealtimeTuiControls } from "../realtime/controller.js";
import type {
  McpFormPending,
  McpUrlPending,
  PendingElicitation,
} from "./App.js";
import {
  dismissLedgerVerification,
  getLedgerVerificationSnapshot,
} from "../../services/Ledger/ledgerVerification.js";
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from "../remoteAuthSessionContext.fixture.js";

if (process.versions.bun !== undefined) {
  test("App render suite requires Vitest module mocks", () => {
    expect(true).toBe(true);
  });
}

let createRoot: any;
let defaultConfig: any;
let ConfigStoreClass: typeof import("../../config/store.js").ConfigStore;
let testConfigStore: import("../../config/store.js").ConfigStore;
let markFirstRunOnboardingComplete: any;
let readOnboardingState: any;
let mockTotalCost = 0;
let mockHasConsoleBillingAccess = false;
let mockWorktreeSession: unknown = null;
let mockGlobalConfig: Record<string, unknown> = {};
const mockTuiCommandList = vi.hoisted(() => [] as Array<Record<string, any>>);
const commandDiscoveryProbe = vi.hoisted(() => vi.fn());
const commandDebugProbe = vi.hoisted(() => vi.fn());
const roleDefinitionProbe = vi.hoisted(() =>
  vi.fn((_cwd: string) => [
    {
      agentType: "default",
      whenToUse: "Default agent.",
      source: "built-in",
      baseDir: "built-in",
      getSystemPrompt: () => "",
    },
    {
      agentType: "scanner",
      whenToUse: "Explore code.",
      source: "built-in",
      baseDir: "built-in",
      getSystemPrompt: () => "",
    },
    {
      agentType: "runner",
      whenToUse: "Execute work.",
      source: "built-in",
      baseDir: "built-in",
      getSystemPrompt: () => "",
    },
  ]),
);
const fullscreenProbe = vi.hoisted(() => ({
  fullscreen: false,
  mouseTracking: false,
}));
const apiKeyVerificationProbe = vi.hoisted(() => ({
  contexts: [] as unknown[],
  reverify: vi.fn(async () => {}),
  status: "valid" as "loading" | "valid" | "invalid" | "missing" | "error",
}));
const ledgerStatusProbe = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
}));

const providerProbe = {
  fpsGetters: [] as unknown[],
  costSummaryGetters: [] as unknown[],
  statsStores: [] as unknown[],
  appStateProps: [] as Array<{
    initialState: unknown;
    onChangeAppState: unknown;
  }>,
  currentAppState: null as Record<string, unknown> | null,
  setAppState: null as
    ((next: SetStateAction<Record<string, unknown>>) => void) | null,
  globalKeybindingProps: [] as Array<Record<string, unknown>>,
  cancelRequestProps: [] as Array<Record<string, unknown>>,
  exitFlowProps: [] as Array<Record<string, unknown>>,
  costThresholdDialogProps: [] as Array<Record<string, unknown>>,
  messageProps: [] as Array<Record<string, unknown>>,
  messageSelectorProps: [] as Array<Record<string, unknown>>,
  mcpConnectivityProps: [] as Array<Record<string, unknown>>,
  fullscreenLayoutProps: [] as Array<Record<string, React.ReactNode>>,
  scrollKeybindingProps: [] as Array<Record<string, unknown>>,
  spinnerProps: [] as Array<Record<string, unknown>>,
  promptSubmits: [] as Array<
    (
      input: string,
      helpers: {
        clearBuffer(): void;
        resetHistory(): void;
        setCursorOffset(offset: number): void;
      },
    ) => Promise<void>
  >,
  promptProps: [] as Array<Record<string, unknown>>,
  defaultStateProviderEnvironments: [] as unknown[],
  processBashCommand:
    typeof vi.fn === "function"
      ? vi.fn(async () => ({
          messages: [],
          shouldQuery: false,
        }))
      : async () => ({ messages: [], shouldQuery: false }),
  confirmSuspectedShellPaste:
    typeof vi.fn === "function" ? vi.fn(async () => true) : async () => true,
  onChangeAppState: typeof vi.fn === "function" ? vi.fn() : () => {},
  inkExit: typeof vi.fn === "function" ? vi.fn() : () => {},
  fileHistoryRewind: typeof vi.fn === "function" ? vi.fn() : () => {},
  historyEntries: [] as unknown[],
};

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: commandDebugProbe,
}));

vi.mock("src/utils/envUtils.js", () => ({
  getAgenCHomeDir: () => "/tmp/agenc-app-render-test",
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
  getRuntimeState: () => mockGlobalConfig,
  updateRuntimeState: (
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
  ) => {
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

vi.mock("../hooks/useApiKeyVerification.js", () => ({
  useApiKeyVerification: (context: unknown) => {
    apiKeyVerificationProbe.contexts.push(context);
    return {
      error: null,
      reverify: apiKeyVerificationProbe.reverify,
      status: apiKeyVerificationProbe.status,
    };
  },
}));

vi.mock("../../services/PromptSuggestion/promptSuggestion.js", () => ({
  shouldEnablePromptSuggestion: () => false,
}));

vi.mock("../../services/Ledger/ledgerStatus.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/Ledger/ledgerStatus.js")
  >()),
  refreshLedgerStatus: ledgerStatusProbe.refresh,
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

vi.mock("../../permissions/settings.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPermissionRulesSnapshot: async () => ({
    rules: [],
    managedOnly: false,
    directories: [],
    bypassPermissionsModeDisabled: false,
    disableAutoMode: false,
  }),
  parseToolRuleStringsFromCLI: (tools: string[] = []) => tools,
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
  getSettingsForSource: () => null,
}));

vi.mock("../../utils/teammate.js", () => ({
  isPlanModeRequired: () => false,
  isTeammate: () => false,
}));

vi.mock("../../utils/thinking.js", () => ({
  shouldEnableThinkingByDefault: () => false,
}));

vi.mock("../../utils/envUtils.js", () => ({
  getAgenCHomeDir: () => "/tmp/agenc-app-render-test",
  isEnvTruthy: () => false,
  isBareMode: () => false,
}));

vi.mock("../../utils/fullscreen.js", () => ({
  isFullscreenEnabledForCurrentTerminal: () => fullscreenProbe.fullscreen,
  isMouseClicksDisabled: () => true,
  isMouseTrackingEnabled: () => fullscreenProbe.mouseTracking,
}));

vi.mock("../../utils/log.js", () => ({
  logError: () => {},
}));

vi.mock("../input/processBashCommand.js", () => ({
  processBashCommand: providerProbe.processBashCommand,
}));

vi.mock("../input/shell-paste-confirmation.js", () => ({
  confirmSuspectedShellPaste: providerProbe.confirmSuspectedShellPaste,
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
    getState: () => Record<string, unknown>;
  } | null>(null);
  return {
    // overlayContext imports the store context directly. Keep this mock's
    // provider and direct-context consumers on the same test value so an
    // asynchronously rendered PromptInput cannot escape through Ink's
    // uncaught-error boundary.
    AppStoreContext: StateContext,
    getDefaultAppState: () => ({
      settings: {},
      mainLoopModel: null,
      mainLoopModelForSession: null,
      toolPermissionContext: defaultPermissionContext,
      activeOverlays: new Set(),
      notifications: { current: null, queue: [] },
      elicitation: { queue: [] },
    }),
    getDefaultAppStateForProviderEnvironment: (
      environment: unknown,
      settings: Record<string, unknown>,
    ) => {
      providerProbe.defaultStateProviderEnvironments.push(environment);
      return {
        settings,
        mainLoopModel: null,
        mainLoopModelForSession: null,
        toolPermissionContext: defaultPermissionContext,
        activeOverlays: new Set(),
        notifications: { current: null, queue: [] },
        elicitation: { queue: [] },
      };
    },
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
      const initialStateRef = React.useRef({
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
      });
      const [state, setRenderedState] = React.useState(initialStateRef.current);
      const stateRef = React.useRef<Record<string, unknown>>(
        initialStateRef.current,
      );
      const setState = React.useCallback(
        (next: SetStateAction<Record<string, unknown>>) => {
          const resolved =
            typeof next === "function" ? next(stateRef.current) : next;
          stateRef.current = resolved;
          setRenderedState(resolved);
        },
        [],
      );
      providerProbe.currentAppState = state;
      providerProbe.setAppState = setState;
      return React.createElement(
        StateContext.Provider,
        { value: { state, setState, getState: () => stateRef.current } },
        children,
      );
    },
    useAppState: (selector: (state: Record<string, unknown>) => unknown) => {
      const context = React.useContext(StateContext);
      if (context === null) throw new Error("missing AppState test provider");
      return selector(context.state);
    },
    useAppStateMaybeOutsideOfProvider: (
      selector: (state: Record<string, unknown>) => unknown,
    ) => {
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
        getState: context.getState,
        setState: context.setState,
        subscribe: () => () => {},
      };
    },
  };
});

vi.mock("../../commands.js", () => ({
  findCommand: (
    name: string,
    commands: Array<Record<string, any>> = mockTuiCommandList,
  ) =>
    commands.find(
      (command) => command.name === name || command.aliases?.includes(name),
    ) ?? null,
  getCommands: async (...args: unknown[]) => {
    return commandDiscoveryProbe(...args) ?? mockTuiCommandList;
  },
  isCommandEnabled: () => true,
  listTuiCommandList: () => mockTuiCommandList,
}));

vi.mock("../../agents/role-definitions.js", () => ({
  listAgentRoleDefinitions: roleDefinitionProbe,
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

vi.mock("../hooks/useCancelRequest.js", async () => {
  const React = await import("react");
  return {
    CancelRequestHandler: (props: Record<string, unknown>) => {
      providerProbe.cancelRequestProps.push(props);
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
    Messages: (
      props: { messages: readonly unknown[] } & Record<string, unknown>,
    ) => {
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
    selectableUserMessagesFilter: (message: {
      type?: unknown;
      message?: { content?: unknown };
    }) => {
      const content = message.message?.content;
      return (
        message.type === "user" &&
        typeof content === "string" &&
        content.trim().length > 0
      );
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
      React.createElement(
        "ink-text",
        null,
        `queued-message:${String(props.message ?? "")}`,
      ),
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
  const { parseLocalControlCommand } = await import("../../../src/commands/local-control.js");
  return {
    default: ({
      input,
      onSubmit,
      onShowMessageSelector,
      onMessageActionsEnter,
      onExit,
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
      submissionBlockedReason,
      onSubmissionBlocked,
      onOpenModelMenu,
      onboardingInput,
      onBashSubmit,
    }: {
      input: string;
      onSubmit: (
        input: string,
        helpers: {
          clearBuffer(): void;
          resetHistory(): void;
          setCursorOffset(offset: number): void;
        },
      ) => Promise<void>;
      onShowMessageSelector?: () => void;
      onMessageActionsEnter?: () => void;
      onExit?: () => void;
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
      submissionBlockedReason?: string | null;
      onSubmissionBlocked?: (reason: string) => void;
      onOpenModelMenu?: () => Promise<void> | void;
      onboardingInput?: unknown;
      onBashSubmit?: (
        command: string,
        admittedCwd?: string,
      ) => Promise<void>;
    }) => {
      const guardedOnSubmit: typeof onSubmit = async (...args) => {
        if (
          submissionBlockedReason !== null &&
          submissionBlockedReason !== undefined &&
          !(mode === "prompt" && parseLocalControlCommand(args[0]) !== null)
        ) {
          onSubmissionBlocked?.(submissionBlockedReason);
          return;
        }
        await onSubmit(...args);
      };
      providerProbe.promptSubmits.push(guardedOnSubmit);
      providerProbe.promptProps.push({
        input,
        onSubmit: guardedOnSubmit,
        onShowMessageSelector,
        onMessageActionsEnter,
        onExit,
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
        submissionBlockedReason,
        onSubmissionBlocked,
        onOpenModelMenu,
        onboardingInput,
        onBashSubmit,
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

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

function extractLastSynchronizedFrame(output: string): string {
  let lastFrame: string | undefined;
  let cursor = 0;

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) break;
    const contentStart = start + SYNC_START.length;
    const end = output.indexOf(SYNC_END, contentStart);
    if (end === -1) break;
    const frame = output.slice(contentStart, end);
    if (frame.trim().length > 0) lastFrame = frame;
    cursor = end + SYNC_END.length;
  }

  if (lastFrame === undefined) {
    throw new Error(
      "Expected at least one complete synchronized terminal frame",
    );
  }
  return lastFrame;
}

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
  apiKeyVerificationProbe.contexts.length = 0;
  providerProbe.costSummaryGetters.length = 0;
  providerProbe.cancelRequestProps.length = 0;
  providerProbe.exitFlowProps.length = 0;
  providerProbe.costThresholdDialogProps.length = 0;
  providerProbe.messageSelectorProps.length = 0;
  providerProbe.messageProps.length = 0;
  providerProbe.mcpConnectivityProps.length = 0;
  providerProbe.fullscreenLayoutProps.length = 0;
  providerProbe.scrollKeybindingProps.length = 0;
  providerProbe.spinnerProps.length = 0;
  providerProbe.promptProps.length = 0;
  providerProbe.defaultStateProviderEnvironments.length = 0;
  providerProbe.promptSubmits.length = 0;
  providerProbe.currentAppState = null;
  providerProbe.setAppState = null;
  providerProbe.inkExit.mockClear?.();
  providerProbe.fileHistoryRewind.mockReset?.();
  providerProbe.processBashCommand.mockClear?.();
  providerProbe.confirmSuspectedShellPaste.mockReset?.();
  providerProbe.confirmSuspectedShellPaste.mockResolvedValue?.(true);
  providerProbe.historyEntries.length = 0;
  ledgerStatusProbe.refresh.mockClear();
  dismissLedgerVerification();
  mockTuiCommandList.length = 0;
  commandDiscoveryProbe.mockReset();
  commandDebugProbe.mockClear();
  mockTotalCost = 0;
  mockHasConsoleBillingAccess = false;
  mockWorktreeSession = null;
  mockGlobalConfig = {};
  fullscreenProbe.fullscreen = false;
  fullscreenProbe.mouseTracking = false;
  delete process.env.AGENC_TUI_WORKBENCH;
}

function containsElementNamed(node: React.ReactNode, name: string): boolean {
  if (node === null || node === undefined || typeof node === "boolean")
    return false;
  if (Array.isArray(node)) {
    return node.some((child) => containsElementNamed(child, name));
  }
  if (!React.isValidElement(node)) return false;
  const type = node.type as { displayName?: string; name?: string } | string;
  if (
    typeof type !== "string" &&
    (type.displayName === name || type.name === name)
  ) {
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
const describeWithVitestMocks = supportsVitestModuleMocks
  ? describe
  : describe.skip;

beforeAll(async () => {
  if (!supportsVitestModuleMocks) return;
  ({ createRoot } = await import("../ink/root.js"));
  ({ defaultConfig } = await import("../../config/schema.js"));
  ({ ConfigStore: ConfigStoreClass } = await import("../../config/store.js"));
  testConfigStore = createAppConfigStore();
  ({ markFirstRunOnboardingComplete, readOnboardingState } =
    await import("../../onboarding/projectOnboardingState.js"));
  const app = await import("./App.js");
  installElicitationResolvers = app.installElicitationResolvers;
  settlePendingOnSubmit = app.settlePendingOnSubmit;
  visibleCancelStreamMode = app.visibleCancelStreamMode;
}, 30_000);

function createAppConfigStore(
  config: import("../../config/schema.js").AgenCConfig = defaultConfig(),
  agencHome = TEST_REMOTE_AUTH_SESSION_CONTEXT.home.path,
): import("../../config/store.js").ConfigStore {
  return new ConfigStoreClass({
    base: config,
    cwd: process.cwd(),
    env: {
      ...TEST_REMOTE_AUTH_SESSION_CONTEXT.environment,
      AGENC_HOME: agencHome,
    },
    home: agencHome,
    projectTrusted: false,
  });
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

async function withRenderedApp(
  node: React.ReactNode,
  run: (ctx: {
    readonly output: () => string;
    readonly render: (next: React.ReactNode) => Promise<void>;
  }) => Promise<void>,
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
    await run({
      output,
      render: async (next) => {
        root.render(next);
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
  }
}

function mockOfflineOnboardingFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("offline onboarding fixture"));
}

function createSession(
  opts: {
    readonly permissionContext?: ToolPermissionContext;
    readonly updatePermissionContext?: (
      next: ToolPermissionContext,
    ) => Promise<void> | void;
    readonly setDaemonPermissionMode?: (
      mode: ToolPermissionContext["mode"],
    ) => Promise<unknown>;
    readonly emit?: AgenCBridgeSession["emit"];
    readonly nextInternalSubId?: AgenCBridgeSession["nextInternalSubId"];
    readonly executionCwd?: string;
    readonly roleWorkspaceCwd?: string;
    readonly agentDefinitions?: AgenCBridgeSession["agentDefinitions"];
    readonly enqueueIdleInputBatch?: AgenCBridgeSession["enqueueIdleInputBatch"];
    readonly authBackend?: AgenCBridgeSession["services"]["authBackend"];
    readonly configStore?: import("../../config/store.js").ConfigStore;
    readonly executeShellCommand?: AgenCBridgeSession["executeShellCommand"];
    readonly localExecutionCapable?: boolean;
    readonly runtimeOptions?: AgenCBridgeSession["services"]["runtimeOptions"];
  } = {},
): AgenCBridgeSession {
  const modeSubscribers: Array<
    (next: ToolPermissionContext["mode"], current: ToolPermissionContext["mode"]) => void
  > = [];
  const contextSubscribers: Array<
    (next: ToolPermissionContext, current: ToolPermissionContext) => void
  > = [];
  let permissionContext = opts.permissionContext ?? PERMISSION_CONTEXT;
  const executionCwd = opts.executionCwd ?? process.cwd();
  const roleWorkspaceCwd = opts.roleWorkspaceCwd ?? executionCwd;
  return {
    conversationId: "conversation-app-smoke",
    roleWorkspace: { id: roleWorkspaceCwd, cwd: roleWorkspaceCwd },
    ...(opts.agentDefinitions !== undefined
      ? { agentDefinitions: opts.agentDefinitions }
      : {}),
    services: {
      runtimeOptions: opts.runtimeOptions ?? {
        pluginStorageRoot: join(tmpdir(), "agenc-app-render-plugins"),
      } as never,
      configStore: opts.configStore ?? testConfigStore,
      providerEnvironment: TEST_REMOTE_AUTH_SESSION_CONTEXT.environment,
      permissionModeRegistry: {
        current: () => permissionContext,
        update: async (next: ToolPermissionContext) => {
          const current = permissionContext;
          await opts.updatePermissionContext?.(next);
          permissionContext = next;
          for (const cb of [...contextSubscribers]) cb(next, current);
          if (next.mode !== current.mode) {
            for (const cb of [...modeSubscribers]) {
              cb(next.mode, current.mode);
            }
          }
        },
        subscribeToModeChange: (cb) => {
          modeSubscribers.push(cb);
          return () => {
            const index = modeSubscribers.indexOf(cb);
            if (index !== -1) modeSubscribers.splice(index, 1);
          };
        },
        subscribeToContextChange: (cb) => {
          contextSubscribers.push(cb);
          return () => {
            const index = contextSubscribers.indexOf(cb);
            if (index !== -1) contextSubscribers.splice(index, 1);
          };
        },
      },
      ...(opts.authBackend !== undefined
        ? { authBackend: opts.authBackend }
        : {}),
      ...(opts.localExecutionCapable === true
        ? { executionAdmission: {} as never }
        : {}),
    },
    ...(opts.executeShellCommand !== undefined
      ? { executeShellCommand: opts.executeShellCommand }
      : {}),
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
    ...(opts.enqueueIdleInputBatch !== undefined
      ? { enqueueIdleInputBatch: opts.enqueueIdleInputBatch }
      : {}),
    rewindConversationToMessage: async () => ({
      ok: true,
      sessionId: "conversation-app-smoke",
      eventAlreadyEmitted: true,
      displayText: "Conversation rewound",
    }),
    sessionConfiguration: {
      cwd: executionCwd,
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

type ConcurrentExitIntentScenario = {
  readonly order: readonly ["plain" | "resume", "plain" | "resume"];
  readonly expectedResumeSessionId: string | null;
  readonly lateDirty: boolean;
};

async function requestConcurrentAppExit(
  kind: "plain" | "resume",
): Promise<void> {
  if (kind === "plain") {
    const onExit = providerProbe.promptProps.at(-1)?.onExit as
      (() => void) | undefined;
    expect(onExit).toBeDefined();
    onExit!();
    return;
  }

  const dispatcher = await import("../../commands/dispatcher.js");
  const dispatchSpy = vi
    .spyOn(dispatcher, "dispatchSlashCommand")
    .mockImplementationOnce(async (_parsed, context) => {
      (
        context as {
          readonly appState: {
            readonly requestResumeSession: (sessionId: string) => void;
          };
        }
      ).appState.requestResumeSession("session-next");
      return {
        result: { kind: "text", text: "Switching sessions" },
        command: { name: "resume" },
      } as never;
    });
  try {
    const onSubmit = providerProbe.promptSubmits.at(-1);
    expect(onSubmit).toBeDefined();
    await onSubmit!("/resume", {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    });
  } finally {
    dispatchSpy.mockRestore();
  }
}

describeWithVitestMocks("AgenCTuiApp render smoke", () => {
  test("detects a completion log recreated after the watched file is deleted", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const tempRoot = mkdtempSync(join(tmpdir(), "agenc-completion-log-watch-"));
    const eventLogPath = join(tempRoot, "events.jsonl");
    const previousEventLogPath =
      process.env.AGENC_TUI_COMPLETION_PIPELINE_LOG;
    const event = (
      pipelineId: string,
      status: "completed" | "started",
      gateId = "prep",
      gateIndex = 0,
    ) =>
      `${JSON.stringify({
        pipelineId,
        sequence: 1,
        gateId,
        gateIndex,
        status,
        timestamp: "2026-01-01T00:00:00.000Z",
      })}\n`;

    writeFileSync(eventLogPath, event("inactive", "completed"));
    process.env.AGENC_TUI_COMPLETION_PIPELINE_LOG = eventLogPath;
    resetShellSurfaceProbe();
    const renderedText = (node: React.ReactNode): string => {
      if (typeof node === "string" || typeof node === "number") {
        return String(node);
      }
      if (Array.isArray(node)) return node.map(renderedText).join("");
      if (!React.isValidElement(node)) return "";
      return renderedText(
        (node.props as { readonly children?: React.ReactNode }).children,
      );
    };
    const completionSurface = () =>
      renderedText(
        providerProbe.fullscreenLayoutProps.at(-1)?.scrollable,
      ).replace(/\s+/gu, "");

    try {
      await withRenderedApp(
        <AgenCTuiApp session={createSession()} isInteractive={false} />,
        async () => {
          await vi.waitFor(() => {
            expect(completionSurface()).toContain("Completionpipelinecomplete");
          });

          unlinkSync(eventLogPath);
          await vi.waitFor(() => {
            expect(completionSurface()).not.toContain(
              "Completionpipelinecomplete",
            );
          });

          writeFileSync(eventLogPath, event("replacement", "started"));
          await vi.waitFor(
            () => {
              expect(completionSurface()).toContain(
                "Completion1/9:Preparegoalrunning",
              );
            },
            { timeout: 3_000 },
          );

          const atomicReplacementPath = join(tempRoot, "replacement.jsonl");
          writeFileSync(
            atomicReplacementPath,
            event("atomic-replacement", "started", "typecheck", 5),
          );
          renameSync(atomicReplacementPath, eventLogPath);
          await vi.waitFor(
            () => {
              expect(completionSurface()).toContain(
                "Completion6/9:Typecheckrunning",
              );
            },
            { timeout: 3_000 },
          );
        },
      );
    } finally {
      if (previousEventLogPath === undefined) {
        delete process.env.AGENC_TUI_COMPLETION_PIPELINE_LOG;
      } else {
        process.env.AGENC_TUI_COMPLETION_PIPELINE_LOG = previousEventLogPath;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("keeps command discovery on session plugin authority across config reload", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const pluginStorageRoot = join(
      tmpdir(),
      "agenc-tui-session-plugin-authority",
    );
    const configStore = createAppConfigStore();
    const session = createSession({
      configStore,
      runtimeOptions: { pluginStorageRoot } as never,
    });
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        await vi.waitFor(() => {
          expect(commandDiscoveryProbe).toHaveBeenCalled();
        });
        const callsBeforeReload = commandDiscoveryProbe.mock.calls.length;

        await configStore.reload();

        await vi.waitFor(() => {
          expect(commandDiscoveryProbe.mock.calls.length).toBeGreaterThan(
            callsBeforeReload,
          );
        });
        for (const call of commandDiscoveryProbe.mock.calls) {
          expect(call[1]).toMatchObject({ pluginStorageRoot });
        }
      },
    );
  });

  test.each(["failure", "pending", "removed"] as const)(
    "invalidates dynamic command display and execution after a %s reload",
    async (outcome) => {
      const { AgenCTuiApp } = await import("./App.js");
      resetShellSurfaceProbe();
      mockTuiCommandList.push({ name: "help", type: "local", load: vi.fn() });
      const getPromptForCommand = vi.fn(async () => [
        { type: "text", text: "obsolete expansion" },
      ]);
      const dynamic = {
        name: "reloadable",
        type: "prompt",
        loadedFrom: "skills",
        progressMessage: "Loading",
        contentLength: 1,
        getPromptForCommand,
      };
      const configStore = createAppConfigStore();
      const session = createSession({
        configStore,
        runtimeOptions: { pluginStorageRoot: "/tmp/command-reload" } as never,
      });
      commandDiscoveryProbe.mockResolvedValue([dynamic]);
      const commands = () =>
        providerProbe.promptProps.at(-1)?.commands as Array<{ name: string }>;
      await withRenderedApp(
        <AgenCTuiApp session={session} isInteractive={false} />,
        async ({ output }) => {
          await vi.waitFor(() =>
            expect(commands().map((command) => command.name)).toContain(
              "reloadable",
            ),
          );
          await providerProbe.promptSubmits.at(-1)!("$reloadable", {
            clearBuffer: vi.fn(),
            resetHistory: vi.fn(),
            setCursorOffset: vi.fn(),
          });
          expect(getPromptForCommand).toHaveBeenCalledTimes(1);
          const pending = Promise.withResolvers<unknown[]>();
          if (outcome === "failure")
            commandDiscoveryProbe.mockRejectedValue(
              new Error("command source removed"),
            );
          else if (outcome === "pending")
            commandDiscoveryProbe.mockReturnValue(pending.promise);
          else commandDiscoveryProbe.mockResolvedValue([]);
          const calls = commandDiscoveryProbe.mock.calls.length;
          await configStore.reload();
          await vi.waitFor(() =>
            expect(commandDiscoveryProbe.mock.calls.length).toBeGreaterThan(
              calls,
            ),
          );
          if (outcome === "failure") {
            await vi.waitFor(() =>
              expect(
                commandDebugProbe.mock.calls.some(([message]) =>
                  String(message).includes("command source removed"),
                ),
              ).toBe(true),
            );
          }
          await vi.waitFor(() =>
            expect(commands().map((command) => command.name)).toEqual(["help"]),
          );
          await providerProbe.promptSubmits.at(-1)!("$reloadable", {
            clearBuffer: vi.fn(),
            resetHistory: vi.fn(),
            setCursorOffset: vi.fn(),
          });
          expect(getPromptForCommand).toHaveBeenCalledTimes(1);
          if (outcome === "failure")
            expect(stripAnsi(output()).replace(/\s+/gu, "")).toContain(
              "Dynamiccommandsunavailable",
            );
          pending.resolve([]);
        },
      );
    },
  );

  test.each(["success", "failure"] as const)(
    "ignores an older command generation's late %s",
    async (outcome) => {
      const { AgenCTuiApp } = await import("./App.js");
      resetShellSurfaceProbe();
      const configStore = createAppConfigStore();
      const session = createSession({
        configStore,
        runtimeOptions: { pluginStorageRoot: "/tmp/command-race" } as never,
      });
      const old = Promise.withResolvers<unknown[]>();
      commandDiscoveryProbe.mockReturnValue(old.promise);
      await withRenderedApp(
        <AgenCTuiApp session={session} isInteractive={false} />,
        async () => {
          await vi.waitFor(() =>
            expect(commandDiscoveryProbe).toHaveBeenCalled(),
          );
          commandDiscoveryProbe.mockResolvedValue([
            { name: "current-command", type: "prompt" },
          ]);
          await configStore.reload();
          const names = () =>
            (
              providerProbe.promptProps.at(-1)?.commands as Array<{
                name: string;
              }>
            ).map((command) => command.name);
          await vi.waitFor(() => expect(names()).toEqual(["current-command"]));
          commandDebugProbe.mockClear();
          if (outcome === "success")
            old.resolve([{ name: "obsolete-command", type: "prompt" }]);
          else old.reject(new Error("obsolete command failure"));
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(names()).toEqual(["current-command"]);
          expect(
            commandDebugProbe.mock.calls.some(([message]) =>
              String(message).includes("obsolete command failure"),
            ),
          ).toBe(false);
        },
      );
    },
  );

  test("derives TUI auth reads from the session-owned home and provider environment", async () => {
    const { getTuiRemoteAuthSessionReadContext } = await import("./App.js");
    const session = createSession();

    const context = getTuiRemoteAuthSessionReadContext(session);

    expect(context.home).toBe(testConfigStore.homeContext);
    expect(context.environment).toBe(
      TEST_REMOTE_AUTH_SESSION_CONTEXT.environment,
    );
    expect(context.provider).toBe("test-provider");
    expect(Object.isFrozen(context)).toBe(true);
  });

  test("terminal title prefix honors ASCII glyph mode", async () => {
    const { animatedTerminalTitlePrefix } = await import("./App.js");

    expect(animatedTerminalTitlePrefix(false, 0, {})).toBe("✳");
    expect(animatedTerminalTitlePrefix(true, 1, {})).toBe("⠐");
    expect(
      animatedTerminalTitlePrefix(false, 0, { AGENC_TUI_GLYPHS: "ascii" }),
    ).toBe("*");
    expect(
      animatedTerminalTitlePrefix(true, 1, { AGENC_TUI_GLYPHS: "ascii" }),
    ).toBe("+");
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
    expect(formatAgentsKilledNotification([{ description: "Fix tests" }])).toBe(
      "Stopped background agent: Fix tests",
    );
    expect(
      formatAgentsKilledNotification([
        { description: "Fix tests" },
        { description: "Review diff" },
      ]),
    ).toBe("Stopped 2 background agents: Fix tests, Review diff");
  });

  test("starts Ledger verification only from the Agent prompt surface", async () => {
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
          isInteractive={false}
        />,
        async () => {
          const onSubmit = providerProbe.promptSubmits.at(-1);
          expect(onSubmit).toBeDefined();

          await onSubmit!("check whether my Ledger is authentic", {
            clearBuffer: vi.fn(),
            resetHistory: vi.fn(),
            setCursorOffset: vi.fn(),
          });

          expect(ledgerStatusProbe.refresh).toHaveBeenCalledOnce();
          expect(getLedgerVerificationSnapshot()).toMatchObject({
            phase: "waiting",
            source: "prompt",
            transcriptStartIndex: 0,
          });
        },
      );
    } finally {
      dismissLedgerVerification();
    }
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

  test("mirrors the canonical daemon context without rewriting the registry", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const calls: string[] = [];
    const requestedContext = {
      ...PERMISSION_CONTEXT,
      mode: "plan" as const,
    };
    const canonicalContext = { ...PERMISSION_CONTEXT };
    const setDaemonPermissionMode = vi.fn(
      async (mode: ToolPermissionContext["mode"]) => {
        calls.push(`daemon:${mode}`);
        Object.assign(canonicalContext, { mode });
        return { applied: true, previousMode: "default", mode };
      },
    );
    const updatePermissionContext = vi.fn(
      async (next: ToolPermissionContext) => {
        calls.push(`local:${next.mode}`);
      },
    );
    providerProbe.promptProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp
        session={createSession({
          permissionContext: canonicalContext,
          updatePermissionContext,
          setDaemonPermissionMode,
        })}
        isInteractive={false}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (
          promptProps.setToolPermissionContext as (
            next: ToolPermissionContext,
          ) => void
        )(requestedContext);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    );

    expect(setDaemonPermissionMode).toHaveBeenCalledWith("plan");
    expect(updatePermissionContext).not.toHaveBeenCalled();
    expect(providerProbe.currentAppState?.toolPermissionContext).toBe(
      canonicalContext,
    );
    expect(calls).toEqual(["daemon:plan"]);
  });

  test("keeps a daemon policy rewrite instead of restoring the requested auto context", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const canonicalContext = {
      ...PERMISSION_CONTEXT,
      isAutoModeAvailable: true,
    };
    const updatePermissionContext = vi.fn();
    const setDaemonPermissionMode = vi.fn(async () => {
      Object.assign(canonicalContext, {
        mode: "default" as const,
        autoModeActive: false,
        isAutoModeAvailable: false,
      });
      return {
        applied: false,
        previousMode: "default" as const,
        mode: "default" as const,
      };
    });
    providerProbe.promptProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp
        session={createSession({
          permissionContext: canonicalContext,
          updatePermissionContext,
          setDaemonPermissionMode,
        })}
        isInteractive={false}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (
          promptProps.setToolPermissionContext as (
            next: ToolPermissionContext,
          ) => void
        )({
          ...canonicalContext,
          mode: "auto",
          autoModeActive: true,
          isAutoModeAvailable: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    );

    expect(setDaemonPermissionMode).toHaveBeenCalledWith("auto");
    expect(updatePermissionContext).not.toHaveBeenCalled();
    expect(providerProbe.currentAppState?.toolPermissionContext).toBe(
      canonicalContext,
    );
    expect(canonicalContext).toMatchObject({
      mode: "default",
      autoModeActive: false,
      isAutoModeAvailable: false,
    });
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
        isInteractive={false}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (
          promptProps.setToolPermissionContext as (
            next: ToolPermissionContext,
          ) => void
        )({
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
    expect(providerProbe.currentAppState?.toolPermissionContext.mode).toBe(
      "default",
    );
  });

  test("projects a local permission context only after registry commit", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const updatePermissionContext = vi.fn(async () => {
      throw new Error("local publication rejected");
    });
    providerProbe.promptProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp
        session={createSession({ updatePermissionContext })}
        isInteractive={false}
      />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (
          promptProps.setToolPermissionContext as (
            next: ToolPermissionContext,
          ) => void
        )({ ...PERMISSION_CONTEXT, mode: "plan" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    );

    expect(updatePermissionContext).toHaveBeenCalledOnce();
    expect(providerProbe.currentAppState?.toolPermissionContext.mode).toBe(
      "default",
    );
  });

  test("mirrors the registry's frozen same-mode context into AppState", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    providerProbe.promptProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        const next = Object.freeze({
          ...PERMISSION_CONTEXT,
          alwaysAskRules: { session: ["Write"] },
        });
        await session.services.permissionModeRegistry.update?.(next);
        await vi.waitFor(() => {
          expect(providerProbe.currentAppState?.toolPermissionContext).toBe(
            session.services.permissionModeRegistry.current(),
          );
        });
        expect(Object.isFrozen(next)).toBe(true);
        expect(providerProbe.currentAppState?.toolPermissionContext).toBe(next);
      },
    );
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
    roleDefinitionProbe.mockClear();
    const roleWorkspaceCwd = join(tmpdir(), "agenc-tui-role-workspace-a");
    const executionCwd = join(tmpdir(), "agenc-tui-role-workspace-b");
    const session = createSession({ roleWorkspaceCwd, executionCwd });

    await renderApp(
      <AgenCTuiApp
        session={session}
        isInteractive={false}
      />,
    );

    const initial = providerProbe.appStateProps.at(-1)?.initialState as {
      agentDefinitions?: {
        activeAgents?: Array<{ agentType?: string }>;
        allAgents?: Array<{ agentType?: string }>;
      };
    };
    const active = initial.agentDefinitions?.activeAgents?.map(
      (agent) => agent.agentType,
    );
    const all = initial.agentDefinitions?.allAgents?.map(
      (agent) => agent.agentType,
    );

    expect(active).toEqual(
      expect.arrayContaining(["default", "scanner", "runner"]),
    );
    expect(all).toEqual(
      expect.arrayContaining(["default", "scanner", "runner"]),
    );
    expect(roleDefinitionProbe.mock.calls).toEqual([[roleWorkspaceCwd]]);
  });

  test("uses the session's canonical custom-agent catalog on the first render", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    providerProbe.appStateProps.length = 0;
    roleDefinitionProbe.mockClear();
    const roleWorkspaceCwd = join(tmpdir(), "agenc-tui-canonical-catalog");
    const canonicalCustomAgent = {
      agentType: "scanner",
      whenToUse: "Exact restrictive scanner",
      source: "projectSettings" as const,
      baseDir: join(roleWorkspaceCwd, ".agenc", "agents"),
      permissionMode: "plan" as const,
      disallowedTools: ["Write"],
      agentRoleFingerprint: "canonical-fingerprint",
      getSystemPrompt: () => "Exact restrictive scanner prompt",
    };
    const session = createSession({
      roleWorkspaceCwd,
      executionCwd: join(tmpdir(), "agenc-tui-execution-worktree"),
      agentDefinitions: {
        agentRoleWorkspaceId: roleWorkspaceCwd,
        activeAgents: [canonicalCustomAgent],
        allAgents: [canonicalCustomAgent],
      },
    });

    await renderApp(
      <AgenCTuiApp
        session={session}
        isInteractive={false}
      />,
    );

    const initial = providerProbe.appStateProps.at(-1)?.initialState as {
      agentDefinitions?: {
        activeAgents?: Array<Record<string, unknown>>;
      };
    };
    expect(initial.agentDefinitions?.activeAgents).toEqual([
      expect.objectContaining({
        agentType: "scanner",
        permissionMode: "plan",
        disallowedTools: ["Write"],
        agentRoleFingerprint: "canonical-fingerprint",
      }),
    ]);
    expect(roleDefinitionProbe).not.toHaveBeenCalled();
  });

  test("prioritizes a pending permission overlay over an elicitation overlay", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
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
              arguments: '{"file_path":"README.md"}',
            },
            source: "direct",
          },
        } as never);

        await new Promise((resolve) => setTimeout(resolve, 25));

        const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
        expect(layoutProps).toBeDefined();
        expect(
          containsElementNamed(layoutProps?.overlay, "AgenCPermissionOverlay"),
        ).toBe(true);
        expect(
          containsElementNamed(layoutProps?.overlay, "ElicitationOverlay"),
        ).toBe(false);

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
          expect(
            providerProbe.promptProps.some((props) => props.isLoading === true),
          ).toBe(false);

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

  test.each(["edit", "session"])("does not reuse a failed submission after a composer %s change", async change => {
    const { AgenCTuiApp } = await import("./App.js");
    resetShellSurfaceProbe();
    const session = {
      ...createSession(),
      submit: vi.fn(async (_message: string, _options?: { readonly clientMessageId?: string }) => {
        if (session.submit.mock.calls.length === 1) throw new Error("response dropped");
      }),
    } satisfies AgenCBridgeSession;
    const helpers = { clearBuffer: vi.fn(), resetHistory: vi.fn(), setCursorOffset: vi.fn() };
    await withRenderedApp(<AgenCTuiApp session={session} isInteractive={false} />, async () => {
      const send = () => (providerProbe.promptProps.at(-1)!.onSubmit as (value: string, helpers: typeof helpers) => Promise<void>)("same text", helpers);
      await send();
      await vi.waitFor(() => expect(providerProbe.promptProps.at(-1)).toMatchObject({ input: "same text", isLoading: false }));
      if (change === "edit") {
        const edit = providerProbe.promptProps.at(-1)!.onInputChange as (value: string) => void;
        edit("edited");
        edit("same text");
      } else {
        session.conversationId = "different-conversation";
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      await send();
      expect(session.submit).toHaveBeenCalledTimes(2);
      expect(session.submit.mock.calls[1]?.[1]?.clientMessageId).not.toBe(session.submit.mock.calls[0]?.[1]?.clientMessageId);
    });
  });

  test.each(["second prompt", "/reviewer audit this", "$reviewer audit this"])("keeps the newer %s submission and its retry identity when an old response fails late", async secondInput => {
    const { AgenCTuiApp } = await import("./App.js");
    resetShellSurfaceProbe();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<Array<{ type: string; text: string }>>();
    const getPromptForCommand = vi.fn(() => loaded.promise);
    mockTuiCommandList.push({ name: "reviewer", type: "prompt", loadedFrom: "skills", progressMessage: "Loading reviewer", contentLength: 1, getPromptForCommand });
    const subscribers = new Set<(event: unknown) => void>();
    const session = {
      ...createSession(),
      enqueueIdleInputBatchOwned: vi.fn(() => ({ token: "late-owned", firstSequence: 1, lastSequence: 1, count: 1 })),
      rollbackIdleInputAdmission: vi.fn(() => true),
      commitIdleInputAdmission: vi.fn(() => true),
      submit: vi.fn((_message: string, _options?: { readonly clientMessageId?: string }) => session.submit.mock.calls.length === 1 ? first.promise : second.promise),
      subscribeToEvents: (subscriber: (event: unknown) => void) => { subscribers.add(subscriber); return () => { subscribers.delete(subscriber); }; },
    } satisfies AgenCBridgeSession;
    const helpers = { clearBuffer: vi.fn(), resetHistory: vi.fn(), setCursorOffset: vi.fn() };
    await withRenderedApp(<AgenCTuiApp session={session} isInteractive={false} />, async () => {
      const send = (value: string) => (providerProbe.promptProps.at(-1)!.onSubmit as (value: string, helpers: typeof helpers) => Promise<void>)(value, helpers);
      const firstAttempt = send("first prompt");
      await vi.waitFor(() => expect(session.submit).toHaveBeenCalledOnce());
      const firstId = session.submit.mock.calls[0]?.[1]?.clientMessageId;
      for (const subscriber of subscribers) subscriber({ type: "turn_started", clientMessageId: firstId, payload: { turnId: "first-turn" } });
      await new Promise(resolve => setTimeout(resolve, 25));
      for (const subscriber of subscribers) subscriber({ type: "turn_complete", clientMessageId: firstId, payload: { turnId: "first-turn", lastAgentMessage: "Done" } });
      await vi.waitFor(() => expect(providerProbe.promptProps.at(-1)?.isLoading).toBe(false));
      const secondAttempt = send(secondInput);
      if (secondInput === "second prompt") {
        await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(2));
      } else {
        await vi.waitFor(() => expect(getPromptForCommand).toHaveBeenCalledOnce());
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      first.reject(new Error("old response dropped"));
      await firstAttempt;
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(providerProbe.promptProps.at(-1)).toMatchObject({ input: "", isLoading: true });
      loaded.resolve([{ type: "text", text: "expanded delayed skill" }]);
      await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(2));
      second.reject(new Error("new response dropped"));
      await secondAttempt;
      await vi.waitFor(() => expect(providerProbe.promptProps.at(-1)).toMatchObject({ input: secondInput, isLoading: false }));
      session.submit.mockResolvedValueOnce();
      await send(secondInput);
      expect(session.submit.mock.calls[2]).toEqual(session.submit.mock.calls[1]);
      expect(session.submit.mock.calls[1]?.[1]?.clientMessageId).not.toBe(firstId);
    });
  });

  test("atomically rejects startup input batches with a visible notification", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const enqueueIdleInputBatch = vi.fn(() => {
      throw new Error(
        "Session mailbox is full; startup input was not submitted.",
      );
    });
    const session = {
      ...createSession({ enqueueIdleInputBatch }),
      submit: vi.fn(async () => {}),
      enqueueIdleInput: vi.fn(() => 1),
    } satisfies AgenCBridgeSession;

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        isInteractive={false}
        initialUserMessages={[
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ]}
      />,
      async ({ output }) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(enqueueIdleInputBatch).toHaveBeenCalledWith([
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ]);
        expect(enqueueIdleInputBatch).toHaveBeenCalledTimes(1);
        expect(session.enqueueIdleInput).not.toHaveBeenCalled();
        expect(session.submit).not.toHaveBeenCalled();
        const visibleFrame = stripAnsi(
          extractLastSynchronizedFrame(output()),
        ).replace(/\s+/gu, "");
        expect(visibleFrame).toContain(
          "Sessionmailboxisfull;startupinputwasnotsubmitted.",
        );
      },
    );
  });

  test("rolls back owned startup context when prompt submission rejects", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const enqueueIdleInputBatchOwned = vi.fn(() => ({
      token: "owned-startup",
      firstSequence: 1,
      lastSequence: 1,
      count: 1,
    }));
    const rollbackIdleInputAdmission = vi.fn(() => true);
    const commitIdleInputAdmission = vi.fn(() => true);
    const session = {
      ...createSession(),
      enqueueIdleInputBatchOwned,
      rollbackIdleInputAdmission,
      commitIdleInputAdmission,
      submit: vi.fn(async () => {
        throw new Error("startup submit rejected");
      }),
    } satisfies AgenCBridgeSession;

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        isInteractive={false}
        initialPrompt="start now"
        initialUserMessages={[
          { role: "user", content: "owned startup context" },
        ]}
      />,
      async ({ output }) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rollbackIdleInputAdmission).toHaveBeenCalledWith(
          "owned-startup",
        );
        expect(commitIdleInputAdmission).not.toHaveBeenCalled();
        const visibleFrame = stripAnsi(
          extractLastSynchronizedFrame(output()),
        ).replace(/\s+/gu, "");
        expect(visibleFrame).toContain("startupsubmitrejected");
      },
    );
  });

  test("rolls back owned startup context for a locally handled command", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    mockTuiCommandList.push({
      name: "help",
      type: "local",
      load: vi.fn(),
    });
    const rollbackIdleInputAdmission = vi.fn(() => true);
    const commitIdleInputAdmission = vi.fn(() => true);
    const session = {
      ...createSession(),
      enqueueIdleInputBatchOwned: vi.fn(() => ({
        token: "owned-local-startup",
        firstSequence: 1,
        lastSequence: 1,
        count: 1,
      })),
      rollbackIdleInputAdmission,
      commitIdleInputAdmission,
      submit: vi.fn(async () => {}),
    } satisfies AgenCBridgeSession;

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
        isInteractive={false}
        initialPrompt="$help"
        initialUserMessages={[{ role: "user", content: "must not leak" }]}
      />,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(session.submit).not.toHaveBeenCalled();
        expect(rollbackIdleInputAdmission).toHaveBeenCalledWith(
          "owned-local-startup",
        );
        expect(commitIdleInputAdmission).not.toHaveBeenCalled();
      },
    );
  });

  describe.each(["/", "$"])("%s prompt submission transaction", (prefix) => {
    test.each([
      "success",
      "load rejection",
      "admission rejection",
      "submit rejection",
      "cancellation",
      "late failure",
      "rollback failure",
      "commit failure",
    ])("settles %s", async (outcome) => {
      const { AgenCTuiApp } = await import("./App.js");
      resetShellSurfaceProbe();
      const input = `${prefix}reviewer audit this`;
      const events: string[] = [];
      const subscribers = new Set<(event: unknown) => void>();
      const failure = new Error(outcome);
      if (outcome === "cancellation") failure.name = "AbortError";
      const emitCompletion = () => {
        for (const subscriber of subscribers) {
          subscriber({
            type: "turn_started",
            payload: { turnId: "prompt-turn" },
          });
          subscriber({
            type: "turn_complete",
            payload: { turnId: "prompt-turn", lastAgentMessage: "Done" },
          });
        }
      };
      const getPromptForCommand = vi.fn(async () => {
        events.push("load");
        if (outcome === "load rejection") throw failure;
        return [{ type: "text", text: "expanded reviewer prompt" }];
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
        enqueueIdleInputBatchOwned: vi.fn(() => {
          events.push("admit");
          if (outcome === "admission rejection") throw failure;
          return {
            token: "prompt-admission",
            firstSequence: 1,
            lastSequence: 3,
            count: 3,
          };
        }),
        commitIdleInputAdmission: vi.fn(() => {
          events.push("commit");
          if (outcome === "commit failure") throw failure;
          return true;
        }),
        rollbackIdleInputAdmission: vi.fn(() => {
          events.push("rollback");
          if (outcome === "rollback failure") throw failure;
          return outcome !== "late failure";
        }),
        submit: vi.fn(async () => {
          events.push("submit");
          if (outcome === "late failure") emitCompletion();
          if (
            outcome === "submit rejection" ||
            outcome === "cancellation" ||
            outcome === "late failure" ||
            outcome === "rollback failure"
          ) {
            throw failure;
          }
        }),
        subscribeToEvents: (subscriber: (event: unknown) => void) => {
          subscribers.add(subscriber);
          return () => {
            subscribers.delete(subscriber);
          };
        },
      } satisfies AgenCBridgeSession;
      const helpers = {
        clearBuffer: vi.fn(),
        resetHistory: vi.fn(),
        setCursorOffset: vi.fn(),
      };
      const pastedContents = {
        0: {
          id: 0,
          type: "image",
          content: "base64-image",
          mediaType: "image/png",
          filename: "prompt.png",
        },
      };
      await withRenderedApp(
        <AgenCTuiApp session={session} isInteractive={false} />,
        async () => {
          const promptProps = providerProbe.promptProps.at(-1)!;
          (promptProps.onInputChange as (value: string) => void)(input);
          (promptProps.setPastedContents as (value: unknown) => void)(
            pastedContents,
          );
          await vi.waitFor(() => {
            expect(providerProbe.promptProps.at(-1)?.input).toBe(input);
          });
          const onSubmit = providerProbe.promptProps.at(-1)?.onSubmit as (
            input: string,
            helpers: typeof helpers,
          ) => Promise<void>;
          await expect(onSubmit(input, helpers)).resolves.toBeUndefined();

          const accepted = ["success", "commit failure"].includes(outcome);
          const admitted =
            outcome !== "load rejection" && outcome !== "admission rejection";
          const restored =
            !accepted &&
            outcome !== "late failure" &&
            outcome !== "rollback failure";
          expect(getPromptForCommand).toHaveBeenCalledOnce();
          expect(session.submit).toHaveBeenCalledTimes(admitted ? 1 : 0);
          if (admitted) {
            expect(session.enqueueIdleInputBatchOwned).toHaveBeenCalledWith(
              [
                expect.objectContaining({ content: expect.any(Array) }),
                expect.stringContaining("<command-name>$reviewer</command-name>"),
                { content: [{ type: "text", text: "expanded reviewer prompt" }] },
              ],
              { workspaceView: "agent" },
            );
            expect(session.submit).toHaveBeenCalledWith("", {
              source: "user",
              clientMessageId: expect.any(String),
              displayUserMessage: input,
            });
          }
          expect(session.commitIdleInputAdmission).toHaveBeenCalledTimes(
            accepted ? 1 : 0,
          );
          expect(session.rollbackIdleInputAdmission).toHaveBeenCalledTimes(
            admitted && !accepted ? 1 : 0,
          );
          if (accepted) {
            expect(events.indexOf("commit")).toBeGreaterThan(
              events.indexOf("submit"),
            );
          }
          if (outcome !== "success") {
            await vi.waitFor(() => {
              expect(
                JSON.stringify(providerProbe.currentAppState?.notifications),
              ).toContain(outcome);
              expect(providerProbe.promptProps.at(-1)).toMatchObject({
                input: restored ? input : "",
                pastedContents: restored ? pastedContents : {},
                ...(!accepted ? { isLoading: false } : {}),
              });
            });
          }
          emitCompletion();
          await vi.waitFor(() => {
            expect(providerProbe.promptProps.at(-1)).toMatchObject({
              input: restored ? input : "",
              pastedContents: restored ? pastedContents : {},
              isLoading: false,
            });
          });
        },
      );
    });

    test.each(["success", "failure"])(
      "preserves a newer draft across delayed load %s",
      async (outcome) => {
        const { AgenCTuiApp } = await import("./App.js");
        resetShellSurfaceProbe();
        const loaded = Promise.withResolvers<unknown[]>();
        const getPromptForCommand = vi.fn(() => loaded.promise);
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
          enqueueIdleInput: vi.fn(() => 1),
          submit: vi.fn(async () => {}),
        } satisfies AgenCBridgeSession;
        const helpers = {
          clearBuffer: vi.fn(),
          resetHistory: vi.fn(),
          setCursorOffset: vi.fn(),
        };
        const originalAttachment = {
          0: { id: 0, type: "text", content: "original attachment" },
        };
        const nextAttachment = {
          1: { id: 1, type: "text", content: "new attachment" },
        };
        await withRenderedApp(
          <AgenCTuiApp session={session} isInteractive={false} />,
          async () => {
            (providerProbe.promptProps.at(-1)?.setPastedContents as (
              value: unknown,
            ) => void)(originalAttachment);
            await vi.waitFor(() => {
              expect(providerProbe.promptProps.at(-1)?.pastedContents).toEqual(
                originalAttachment,
              );
            });
            const pending = providerProbe.promptSubmits.at(-1)!(
              `${prefix}reviewer audit this`,
              helpers,
            );
            await vi.waitFor(() => {
              expect(getPromptForCommand).toHaveBeenCalledOnce();
              expect(providerProbe.promptProps.at(-1)).toMatchObject({
                input: "",
                pastedContents: {},
              });
            });
            (providerProbe.promptProps.at(-1)?.onInputChange as (
              value: string,
            ) => void)("new draft");
            (providerProbe.promptProps.at(-1)?.setPastedContents as (
              value: unknown,
            ) => void)(nextAttachment);
            await vi.waitFor(() => {
              expect(providerProbe.promptProps.at(-1)?.input).toBe("new draft");
            });
            if (outcome === "success") {
              loaded.resolve([{ type: "text", text: "expanded prompt" }]);
            } else {
              loaded.reject(new Error("prompt load rejected"));
            }
            await pending;
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(providerProbe.promptProps.at(-1)).toMatchObject({
              input: "new draft",
              pastedContents: nextAttachment,
            });
            expect(session.submit).toHaveBeenCalledTimes(
              outcome === "success" ? 1 : 0,
            );
          },
        );
      },
    );
  });

  test("passes current transcript messages to dollar skill commands", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    resetShellSurfaceProbe();
    const getPromptForCommand = vi.fn(
      async (_args: string, context: unknown) => {
        const messages =
          (context as { messages?: readonly unknown[] }).messages ?? [];
        return [{ type: "text", text: `message-count:${messages.length}` }];
      },
    );
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
          isInteractive={false}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(providerProbe.messageProps.at(-1)?.messages).toHaveLength(1);
      expect(providerProbe.promptProps.at(-1)?.commands).toContainEqual(
        expect.objectContaining({ name: "reviewer", type: "prompt" }),
      );

      const onSubmit = providerProbe.promptProps.at(-1)?.onSubmit as
        ((input: string, helpers: typeof helpers) => Promise<void>) | undefined;
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
        source: "user",
        clientMessageId: expect.any(String),
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
      <AgenCTuiApp session={session} isInteractive={false} />,
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
      <AgenCTuiApp session={session} isInteractive={false} />,
    );

    expect(output).toContain("spinner:tool-use:Running");
    const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
    expect(layoutProps).toBeDefined();
    expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(
      true,
    );
    expect(
      containsElementNamed(layoutProps?.scrollable, "SpinnerWithVerb"),
    ).toBe(false);
    expect(providerProbe.spinnerProps.at(-1)).toEqual(
      expect.objectContaining({
        mode: "tool-use",
        hasActiveTools: true,
        overrideMessage: "Running tools",
      }),
    );
    expect(providerProbe.messageProps.at(-1)).toEqual(
      expect.objectContaining({
        streamingText: "I will inspect that now.",
      }),
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
      <AgenCTuiApp session={session} isInteractive={false} />,
    );

    expect(output).toContain("spinner:responding:");
    const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
    expect(layoutProps).toBeDefined();
    expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(
      true,
    );
    expect(providerProbe.spinnerProps.at(-1)).toEqual(
      expect.objectContaining({
        mode: "responding",
        hasActiveTools: false,
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
      <AgenCTuiApp session={session} isInteractive={false} />,
    );

    expect(output).toContain("spinner:responding:");
    const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
    expect(layoutProps).toBeDefined();
    expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(
      true,
    );
    expect(providerProbe.spinnerProps.at(-1)).toEqual(
      expect.objectContaining({
        mode: "responding",
        hasActiveTools: false,
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
            partialJson: '{"file_path":"README.md"',
          },
        },
      ],
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    const output = await renderApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
    );

    expect(output).toContain("spinner:tool-input:");
    const layoutProps = providerProbe.fullscreenLayoutProps.at(-1);
    expect(layoutProps).toBeDefined();
    expect(containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb")).toBe(
      true,
    );
    expect(providerProbe.spinnerProps.at(-1)).toEqual(
      expect.objectContaining({
        mode: "tool-input",
        hasActiveTools: true,
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
      <AgenCTuiApp session={session} isInteractive={false} />,
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
        expect(
          containsElementNamed(layoutProps?.bottom, "SpinnerWithVerb"),
        ).toBe(true);
        expect(
          containsElementNamed(layoutProps?.scrollable, "SpinnerWithVerb"),
        ).toBe(false);
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
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        const firstMessageProps = providerProbe.messageProps.at(-1);
        const onInputChange = providerProbe.promptProps.at(-1)
          ?.onInputChange as ((input: string) => void) | undefined;
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
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        expect(providerProbe.mcpConnectivityProps.at(-1)).toEqual({
          mcpClients,
          mcpServers: [],
        });
        const promptProps = providerProbe.promptProps.at(-1)!;
        expect(promptProps).toEqual(
          expect.objectContaining({
            mcpClients,
            getToolUseContext: expect.any(Function),
          }),
        );

        const context = (
          promptProps.getToolUseContext as (
            messages: unknown[],
            newMessages: unknown[],
            abortController: AbortController,
          ) => {
            readonly options: {
              readonly tools: readonly unknown[];
              readonly mcpClients: readonly unknown[];
              readonly refreshTools: () => readonly unknown[];
            };
          }
        )([], [], new AbortController());

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
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        let promptProps = providerProbe.promptProps.at(-1)!;
        let context = (
          promptProps.getToolUseContext as (
            messages: unknown[],
            newMessages: unknown[],
            abortController: AbortController,
          ) => {
            readonly options: {
              readonly tools: readonly unknown[];
              readonly mcpClients: readonly unknown[];
            };
          }
        )([], [], new AbortController());

        expect(context.options.mcpClients).toBe(clientGenerations[0]);
        expect(context.options.tools).toContain(firstTool);

        generation = 1;
        notifySessionEvent?.();
        await new Promise((resolve) => setTimeout(resolve, 25));

        promptProps = providerProbe.promptProps.at(-1)!;
        context = (
          promptProps.getToolUseContext as (
            messages: unknown[],
            newMessages: unknown[],
            abortController: AbortController,
          ) => {
            readonly options: {
              readonly tools: readonly unknown[];
              readonly mcpClients: readonly unknown[];
            };
          }
        )([], [], new AbortController());

        expect(context.options.mcpClients).toBe(clientGenerations[1]);
        expect(context.options.tools).toContain(secondTool);
        expect(context.options.tools).not.toContain(firstTool);
      },
    );
  });

  test("uses daemon MCP status subscriptions without treating passive tools as executable", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const passiveTool = {
      serverName: "files",
      name: "mcp.files.search",
    } as const;
    let surface: McpSurfaceSnapshot = {
      revision: 1,
      servers: [
        {
          name: "files",
          transport: "stdio",
          enabled: true,
          required: false,
          state: "connected",
          displayTarget: "server.js",
          toolCount: 1,
        },
      ],
      tools: [passiveTool],
    };
    let notifyMcpSurface:
      | ((snapshot: McpSurfaceSnapshot) => void)
      | undefined;
    const unsubscribeMcpSurface = vi.fn();
    const passiveBaseSession = createSession();
    delete passiveBaseSession.listMcpClients;
    delete passiveBaseSession.listMcpTools;
    const session = {
      ...passiveBaseSession,
      // The daemon exposes tool identity only through the passive snapshot. It
      // is not a callable Tool instance and must not reach model contexts.
      mcpSurfaceSnapshot: vi.fn(() => surface),
      refreshMcpSurface: vi.fn(async () => surface),
      subscribeToMcpSurface: vi.fn(
        (callback: (snapshot: McpSurfaceSnapshot) => void) => {
          notifyMcpSurface = callback;
          return unsubscribeMcpSurface;
        },
      ),
    } satisfies AgenCBridgeSession;
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        expect(session.subscribeToMcpSurface).toHaveBeenCalledTimes(1);
        expect(session.refreshMcpSurface).toHaveBeenCalledTimes(1);
        expect(providerProbe.mcpConnectivityProps.at(-1)).toEqual({
          mcpClients: [],
          mcpServers: surface.servers,
        });

        const promptProps = providerProbe.promptProps.at(-1)!;
        const context = (
          promptProps.getToolUseContext as (
            messages: unknown[],
            newMessages: unknown[],
            abortController: AbortController,
          ) => {
            readonly options: {
              readonly tools: readonly unknown[];
              readonly mcpClients: readonly unknown[];
            };
          }
        )([], [], new AbortController());
        expect(context.options.mcpClients).toEqual([]);
        expect(context.options.tools).not.toContain(passiveTool);

        const permissionAbort = new AbortController();
        let permissionSettled = false;
        const permission = session.services.approvalResolver!.request({
          callId: "passive-mcp-permission",
          toolName: passiveTool.name,
          turnId: "turn-mcp",
          signal: permissionAbort.signal,
          invocation: {
            session: {} as never,
            turn: {} as never,
            tracker: {
              appendFileDiff() {},
              snapshot: () => [],
              clear() {},
            },
            callId: "passive-mcp-permission",
            toolName: { name: passiveTool.name },
            payload: {
              kind: "mcp",
              rawArguments: '{"query":"status"}',
            },
            source: "direct",
          },
        } as never);
        void permission.then(() => {
          permissionSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        // The passive descriptor is valid for the name-only approval display
        // contract, so the fail-closed resolver must not auto-deny it.
        expect(permissionSettled).toBe(false);
        permissionAbort.abort();
        await expect(permission).resolves.toEqual({ kind: "abort" });

        surface = {
          revision: 2,
          servers: [
            {
              ...surface.servers[0]!,
              state: "failed",
            },
          ],
          tools: [],
        };
        notifyMcpSurface?.(surface);
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.mcpConnectivityProps.at(-1)).toEqual({
          mcpClients: [],
          mcpServers: surface.servers,
        });
      },
    );

    expect(unsubscribeMcpSurface).toHaveBeenCalledTimes(1);
  });

  test("mounts global keybindings against the live transcript state", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    providerProbe.globalKeybindingProps.length = 0;
    providerProbe.messageProps.length = 0;

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
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
        await (
          selectorProps.onRestoreMessage as (message: unknown) => Promise<void>
        )((selectorProps.messages as unknown[])[0]);
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
    };
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
      async ({ output }) => {
        expect(providerProbe.costSummaryGetters.at(-1)).toBe(
          providerProbe.fpsGetters.at(-1),
        );
        expect(session.setStreamMode).toEqual(expect.any(Function));
        expect(session.setResponseLength).toEqual(expect.any(Function));
        expect(session.onCompactProgress).toEqual(expect.any(Function));

        session.onCompactProgress?.({
          type: "hooks_start",
          hookType: "pre_compact",
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(stripAnsi(output())).toMatch(
          /Running[\s\S]*PreCompact[\s\S]*hooks/,
        );

        session.onCompactProgress?.({ type: "compact_start" });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(stripAnsi(output())).toContain("Compacting");

        session.setResponseLength?.((length) => length + 8);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(output()).toMatch(/8[\s\S]*chars/);

        session.onCompactProgress?.({ type: "compact_end" });
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    );

    expect(session.setStreamMode).toBeUndefined();
    expect(session.setResponseLength).toBeUndefined();
    expect(session.onCompactProgress).toBeUndefined();
  });

  test("routes exit through worktree ExitFlow only for active worktree sessions", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    resetShellSurfaceProbe();
    mockWorktreeSession = { worktreePath: "/tmp/worktree" };

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.onExit as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(providerProbe.inkExit).not.toHaveBeenCalled();
        expect(providerProbe.exitFlowProps.at(-1)).toEqual(
          expect.objectContaining({
            showWorktree: true,
            beforeWorktreeMutation: expect.any(Function),
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

  test.each([
    {
      label: "ordinary exit",
      request: "plain" as const,
      expectedResumeSessionId: null,
    },
    {
      label: "session resume",
      request: "resume" as const,
      expectedResumeSessionId: "session-next",
    },
  ])(
    "returns worktree $label through the Ink lifecycle boundary",
    async ({ request, expectedResumeSessionId }) => {
      const {
        consumePendingResumeSessionId,
        resetPendingResumeSessionIdForTestingOnly,
      } = await import("../pending-resume.js");
      const { AgenCTuiApp } = await import("./App.js");
      resetShellSurfaceProbe();
      resetPendingResumeSessionIdForTestingOnly();
      mockWorktreeSession = { worktreePath: "/tmp/worktree" };

      try {
        await withRenderedApp(
          <AgenCTuiApp
            session={createSession()}
            isInteractive={false}
          />,
          async () => {
            await requestConcurrentAppExit(request);
            await vi.waitFor(() => {
              expect(providerProbe.exitFlowProps.at(-1)).toEqual(
                expect.objectContaining({
                  showWorktree: true,
                  onDone: expect.any(Function),
                }),
              );
            });

            const completed = await (
              providerProbe.exitFlowProps.at(-1)!.onDone as () =>
                boolean | Promise<boolean>
            )();

            expect(completed).toBe(false);
            expect(providerProbe.inkExit).toHaveBeenCalledTimes(1);
            expect(consumePendingResumeSessionId()).toBe(
              expectedResumeSessionId,
            );
          },
        );
      } finally {
        resetPendingResumeSessionIdForTestingOnly();
        resetShellSurfaceProbe();
      }
    },
  );

  test("renders and acknowledges the cost threshold dialog when billing access is available", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const session = createSession();
    resetShellSurfaceProbe();
    mockTotalCost = 5;
    mockHasConsoleBillingAccess = true;

    await withRenderedApp(
      <AgenCTuiApp
        session={session}
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
        isInteractive={false}
        initialUserMessages={[{ role: "user", content: "summarize this" }]}
      />,
      async ({ output }) => {
        const promptProps = providerProbe.promptProps.at(-1)!;
        (promptProps.onMessageActionsEnter as () => void)();
        await new Promise((resolve) => setTimeout(resolve, 25));

        const selectorProps = providerProbe.messageSelectorProps.at(-1)!;
        await (
          selectorProps.onRestoreCode as (message: unknown) => Promise<void>
        )({
          type: "user",
          uuid: "restore-code",
          message: { role: "user", content: "edit this" },
        });
        expect(providerProbe.fileHistoryRewind).toHaveBeenCalledWith(
          expect.any(Function),
          "restore-code",
        );

        const selectedMessage = (selectorProps.messages as unknown[])[0]!;
        await (
          selectorProps.onRestoreMessage as (message: unknown) => Promise<void>
        )(selectedMessage);
        await (
          selectorProps.onSummarize as (
            message: unknown,
            feedback?: string,
            direction?: "from" | "up_to",
          ) => Promise<void>
        )(selectedMessage, "keep decisions", "from");
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
        await (
          selectorProps.onRestoreMessage as (message: unknown) => Promise<void>
        )(selectedMessage);
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
          (
            selectorProps.onRestoreMessage as (
              message: unknown,
            ) => Promise<void>
          )(selectedMessage),
        ).rejects.toThrow(/current turn/);
        await expect(
          (
            selectorProps.onSummarize as (
              message: unknown,
              feedback?: string,
              direction?: "from" | "up_to",
            ) => Promise<void>
          )(selectedMessage, undefined, "up_to"),
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
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const session = createSession({
      configStore: createAppConfigStore(defaultConfig(), agencHome),
    });
    const fetchSpy = mockOfflineOnboardingFetch();
    const previousApiKeyStatus = apiKeyVerificationProbe.status;
    apiKeyVerificationProbe.status = "missing";
    try {
      const output = await renderApp(
        <AgenCTuiApp
          session={session}
          isInteractive={true}
        />,
      );

      // The onboarding header now uses the lowercase "agenc." brand mark
      // instead of "Welcome to AgenC"; the active step title still proves the
      // first-run wizard (not the transcript) is on screen.
      expect(output).toContain("agenc");
      expect(output).toContain("Preflight");
      expect(output).not.toContain("messages:0");
      expect(providerProbe.promptProps.at(-1)).toEqual(
        expect.objectContaining({
          apiKeyStatus: "valid",
          onboardingInput: expect.objectContaining({
            placeholder: "Press Enter to start setup",
            allowEmptySubmit: true,
          }),
        }),
      );
    } finally {
      apiKeyVerificationProbe.status = previousApiKeyStatus;
      fetchSpy.mockRestore();
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("suppresses first-run onboarding in noninteractive renders", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const session = createSession({
      configStore: createAppConfigStore(defaultConfig(), agencHome),
    });
    try {
      const output = await renderApp(
        <AgenCTuiApp
          session={session}
          isInteractive={false}
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
      <AgenCTuiApp session={session} isInteractive={false} />,
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
          source: "user",
          clientMessageId: expect.any(String),
          displayUserMessage: "ordinary message",
        });
      },
    );
  });

  test("rejects session-changing slash commands while the live session is busy", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { getCommandQueueSnapshot, resetCommandQueueForTesting } =
      await import("../../utils/messageQueueManager.js");
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
    resetCommandQueueForTesting();

    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          isInteractive={false}
        />,
        async () => {
          const onSubmit = providerProbe.promptSubmits.at(-1);
          expect(onSubmit).toBeDefined();

          for (const command of ["/agents", "/resume", "/sessions"]) {
            await onSubmit!(command, helpers);
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(submit).not.toHaveBeenCalled();
            expect(dispatchSpy).not.toHaveBeenCalled();
            expect(getCommandQueueSnapshot()).toEqual([]);
          }
        },
      );
    } finally {
      dispatchSpy.mockRestore();
      resetCommandQueueForTesting();
    }
  });

  test.each([
    ["grok-login", "grok-login", "text"],
    ["grok-login", "xai-login", "error"],
    ["grok-logout", "grok-logout", "error"],
    ["grok-logout", "xai-logout", "text"],
    ["openai-login", "openai-login", "text"],
    ["openai-login", "chatgpt-login", "error"],
    ["openai-logout", "openai-logout", "error"],
    ["openai-logout", "chatgpt-logout", "text"],
  ] as const)("keeps provider auth outcomes visible for %s via /%s (%s)", async (canonical, invocation, kind) => {
    const { AgenCTuiApp } = await import("./App.js");
    const { xaiAuthCommands } = await import("../../commands/xai-auth.js");
    const { openaiAuthCommands } = await import("../../commands/openai-auth.js");
    const command = [...xaiAuthCommands, ...openaiAuthCommands].find(
      (candidate) => candidate.name === canonical,
    )!;
    const message = `${canonical} ${kind} outcome`;
    const expectedDisplay = kind === "error" ? `Error: ${message}` : message;
    // Keep the actual registry and dispatcher, including canonical alias
    // resolution. Replace only the credential-bearing command execution.
    const execute = vi.spyOn(command, "execute").mockImplementation(async (ctx) => {
      if (canonical.endsWith("-login")) {
        ctx.appState?.setToolJSX?.({
          jsx: React.createElement("ink-text", null, "authorization pending"),
          isLocalJSXCommand: true,
          shouldHidePromptInput: false,
        });
        ctx.appState?.setToolJSX?.({
          jsx: null,
          shouldHidePromptInput: false,
          clearLocalJSX: true,
        });
      }
      return kind === "error"
        ? { kind, message }
        : { kind, text: message };
    });
    const submit = vi.fn(async () => {});
    const session = { ...createSession(), submit } satisfies AgenCBridgeSession;
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    resetShellSurfaceProbe();
    try {
      await withRenderedApp(
        <AgenCTuiApp session={session} isInteractive={false} />,
        async ({ output }) => {
          vi.useFakeTimers();
          try {
            await providerProbe.promptSubmits.at(-1)!(`/${invocation}`, helpers);
            await vi.advanceTimersByTimeAsync(0);
            expect(stripAnsi(output()).replaceAll(/\s/g, "")).toContain(
              `${kind}outcome`,
            );
            await vi.advanceTimersByTimeAsync(4_000);
            await vi.advanceTimersByTimeAsync(50);
            // Inspect the current rendered state, not accumulated terminal
            // output, which also contains messages that already disappeared.
            expect(providerProbe.messageProps.at(-1)?.toolJSX).toMatchObject({
              jsx: { props: { children: { props: { children: expectedDisplay } } } },
              shouldHidePromptInput: false,
            });
            expect(execute).toHaveBeenCalledOnce();
            expect(submit).not.toHaveBeenCalled();

            await providerProbe.promptSubmits.at(-1)!("/unknown-auth-result-fixture", helpers);
            await vi.advanceTimersByTimeAsync(4_000);
            await vi.advanceTimersByTimeAsync(50);
            expect(providerProbe.messageProps.at(-1)?.toolJSX).toBeNull();
            expect(submit).not.toHaveBeenCalled();
          } finally {
            vi.useRealTimers();
          }
        },
      );
    } finally {
      execute.mockRestore();
    }
  });

  test("a slash command that provisions the session and then queues a prompt still gets its prompt submitted", async () => {
    // A deferred daemon session reports a placeholder conversation id until it
    // is provisioned, then the live `conv-*` id. The queue owner used to be
    // memoized on that id: provisioning rebuilt the owner, its cleanup deleted
    // the prompt queued under the old one, and `/goal <objective>` on a cold
    // TUI set the goal but never started working.
    const { AgenCTuiApp } = await import("./App.js");
    const { goalCommand } = await import("../../commands/goal.js");
    const {
      getCommandQueueSnapshot,
      getSoleActiveCommandQueueOwnerForTesting,
      resetCommandQueueForTesting,
    } = await import("../../utils/messageQueueManager.js");
    let conversationId = "agenc-tui-idle-4242";
    const execute = vi.spyOn(goalCommand, "execute").mockImplementation(async () => {
      conversationId = "conv-live-session";
      return { kind: "prompt", content: "Work toward this goal until the runtime confirms it is met" };
    });
    const submit = vi.fn(async () => {});
    const session = {
      ...createSession(),
      submit,
      get conversationId() {
        return conversationId;
      },
    } as AgenCBridgeSession;
    const helpers = { clearBuffer: vi.fn(), resetHistory: vi.fn(), setCursorOffset: vi.fn() };
    resetShellSurfaceProbe();
    resetCommandQueueForTesting();
    try {
      await withRenderedApp(
        <AgenCTuiApp session={session} isInteractive={false} />,
        async () => {
          const ownerBefore = getSoleActiveCommandQueueOwnerForTesting();
          await providerProbe.promptSubmits.at(-1)!("/goal npm test passes", helpers);
          await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
          expect(String(submit.mock.calls[0]?.[0])).toContain("Work toward this goal");
          expect(getCommandQueueSnapshot()).toEqual([]);
          // Same mount, same owner: the id change did not rebuild it.
          expect(getSoleActiveCommandQueueOwnerForTesting()?.mountId).toBe(ownerBefore?.mountId);
          expect(session.conversationId).toBe("conv-live-session");
        },
      );
    } finally {
      execute.mockRestore();
      resetCommandQueueForTesting();
    }
  });

  test("clears a persistent sign-in error on the next prompt submission", async () => {
    // A timed-out /grok-login is shown persistently (no 3s timer). The next
    // submission must clear it; before the fix the clear path returned early
    // when no timer was armed, so the error box outlived the whole session.
    const { AgenCTuiApp } = await import("./App.js");
    const { xaiAuthCommands } = await import("../../commands/xai-auth.js");
    const command = xaiAuthCommands.find((candidate) => candidate.name === "grok-login")!;
    const execute = vi.spyOn(command, "execute").mockImplementation(async () => ({
      kind: "error",
      message: "Timed out waiting for the browser sign-in.",
    }));
    const submit = vi.fn(async () => {});
    const session = { ...createSession(), submit } satisfies AgenCBridgeSession;
    const helpers = { clearBuffer: vi.fn(), resetHistory: vi.fn(), setCursorOffset: vi.fn() };
    resetShellSurfaceProbe();
    try {
      await withRenderedApp(
        <AgenCTuiApp session={session} isInteractive={false} />,
        async () => {
          vi.useFakeTimers();
          try {
            await providerProbe.promptSubmits.at(-1)!("/grok-login", helpers);
            await vi.advanceTimersByTimeAsync(4_000);
            await vi.advanceTimersByTimeAsync(50);
            expect(providerProbe.messageProps.at(-1)?.toolJSX).toMatchObject({
              jsx: { props: { children: { props: { children: "Error: Timed out waiting for the browser sign-in." } } } },
            });

            await providerProbe.promptSubmits.at(-1)!("hello again", helpers);
            await vi.advanceTimersByTimeAsync(50);
            expect(providerProbe.messageProps.at(-1)?.toolJSX).toBeNull();
            expect(submit).toHaveBeenCalledOnce();
          } finally {
            vi.useRealTimers();
          }
        },
      );
    } finally {
      execute.mockRestore();
    }
  });

  test("keeps the canonical model menu open after a prior transient result expires", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const dispatcher = await import("../../commands/dispatcher.js");
    function CanonicalModelMenuFixture(): React.ReactNode {
      return React.createElement("ink-text", null, "canonical model menu");
    }
    const dispatchSpy = vi
      .spyOn(dispatcher, "dispatchSlashCommand")
      .mockImplementation(async (parsed, context) => {
        if (parsed.name === "notice") {
          return {
            result: { kind: "text", text: "temporary command result" },
            immediate: true,
            trace: {
              name: "notice",
              aliasUsed: "notice",
              argsRaw: "",
              sensitive: false,
              immediate: true,
              isMcp: false,
              resultKind: "text",
            },
          } as never;
        }

        expect(parsed).toEqual({ name: "model", argsRaw: "", isMcp: false });
        context.appState?.setToolJSX?.({
          jsx: React.createElement(CanonicalModelMenuFixture),
          shouldHidePromptInput: true,
        });
        return {
          result: { kind: "skip" },
          immediate: true,
          trace: {
            name: "model",
            aliasUsed: "model",
            argsRaw: "",
            sensitive: false,
            immediate: true,
            isMcp: false,
            resultKind: "skip",
          },
        } as never;
      });
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };

    try {
      await withRenderedApp(
        <AgenCTuiApp session={createSession()} isInteractive={false} />,
        async ({ output }) => {
          vi.useFakeTimers();
          try {
            const onSubmit = providerProbe.promptSubmits.at(-1);
            expect(onSubmit).toBeDefined();
            await onSubmit!("/notice", helpers);
            await vi.advanceTimersByTimeAsync(0);
            expect(stripAnsi(output()).replaceAll(/\s/g, "")).toContain(
              "temporarycommandresult",
            );

            const openModelMenu = providerProbe.promptProps.at(-1)
              ?.onOpenModelMenu as
              | (() => Promise<void>)
              | undefined;
            expect(openModelMenu).toBeDefined();
            await openModelMenu!();
            await vi.advanceTimersByTimeAsync(0);
            expect(
              containsElementNamed(
                providerProbe.fullscreenLayoutProps.at(-1)?.scrollable,
                "CanonicalModelMenuFixture",
              ),
            ).toBe(true);

            await vi.advanceTimersByTimeAsync(3000);
            expect(
              containsElementNamed(
                providerProbe.fullscreenLayoutProps.at(-1)?.scrollable,
                "CanonicalModelMenuFixture",
              ),
            ).toBe(true);
            expect(dispatchSpy).toHaveBeenCalledTimes(2);
          } finally {
            vi.useRealTimers();
          }
        },
      );
    } finally {
      dispatchSpy.mockRestore();
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
          expect(
            providerProbe.fullscreenLayoutProps.at(-1)?.modal,
          ).toBeDefined();
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
    const { getCommandQueueSnapshot, resetCommandQueueForTesting } =
      await import("../../utils/messageQueueManager.js");
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
    const submittedPastedContents = {
      0: {
        id: 0,
        type: "image",
        content: "base64-image",
        mediaType: "image/png",
        filename: "pasted.png",
      },
    };
    resetShellSurfaceProbe();
    resetCommandQueueForTesting();

    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          isInteractive={false}
        />,
        async () => {
          const promptProps = providerProbe.promptProps.at(-1)!;
          (
            promptProps.setPastedContents as (
              next: Record<number, unknown>,
            ) => void
          )(submittedPastedContents);
          await new Promise((resolve) => setTimeout(resolve, 25));

          const onSubmit = providerProbe.promptSubmits.at(-1);
          expect(onSubmit).toBeDefined();
          await onSubmit!("", queuedHelpers);
          submittedPastedContents[0].content = "mutated-after-enqueue";

          expect(submit).not.toHaveBeenCalled();
          expect(getCommandQueueSnapshot()).toMatchObject([
            {
              value: "",
              mode: "prompt",
              pastedContents: {
                0: expect.objectContaining({
                  type: "image",
                  content: "base64-image",
                }),
              },
            },
          ]);
          expect(queuedHelpers.clearBuffer).toHaveBeenCalledTimes(1);
          expect(queuedHelpers.resetHistory).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      resetCommandQueueForTesting();
    }
  });

  test("keeps suspected-paste confirmation in front of the daemon shell bridge", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const executeShellCommand = vi.fn();
    const emit = vi.fn();
    let nextId = 0;
    const session = {
      ...createSession({ executeShellCommand, emit }),
      nextInternalSubId: () => `paste-shell-${++nextId}`,
    };
    resetShellSurfaceProbe();
    providerProbe.confirmSuspectedShellPaste.mockResolvedValueOnce(false);

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        const onBashSubmit = providerProbe.promptProps.at(-1)
          ?.onBashSubmit as
          | ((command: string, admittedCwd?: string) => Promise<void>)
          | undefined;
        await onBashSubmit!("rm -rf /tmp/not-run");

        expect(providerProbe.confirmSuspectedShellPaste).toHaveBeenCalledWith(
          "rm -rf /tmp/not-run",
          expect.any(Function),
        );
        expect(executeShellCommand).not.toHaveBeenCalled();
        expect(
          emit.mock.calls.map(([event]) => event.msg.payload.message),
        ).toEqual([
          "<bash-input>rm -rf /tmp/not-run</bash-input>",
          "<bash-stderr>Bash submission aborted: input looked like a paste and was not confirmed.</bash-stderr>",
        ]);
      },
    );
  });

  test("aborts an active bridged shell command on Escape without cancelling a model turn", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    let observedSignal: AbortSignal | undefined;
    const executeShellCommand = vi.fn(
      async ({ commandId, signal }: {
        readonly commandId: string;
        readonly signal?: AbortSignal;
      }) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          commandId,
          content: "",
          stdout: "",
          stderr: "interrupted",
          exitCode: null,
          timedOut: false,
          truncated: false,
          isError: true,
        };
      },
    );
    const cancelActiveTurn = vi.fn(async () => undefined);
    const session = {
      ...createSession({ executeShellCommand }),
      cancelActiveTurn,
    };
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        const onBashSubmit = providerProbe.promptProps.at(-1)
          ?.onBashSubmit as
          | ((command: string, admittedCwd?: string) => Promise<void>)
          | undefined;
        expect(onBashSubmit).toBeDefined();
        const shell = onBashSubmit!("sleep 30");

        await vi.waitFor(() => {
          expect(
            providerProbe.cancelRequestProps.at(-1)?.canCancelActiveTurn,
          ).toBe(true);
        });
        const onCancel = providerProbe.cancelRequestProps.at(-1)?.onCancel as
          | (() => void)
          | undefined;
        expect(onCancel).toBeDefined();
        onCancel!();
        await shell;

        expect(observedSignal?.aborted).toBe(true);
        expect(cancelActiveTurn).not.toHaveBeenCalled();
      },
    );
  });

  test("does not cancel a model turn for direct-shell daemon tool activity", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { createDaemonTuiSessionFixture } =
      await import("../../helpers/daemon-tui-session.js");
    const sessionEventListeners = new Set<
      (event: Record<string, unknown>) => void
    >();
    const requests: Array<{
      readonly method: string;
      readonly params?: Record<string, unknown>;
      readonly signal?: AbortSignal;
    }> = [];
    let observedShellSignal: AbortSignal | undefined;
    const request = vi.fn(
      async (
        method: string,
        params?: Record<string, unknown>,
        options?: { readonly signal?: AbortSignal },
      ): Promise<Record<string, unknown>> => {
        requests.push({
          method,
          ...(params !== undefined ? { params } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        });
        if (method !== "session.shell.execute") return {};
        observedShellSignal = options?.signal;
        return await new Promise<Record<string, unknown>>((resolve) => {
          const finish = (): void => {
            resolve({
              commandId: String(params?.commandId),
              content: "",
              stdout: "",
              stderr: "interrupted",
              exitCode: null,
              timedOut: false,
              truncated: false,
              isError: true,
            });
          };
          if (options?.signal?.aborted === true) {
            finish();
            return;
          }
          options?.signal?.addEventListener("abort", finish, { once: true });
        });
      },
    );
    const client = {
      request,
      subscribeToSessionEvents: (
        _sessionId: string,
        listener: (event: Record<string, unknown>) => void,
      ) => {
        sessionEventListeners.add(listener);
        return () => sessionEventListeners.delete(listener);
      },
      subscribeToNotifications: () => () => {},
      getConnectionState: () => null,
      subscribeToConnectionState: () => () => {},
    };
    const session = createDaemonTuiSessionFixture({
      baseSession: createSession(),
      client: client as never,
      sessionId: "direct-shell-app-session",
      clientId: "direct-shell-app-client",
    });
    resetShellSurfaceProbe();

    await withRenderedApp(
      <AgenCTuiApp session={session} isInteractive={false} />,
      async () => {
        const onBashSubmit = providerProbe.promptProps.at(-1)
          ?.onBashSubmit as
          | ((command: string, admittedCwd?: string) => Promise<void>)
          | undefined;
        expect(onBashSubmit).toBeDefined();
        const shell = onBashSubmit!("sleep 30");

        await vi.waitFor(() => {
          expect(
            requests.some(({ method }) => method === "session.shell.execute"),
          ).toBe(true);
        });
        const shellRequest = requests.find(
          ({ method }) => method === "session.shell.execute",
        );
        const commandId = String(shellRequest?.params?.commandId);
        for (const listener of sessionEventListeners) {
          listener({
            method: "event.session_event",
            params: {
              sessionId: "direct-shell-app-session",
              eventId: "direct-shell-tool-started",
              event: {
                id: "direct-shell-tool-started",
                type: "tool_call_started",
                payload: {
                  callId: commandId,
                  toolName: "system.bash",
                  args: '{"command":"sleep 30"}',
                },
              },
            },
          });
        }

        await vi.waitFor(() => {
          expect(session.activeTurn?.unsafePeek()).toBeNull();
          expect(
            providerProbe.cancelRequestProps.at(-1)?.canCancelActiveTurn,
          ).toBe(true);
        });
        const onCancel = providerProbe.cancelRequestProps.at(-1)?.onCancel as
          | (() => void)
          | undefined;
        expect(onCancel).toBeDefined();
        onCancel!();
        await shell;

        expect(observedShellSignal?.aborted).toBe(true);
        expect(
          requests.some(({ method }) => method === "session.cancelTurn"),
        ).toBe(false);
      },
    );
  });

  test("drains queued bash commands without forwarding them to the model", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const {
      enqueue,
      getCommandQueueSnapshot,
      getSoleActiveCommandQueueOwnerForTesting,
      resetCommandQueueForTesting,
    } = await import("../../utils/messageQueueManager.js");
    const { getCwd } = await import("../../utils/cwd.js");
    const submit = vi.fn(async () => {});
    const emit = vi.fn();
    let id = 0;
    const admittedWorkspaceRoot = "/tmp/agenc-queued-bash-owner";
    let observedExecutionCwd: string | undefined;
    const session = {
      ...createSession({
        executionCwd: admittedWorkspaceRoot,
        localExecutionCapable: true,
      }),
      submit,
      emit,
      nextInternalSubId: () => `bash-id-${++id}`,
    };
    resetShellSurfaceProbe();
    resetCommandQueueForTesting();
    providerProbe.processBashCommand.mockImplementationOnce(async () => {
      observedExecutionCwd = getCwd();
      return {
        messages: [
          {
            type: "user",
            message: {
              content:
                "<bash-stdout>queued ok</bash-stdout><bash-stderr></bash-stderr>",
            },
          },
        ],
        shouldQuery: false,
      };
    });
    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          isInteractive={false}
        />,
        async () => {
          const queueOwner = getSoleActiveCommandQueueOwnerForTesting();
          enqueue({
            value: "echo queued",
            preExpansionValue: "!echo queued",
            mode: "bash",
            queueOwner,
            executionCwd:
              queueOwner?.kind === "tui_mount"
                ? queueOwner.workspaceRoot
                : undefined,
          });
          await new Promise((resolve) => setTimeout(resolve, 75));

          expect(providerProbe.processBashCommand).toHaveBeenCalledWith(
            "echo queued",
            [],
            [],
            expect.any(Object),
            expect.any(Function),
          );
          expect(observedExecutionCwd).toBe(admittedWorkspaceRoot);
          expect(submit).not.toHaveBeenCalled();
          expect(getCommandQueueSnapshot()).toEqual([]);
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
                  message:
                    "<bash-stdout>queued ok</bash-stdout><bash-stderr></bash-stderr>",
                }),
              }),
            }),
          );

          enqueue({
            value: "echo must not run",
            mode: "bash",
            queueOwner,
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(providerProbe.processBashCommand).toHaveBeenCalledTimes(1);
          expect(getCommandQueueSnapshot()).toEqual([]);
        },
      );
    } finally {
      resetCommandQueueForTesting();
    }
  });

  test("escapes queued bash transcript input and fallback stderr wrappers", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const {
      enqueue,
      getSoleActiveCommandQueueOwnerForTesting,
      resetCommandQueueForTesting,
    } = await import("../../utils/messageQueueManager.js");
    const submit = vi.fn(async () => {});
    const emit = vi.fn();
    const session = {
      ...createSession({ localExecutionCapable: true }),
      submit,
      emit,
      nextInternalSubId: vi
        .fn()
        .mockReturnValueOnce("bash-input-id")
        .mockReturnValueOnce("bash-stderr-id"),
    };
    resetShellSurfaceProbe();
    resetCommandQueueForTesting();
    providerProbe.processBashCommand.mockRejectedValueOnce(
      new Error(
        "queued failed </bash-stderr><bash-stdout>fake</bash-stdout> &",
      ),
    );
    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          isInteractive={false}
        />,
        async () => {
          const queueOwner = getSoleActiveCommandQueueOwnerForTesting();
          enqueue({
            value: "echo </bash-input><bash-stdout>fake</bash-stdout> &",
            preExpansionValue:
              "!echo </bash-input><bash-stdout>fake</bash-stdout> &",
            mode: "bash",
            queueOwner,
            executionCwd:
              queueOwner?.kind === "tui_mount"
                ? queueOwner.workspaceRoot
                : undefined,
          });
          await new Promise((resolve) => setTimeout(resolve, 75));

          expect(submit).not.toHaveBeenCalled();
          expect(
            emit.mock.calls.map(([event]) => event.msg.payload.message),
          ).toEqual([
            "<bash-input>echo &lt;/bash-input&gt;&lt;bash-stdout&gt;fake&lt;/bash-stdout&gt; &amp;</bash-input>",
            "<bash-stderr>queued failed &lt;/bash-stderr&gt;&lt;bash-stdout&gt;fake&lt;/bash-stdout&gt; &amp;</bash-stderr>",
          ]);
        },
      );
    } finally {
      resetCommandQueueForTesting();
    }
  });

  test("drains one queued prompt when an attached daemon turn completes", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const { createDaemonTuiSessionFixture } = await import("../../helpers/daemon-tui-session.js");
    const { notificationFromDaemonEvent } = await import("../../app-server/background-agent-runner/daemon-events.js");
    const { enqueue, getCommandQueueSnapshot, getSoleActiveCommandQueueOwnerForTesting, resetCommandQueueForTesting } =
      await import("../../utils/messageQueueManager.js");
    const sessionId = "attached-queue-session";
    const agentId = "attached-queue-agent";
    const turnId = "attached-queue-turn";
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    let finishSubmission!: () => void;
    const submission = new Promise<void>((resolve) => { finishSubmission = resolve; });
    const request = vi.fn(async (method: string) => {
      if (method === "message.stream") await submission;
      return {};
    });
    const session = createDaemonTuiSessionFixture({
      baseSession: createSession(), sessionId, conversationId: agentId, clientId: "attached-queue-client",
      client: {
        request,
        subscribeToSessionEvents: (_id: string, listener: (event: Record<string, unknown>) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as never,
      transcriptSnapshot: {
        schemaVersion: 2, sessionId, runId: agentId, historyEpoch: "initial",
        asOfSequence: 10, messages: [], activeTurn: { turnId },
      },
    });
    resetShellSurfaceProbe();
    resetCommandQueueForTesting();
    try {
      await withRenderedApp(<AgenCTuiApp session={session} isInteractive={false} />, async () => {
        enqueue({
          value: "continue the workflow", mode: "prompt",
          queueOwner: getSoleActiveCommandQueueOwnerForTesting(),
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(getCommandQueueSnapshot()).toHaveLength(1);
        expect(request.mock.calls.filter(([method]) => method === "message.stream")).toHaveLength(0);
        const terminal = notificationFromDaemonEvent(sessionId, agentId, {
          id: "event:11", eventId: "event:11", sequence: 11,
          type: "turn_complete", payload: { turnId, lastAgentMessage: "Done" },
        });
        for (const listener of listeners) listener(terminal);
        await vi.waitFor(() => {
          expect(request.mock.calls.filter(([method]) => method === "message.stream")).toHaveLength(1);
          expect(getCommandQueueSnapshot()).toHaveLength(0);
        });
        for (const listener of listeners) listener(terminal);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(request.mock.calls.filter(([method]) => method === "message.stream")).toHaveLength(1);
        finishSubmission();
      });
    } finally {
      finishSubmission();
      resetCommandQueueForTesting();
    }
  });

  test("queues slash command prompt results for next-turn drain", async () => {
    const { enqueueSlashPromptResult } = await import("./App.js");
    const { getCommandQueueSnapshot, resetCommandQueueForTesting } =
      await import("../../utils/messageQueueManager.js");
    const scheduleQueueDrain = vi.fn();
    resetCommandQueueForTesting();

    try {
      expect(
        enqueueSlashPromptResult(
          "review queued prompt result",
          scheduleQueueDrain,
        ),
      ).toBe(true);

      expect(getCommandQueueSnapshot()).toMatchObject([
        {
          value: "review queued prompt result",
          preExpansionValue: "review queued prompt result",
          mode: "prompt",
        },
      ]);
      expect(scheduleQueueDrain).toHaveBeenCalledTimes(1);
    } finally {
      resetCommandQueueForTesting();
    }
  });

  test("skips first-run onboarding after completion is persisted", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const session = createSession({
      configStore: createAppConfigStore(defaultConfig(), agencHome),
    });
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
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const session = createSession({
      configStore: createAppConfigStore(defaultConfig(), agencHome),
    });
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    const fetchSpy = mockOfflineOnboardingFetch();
    resetShellSurfaceProbe();
    providerProbe.promptSubmits.length = 0;
    try {
      await withRenderedApp(
        <AgenCTuiApp
          session={session}
          isInteractive={true}
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
      fetchSpy.mockRestore();
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
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const session = {
      ...createSession({
        configStore: createAppConfigStore(defaultConfig(), agencHome),
      }),
      submit: vi.fn(async () => {}),
    };
    const fetchSpy = mockOfflineOnboardingFetch();
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
      fetchSpy.mockRestore();
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  test("routes composer submissions through onboarding and stages provider switch on completion", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const session = {
      ...createSession({
        configStore: createAppConfigStore(defaultConfig(), agencHome),
        authBackend: { saveByokKey: vi.fn(async () => {}) } as never,
      }),
      submit: vi.fn(async () => {}),
      setPendingProviderSwitch: vi.fn(),
    };
    // Isolate AGENC_HOME: a real ~/.agenc/auth.json (hosted managed session)
    // would reorder the onboarding provider menu and swap the API-key step
    // for the hosted-access path, breaking the scripted anonymous flow.
    const previousAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
    // A starter turn requires verified model access; configuring later must
    // finish onboarding without silently admitting an unauthenticated turn.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
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
        />,
        async ({ output }) => {
          const currentFrameText = (): string =>
            stripAnsi(extractLastSynchronizedFrame(output())).replace(
              /\s+/gu,
              "",
            );
          const submit = async (
            value: string,
            nextFrameMarker: string,
          ): Promise<void> => {
            const onSubmit = providerProbe.promptSubmits.at(-1);
            expect(onSubmit).toBeDefined();
            await onSubmit!(value, helpers);
            await vi.waitFor(
              () => expect(currentFrameText()).toContain(nextFrameMarker),
              { interval: 10, timeout: 5_000 },
            );
          };

          expect(output()).toContain("Preflight");
          // This marker already exists before the invalid submission, so the
          // next input can arrive before its error frame commits. That keeps
          // this regression sensitive to stale passive-effect state writes.
          await submit(
            "summarize this repository",
            "PressEntertocontinue,ortypenext.",
          );
          expect(output()).toContain("Preflight");
          expect(session.setPendingProviderSwitch).not.toHaveBeenCalled();
          await submit("", "Use↑/↓andpressEnter,ortypeanumberorthemename.");
          await submit(
            "1",
            "Use↑/↓andpressEnter,ortypeanumberorproviderslug.",
          );
          await submit("2", "OPENAI_API_KEY");
          await submit("sk-onboarding-app-fixture", "ApproveBYOKAPIkey");
          await submit("yes", "PressEntertokeepthesedefaults.");
          await submit("", "PressEntertofinishonboarding");
          await submit("", "spinner:requesting:");

          expect(session.setPendingProviderSwitch).toHaveBeenCalledTimes(1);
          expect(session.setPendingProviderSwitch).toHaveBeenCalledWith({
            provider: "openai",
            model: "gpt-5",
          });
          expect(readOnboardingState({ agencHome }).completed).toBe(true);
          expect(session.submit).toHaveBeenCalledTimes(1);
          expect(session.submit).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ source: "user" }),
          );
          expect(output()).toContain("spinner:requesting:");
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

  test.each([
    {
      policyName: "deny-all",
      availableModels: [] as string[],
    },
    {
      policyName: "restricted",
      availableModels: ["grok-4.6"],
    },
  ])(
    "keeps the onboarding fallback from staging a model rejected by the $policyName managed policy",
    async ({ availableModels }) => {
      const { AgenCTuiApp } = await import("./App.js");
      const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-policy-"));
      const configStore = createAppConfigStore(
        { ...defaultConfig(), availableModels },
        agencHome,
      );
      const session = {
        ...createSession({ configStore }),
        submit: vi.fn(async () => {}),
        setPendingProviderSwitch: vi.fn(),
      };
      const previousAgencHome = process.env.AGENC_HOME;
      process.env.AGENC_HOME = agencHome;
      const fetchSpy = mockOfflineOnboardingFetch();
      providerProbe.promptSubmits.length = 0;

      try {
        const helpers = {
          clearBuffer: vi.fn(),
          resetHistory: vi.fn(),
          setCursorOffset: vi.fn(),
        };
        await withRenderedApp(
          <AgenCTuiApp session={session} isInteractive={true} />,
          async ({ output }) => {
            const currentFrameText = (): string =>
              stripAnsi(extractLastSynchronizedFrame(output())).replace(
                /\s+/gu,
                "",
              );
            const submit = async (
              value: string,
              nextFrameMarker: string,
            ): Promise<void> => {
              const onSubmit = providerProbe.promptSubmits.at(-1);
              expect(onSubmit).toBeDefined();
              await onSubmit!(value, helpers);
              await vi.waitFor(
                () => expect(currentFrameText()).toContain(nextFrameMarker),
                { interval: 10, timeout: 5_000 },
              );
            };

            await submit(
              "next",
              "Use↑/↓andpressEnter,ortypeanumberorthemename.",
            );
            await submit(
              "1",
              "Use↑/↓andpressEnter,ortypeanumberorproviderslug.",
            );
            await submit("2", "OPENAI_API_KEY");
            await submit("skip", "PressEntertoruntheconnectioncheck");
            await submit("test", "Sandboxworkspace-write");
            await submit("", "PressEntertofinishonboarding");

            const completeOnboarding = providerProbe.promptSubmits.at(-1);
            expect(completeOnboarding).toBeDefined();
            await expect(completeOnboarding!("", helpers)).rejects.toThrow(
              "model 'gpt-5' is not allowed by managed availableModels policy",
            );

            expect(session.setPendingProviderSwitch).not.toHaveBeenCalled();
            expect(session.submit).not.toHaveBeenCalled();
            expect(providerProbe.currentAppState?.mainLoopModel).toBe(
              "test-model",
            );
            expect(readOnboardingState({ agencHome }).completed).toBe(false);
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
        rmSync(agencHome, { recursive: true, force: true });
      }
    },
  );

  test("routes BYOK key approval through the real first-run TUI submission path", async () => {
    const { AgenCTuiApp } = await import("./App.js");
    const savedKeys = new Map<string, string>();
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-app-"));
    const session = {
      ...createSession({
        authBackend: {
          saveByokKey: async ({ provider, apiKey }: { provider: string; apiKey: string }) => {
            savedKeys.set(provider, apiKey);
          },
        } as never,
        configStore: createAppConfigStore(defaultConfig(), agencHome),
      }),
      setPendingProviderSwitch: vi.fn(),
    };
    // Isolate AGENC_HOME: a real ~/.agenc/auth.json (hosted managed session)
    // would replace the BYOK API-key step with the hosted-access path.
    const previousAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
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

          // Ink represents unchanged spaces with cursor-forward controls. Read
          // one synchronized frame, then normalize those renderer artifacts so
          // tokens from unrelated historical frames cannot satisfy the check.
          const approvalFrame = stripAnsi(
            extractLastSynchronizedFrame(output()),
          ).replace(/\s+/gu, "");
          expect(approvalFrame).toContain("ApproveBYOKAPIkey");
          expect(approvalFrame).toContain("...-key");
          expect(approvalFrame).not.toContain("xai-app-key");
          // The full terminal history must also remain secret-free: checking
          // only the latest frame would miss a transient disclosure.
          expect(output()).not.toContain("xai-app-key");

          await submit("yes");
          expect(savedKeys.get("grok")).toBe("xai-app-key");
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
    const savedKeys = new Map<string, string>();
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-onboarding-persist-"));
    const session = {
      ...createSession({
        authBackend: {
          saveByokKey: async ({ provider, apiKey }: { provider: string; apiKey: string }) => {
            savedKeys.set(provider, apiKey);
          },
        } as never,
        configStore: createAppConfigStore(defaultConfig(), agencHome),
      }),
      setPendingProviderSwitch: vi.fn(),
    };
    const previousAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
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

          expect(session.setPendingProviderSwitch).toHaveBeenCalledTimes(1);
          expect(session.setPendingProviderSwitch).toHaveBeenCalledWith({
            provider: "deepseek",
            model: "deepseek-flash",
          });
          expect(savedKeys.get("deepseek")).toBe(
            "sk-deepseek-onboarding-test",
          );
          const configToml = readFileSync(
            join(agencHome, "config.toml"),
            "utf8",
          );
          expect(configToml).toContain('"model_provider" = "deepseek"');
          expect(configToml).toContain('"model" = "deepseek-flash"');
          expect(configToml).toContain('"default_model" = "deepseek-flash"');
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
      rmSync(agencHome, { recursive: true, force: true });
    }
  });
});

function createRendererSession(): Parameters<
  typeof installElicitationResolvers
>[0] {
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
    const controller = installElicitationResolvers(session, (pending) =>
      prompted.push(pending),
    );

    const first = session.services.requestUserInputResolver!.request(
      userRequest("first"),
    );
    const second = session.services.requestUserInputResolver!.request(
      userRequest("second"),
    );

    expect(prompted.at(-1)?.kind).toBe("user");
    expect(
      (prompted.at(-1) as PendingElicitation & { kind: "user" }).request.callId,
    ).toBe("first");

    expect(controller.submit("2")).toBe(true);
    await expect(first).resolves.toEqual({
      answers: { choice: { answers: ["No"] } },
    });
    expect(prompted.at(-1)?.kind).toBe("user");
    expect(
      (prompted.at(-1) as PendingElicitation & { kind: "user" }).request.callId,
    ).toBe("second");

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
    const controller = installElicitationResolvers(session, (pending) =>
      prompted.push(pending),
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
    const controller = installElicitationResolvers(session, (pending) =>
      prompted.push(pending),
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
      formPending(
        {
          type: "string",
          oneOf: [
            { const: "red", title: "Red" },
            { const: "blue", title: "Blue" },
          ],
        },
        resolve,
      ),
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

    const next = settlePendingOnSubmit(
      formPending(schema, resolve),
      "read, write",
    );

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { value: ["read", "write"] },
    });
    expectInvalidFormValue(schema, "read, delete", "delete");
  });

  test("omits blank optional string MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(
      formPending({ type: "string" }, resolve),
      "",
    );

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("omits blank optional number MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(
      formPending({ type: "number" }, resolve),
      "",
    );

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("omits blank optional boolean MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(
      formPending({ type: "boolean" }, resolve),
      "",
    );

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("accepts valid MCP form input with collected content", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(
      formPending({ type: "string" }, resolve),
      "done",
    );

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
    const next = settlePendingOnSubmit(
      formPending({ type: "string" }, resolve),
      "cancel",
    );

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "cancel" });
  });
});
