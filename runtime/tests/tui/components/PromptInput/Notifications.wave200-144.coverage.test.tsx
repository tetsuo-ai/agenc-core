import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  appState: {
    isBriefOnly: false,
    notifications: {
      current: null as null | {
        color?: string;
        jsx?: unknown;
        key: string;
        text?: string;
      },
      queue: [] as unknown[],
    },
  },
  autoUpdaterProps: [] as Array<Record<string, unknown>>,
  compactWarning: false,
  editor: undefined as string | undefined,
  envHookNotifier: null as null | ((text: string, isError?: boolean) => void),
  helperConfigured: false,
  helperElapsedMs: 0,
  ideStatus: "disconnected" as "connected" | "disconnected",
  mcpClientsSeen: undefined as unknown,
  model: "gpt-5.4",
  removeNotification: vi.fn(),
  subscriptionType: "pro" as "enterprise" | "pro" | "team",
  tokenUsage: 1776,
  usingOverage: undefined as boolean | undefined,
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../../services/compact/autoCompact.js", () => ({
  calculateTokenWarningState: (tokenUsage: number, model: string) => ({
    isAboveWarningThreshold: harness.compactWarning,
    model,
    tokenUsage,
  }),
}));

vi.mock("../../../utils/auth.js", () => ({
  getApiKeyHelperElapsedMs: () => harness.helperElapsedMs,
  getConfiguredApiKeyHelper: () =>
    harness.helperConfigured ? "echo helper" : null,
  getSubscriptionType: () => harness.subscriptionType,
}));

vi.mock("../../../utils/editor.js", () => ({
  getExternalEditor: () => harness.editor,
}));

vi.mock("../../../utils/envUtils.js", () => ({
  isEnvTruthy: (value: string | undefined) =>
    value === "1" || value === "true" || value === "yes",
}));

vi.mock("../../../utils/format.js", () => ({
  formatDuration: (ms: number) => `${ms}ms`,
}));

vi.mock("../../../utils/hooks/fileChangedWatcher.js", () => ({
  setEnvHookNotifier: (
    notifier: null | ((text: string, isError?: boolean) => void),
  ) => {
    harness.envHookNotifier = notifier;
  },
}));

vi.mock("../../../utils/ide.js", () => ({
  toIDEDisplayName: (editor: string) => `IDE:${editor}`,
}));

vi.mock("../../../utils/messages.js", () => ({
  getMessagesAfterCompactBoundary: (messages: unknown[]) => messages,
}));

vi.mock("../../../utils/tokens.js", () => ({
  tokenCountFromLastAPIResponse: () => harness.tokenUsage,
}));

vi.mock("../../context/notifications.js", () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
    removeNotification: harness.removeNotification,
  }),
}));

vi.mock("../../hooks/useIdeConnectionStatus.js", () => ({
  useIdeConnectionStatus: (mcpClients: unknown) => {
    harness.mcpClientsSeen = mcpClients;
    return { status: harness.ideStatus };
  },
}));

vi.mock("../../hooks/useMainLoopModel.js", () => ({
  useMainLoopModel: () => harness.model,
}));

vi.mock("../../rate-limits/agenc-ai-limits.js", () => ({
  useAgenCAiLimits: () => ({ isUsingOverage: harness.usingOverage }),
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
}));

vi.mock("../AutoUpdaterWrapper.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");

  return {
    AutoUpdaterWrapper: (props: Record<string, unknown>) => {
      harness.autoUpdaterProps.push(props);
      return ReactModule.createElement(Text, null, "AutoUpdater");
    },
  };
});

vi.mock("../ConfigurableShortcutHint.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");

  return {
    ConfigurableShortcutHint: ({
      description,
      fallback,
    }: {
      description: string;
      fallback: string;
    }) => ReactModule.createElement(Text, null, `${fallback}:${description}`),
  };
});

vi.mock("../IdeStatusIndicator.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");

  return {
    IdeStatusIndicator: ({
      ideSelection,
      mcpClients,
    }: {
      ideSelection?: { filePath?: string; text?: string };
      mcpClients?: unknown[];
    }) =>
      ReactModule.createElement(
        Text,
        null,
        `IDE:${ideSelection?.filePath ?? ideSelection?.text ?? "none"}:${mcpClients?.length ?? 0}`,
      ),
  };
});

vi.mock("../../cost/MemoryUsageIndicator.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");

  return {
    MemoryUsageIndicator: () =>
      ReactModule.createElement(Text, null, "MemoryUsage"),
  };
});

vi.mock("../TuiErrorBoundary.js", () => ({
  TuiErrorBoundary: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock("../../cost/TokenWarning.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");

  return {
    TokenWarning: ({
      model,
      tokenUsage,
    }: {
      model: string;
      tokenUsage: number;
    }) =>
      ReactModule.createElement(Text, null, `TokenWarning:${tokenUsage}:${model}`),
  };
});

vi.mock("./SandboxPromptFooterHint.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");

  return {
    SandboxPromptFooterHint: () =>
      ReactModule.createElement(Text, null, "SandboxHint"),
  };
});

import { createRoot } from "../../ink/root.js";
import { Notifications } from "./Notifications.js";

type NotificationsProps = React.ComponentProps<typeof Notifications>;

type RenderedNotifications = {
  dispose: () => Promise<void>;
  output: () => string;
  rerender: () => Promise<void>;
};

function resetHarness() {
  harness.addNotification.mockClear();
  harness.appState.isBriefOnly = false;
  harness.appState.notifications = { current: null, queue: [] };
  harness.autoUpdaterProps = [];
  harness.compactWarning = false;
  harness.editor = undefined;
  harness.envHookNotifier = null;
  harness.helperConfigured = false;
  harness.helperElapsedMs = 0;
  harness.ideStatus = "disconnected";
  harness.mcpClientsSeen = undefined;
  harness.model = "gpt-5.4";
  harness.removeNotification.mockClear();
  harness.subscriptionType = "pro";
  harness.tokenUsage = 1776;
  harness.usingOverage = undefined;
}

function baseProps(): NotificationsProps {
  return {
    apiKeyStatus: "valid",
    autoUpdaterResult: null,
    debug: false,
    getMessages: () => [],
    ideSelection: undefined,
    isAutoUpdating: false,
    lastAssistantMessageId: null,
    mcpClients: undefined,
    onAutoUpdaterResult: vi.fn(),
    onChangeIsUpdating: vi.fn(),
    verbose: false,
  };
}

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  stdout.resume();
  (stdout as unknown as { columns: number; rows: number }).columns = 120;
  (stdout as unknown as { columns: number; rows: number }).rows = 30;

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderNotifications(
  props: NotificationsProps,
): Promise<RenderedNotifications> {
  let output = "";
  const { stdin, stdout } = createStreams();
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  const render = () => {
    root.render(<Notifications {...props} />);
  };

  render();
  await sleep();

  return {
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
    output: () => stripAnsi(output),
    rerender: async () => {
      render();
      await sleep();
    },
  };
}

beforeEach(() => {
  resetHarness();
});

describe("Notifications wave200-144 coverage", () => {
  test("keeps a text-selection editor hint single across an unchanged narrow rerender", async () => {
    harness.editor = "vscode";
    harness.ideStatus = "connected";

    const mcpClients = [{ name: "ide" }];
    const props = {
      ...baseProps(),
      autoUpdaterResult: { status: "success" },
      ideSelection: {
        lineCount: 2,
        text: "selected text",
      },
      isInputWrapped: true,
      isNarrow: true,
      mcpClients,
    } as NotificationsProps;

    const rendered = await renderNotifications(props);

    try {
      expect(rendered.output()).toContain("IDE:selected text:1");
      expect(rendered.output()).toContain("TokenWarning:1776:gpt-5.4");
      expect(rendered.output()).not.toContain("AutoUpdater");
      expect(harness.autoUpdaterProps).toHaveLength(0);
      expect(harness.mcpClientsSeen).toBe(mcpClients);

      await rendered.rerender();
      await rendered.rerender();

      expect(harness.addNotification).toHaveBeenCalledTimes(1);
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "external-editor-hint",
          priority: "immediate",
          timeoutMs: 5000,
        }),
      );
      expect(harness.removeNotification).not.toHaveBeenCalled();
    } finally {
      await rendered.dispose();
    }
  });
});
