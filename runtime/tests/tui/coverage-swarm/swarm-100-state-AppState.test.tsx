import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../../src/utils/staticRender.js";
import { createRoot, Text } from "../../../src/tui/ink.js";
import {
  AppStateProvider,
  useAppState,
  useAppStateMaybeOutsideOfProvider,
  useAppStateStore,
  useSetAppState,
  type AppState,
  type AppStateStore,
} from "../../../src/tui/state/AppState.js";

const harness = vi.hoisted(() => ({
  bypassDisabled: false,
  settingsChange: undefined as ((source: unknown) => void) | undefined,
}));

const mockFns = vi.hoisted(() => ({
  applySettingsChange: vi.fn(),
  createDisabledBypassPermissionsContext: vi.fn(
    (context: Record<string, unknown>) => ({
      ...context,
      disabledByRemoteSettings: true,
      isBypassPermissionsModeAvailable: false,
    }),
  ),
  logForDebugging: vi.fn(),
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../../src/tui/context/mailbox.js", () => ({
  MailboxProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../../../src/tui/hooks/useEffectEventCompat.js", () => ({
  useEffectEventCompat: (callback: unknown) => callback,
}));

vi.mock("../../../src/tui/hooks/useSettingsChange.js", () => ({
  useSettingsChange: (callback: (source: unknown) => void) => {
    harness.settingsChange = callback;
  },
}));

vi.mock("../../../src/utils/debug.js", () => ({
  logForDebugging: mockFns.logForDebugging,
}));

vi.mock("../../../src/utils/permissions/permissionSetup.js", () => ({
  createDisabledBypassPermissionsContext:
    mockFns.createDisabledBypassPermissionsContext,
  isBypassPermissionsModeDisabled: () => harness.bypassDisabled,
}));

vi.mock("../../../src/utils/settings/applySettingsChange.js", () => ({
  applySettingsChange: mockFns.applySettingsChange,
}));

vi.mock("../../../src/services/PromptSuggestion/promptSuggestion.js", () => ({
  shouldEnablePromptSuggestion: () => false,
}));

vi.mock("../../../src/tools/Tool.js", () => ({
  buildTool: (tool: unknown) => tool,
  getEmptyToolPermissionContext: () => ({
    additionalDirectories: [],
    alwaysAllowRules: [],
    alwaysDenyRules: [],
    isBypassPermissionsModeAvailable: false,
    mode: "default",
  }),
}));

vi.mock("../../../src/utils/commitAttribution.js", () => ({
  createEmptyAttributionState: () => ({}),
}));

vi.mock("../../../src/utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
}));

vi.mock("../../../src/utils/teammate.js", () => ({
  isPlanModeRequired: () => false,
  isTeammate: () => false,
}));

vi.mock("../../../src/utils/thinking.js", () => ({
  shouldEnableThinkingByDefault: () => false,
}));

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: () => void;
  unref: () => void;
};

type TestStdout = PassThrough & {
  columns: number;
  isTTY: boolean;
  rows: number;
};

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    statusLineText: "ready",
    toolPermissionContext: {
      additionalDirectories: [],
      alwaysAllowRules: [],
      alwaysDenyRules: [],
      isBypassPermissionsModeAvailable: false,
      mode: "default",
    },
    ...overrides,
  } as AppState;
}

function createStreams(): {
  readonly stderr: PassThrough;
  readonly stdin: TestStdin;
  readonly stdout: TestStdout;
} {
  const stderr = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough() as TestStdout;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  stdout.columns = 100;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.resume();

  return { stderr, stdin, stdout };
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(message);
}

function MaybeOutsideProbe(): React.ReactNode {
  const value = useAppStateMaybeOutsideOfProvider(
    (state) => state.statusLineText,
  );

  return <Text>{value ?? "outside-missing"}</Text>;
}

describe("AppState coverage swarm row 100", () => {
  beforeEach(() => {
    harness.bypassDisabled = false;
    harness.settingsChange = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("returns undefined from the optional selector outside AppStateProvider", async () => {
    const output = await renderToString(<MaybeOutsideProbe />, 80);

    expect(output).toContain("outside-missing");
  });

  test("wires store access, setState, mount permission updates, and settings changes", async () => {
    harness.bypassDisabled = true;
    const initialState = makeState({
      statusLineText: "before",
      toolPermissionContext: {
        additionalDirectories: [],
        alwaysAllowRules: [],
        alwaysDenyRules: [],
        isBypassPermissionsModeAvailable: true,
        mode: "bypassPermissions",
      },
    });
    const onChangeAppState = vi.fn();
    let capturedStore: AppStateStore | undefined;
    let capturedSetAppState:
      | ((updater: (prev: AppState) => AppState) => void)
      | undefined;

    function StoreProbe(): React.ReactNode {
      capturedStore = useAppStateStore();
      capturedSetAppState = useSetAppState();
      const value = useAppStateMaybeOutsideOfProvider(
        (state) => state.statusLineText,
      );

      return <Text>{value}</Text>;
    }

    const { stderr, stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={initialState}
          onChangeAppState={onChangeAppState}
        >
          <StoreProbe />
        </AppStateProvider>,
      );

      await waitForCondition(
        () =>
          capturedStore?.getState().toolPermissionContext
            .isBypassPermissionsModeAvailable === false,
        "Timed out waiting for bypass permission mode to be disabled",
      );

      expect(mockFns.logForDebugging).toHaveBeenCalledWith(
        "Disabling bypass permissions mode on mount (remote settings loaded before mount)",
      );
      expect(
        mockFns.createDisabledBypassPermissionsContext,
      ).toHaveBeenCalledWith(initialState.toolPermissionContext);
      expect(onChangeAppState).toHaveBeenCalledTimes(1);

      capturedSetAppState?.((prev) => ({
        ...prev,
        statusLineText: "after-set",
      }));

      expect(capturedStore?.getState().statusLineText).toBe("after-set");
      expect(onChangeAppState).toHaveBeenCalledTimes(2);

      harness.settingsChange?.("workspace");

      expect(mockFns.applySettingsChange).toHaveBeenCalledWith(
        "workspace",
        capturedStore?.setState,
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });

  test("throws the strict hook error outside AppStateProvider", async () => {
    function OutsideProviderProbe(): React.ReactNode {
      useAppState((state) => state.statusLineText);
      return <Text>outside</Text>;
    }

    const { stderr, stdin, stdout } = createStreams();
    let stderrOutput = "";
    stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
    const root = await createRoot({
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<OutsideProviderProbe />);

      await waitForCondition(
        () =>
          stderrOutput.includes(
            "useAppState/useSetAppState cannot be called outside of an <AppStateProvider />",
          ),
        "Timed out waiting for the strict AppState hook error",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });

  test("rejects nested AppStateProvider trees", async () => {
    const initialState = makeState();
    const { stderr, stdin, stdout } = createStreams();
    let stderrOutput = "";
    stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
    const root = await createRoot({
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider initialState={initialState}>
          <AppStateProvider initialState={initialState}>
            <Text>nested</Text>
          </AppStateProvider>
        </AppStateProvider>,
      );

      await waitForCondition(
        () =>
          stderrOutput.includes(
            "AppStateProvider can not be nested within another AppStateProvider",
          ),
        "Timed out waiting for nested AppStateProvider error",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });
});
