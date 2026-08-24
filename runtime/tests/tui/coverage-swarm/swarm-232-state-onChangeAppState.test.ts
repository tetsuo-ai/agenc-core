import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AppState } from "../../../src/tui/state/AppStateStore.js";
import {
  externalMetadataToAppState,
  onChangeAppState,
} from "../../../src/tui/state/onChangeAppState.js";

type TestGlobalConfig = {
  showExpandedTodos?: boolean;
  showSpinnerTree?: boolean;
  tungstenPanelVisible?: boolean;
  verbose?: boolean;
};

const harness = vi.hoisted(() => ({
  applyConfigEnvironmentVariables: vi.fn(),
  globalConfig: {} as TestGlobalConfig,
  isAntEmployee: vi.fn(() => true),
  logError: vi.fn(),
  notifyPermissionModeChanged: vi.fn(),
  notifySessionMetadataChanged: vi.fn(),
  updateRuntimeState: vi.fn(),
  setMainLoopModelOverride: vi.fn(),
  updateSettingsForSource: vi.fn(),
}));

vi.mock("../../../src/bootstrap/state.js", () => ({
  setMainLoopModelOverride: harness.setMainLoopModelOverride,
}));

vi.mock("../../../src/utils/buildConfig.js", () => ({
  isAntEmployee: harness.isAntEmployee,
}));

vi.mock("../../../src/utils/config.js", () => ({
  getRuntimeState: () => harness.globalConfig,
  updateRuntimeState: (updater: (current: TestGlobalConfig) => TestGlobalConfig) => {
    harness.updateRuntimeState(updater);
    harness.globalConfig = updater(harness.globalConfig);
  },
}));

vi.mock("../../../src/utils/errors.js", () => ({
  toError: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
}));

vi.mock("../../../src/utils/log.js", () => ({
  logError: harness.logError,
}));

vi.mock("../../../src/utils/managedEnv.js", () => ({
  applyConfigEnvironmentVariables: harness.applyConfigEnvironmentVariables,
}));

vi.mock("../../../src/utils/permissions/PermissionMode.js", () => ({
  permissionModeFromString: (mode: string) =>
    mode === "acceptEdits" || mode === "plan" ? mode : "default",
  toExternalPermissionMode: (mode: string) =>
    mode === "auto" || mode === "bubble" ? "default" : mode,
}));

vi.mock("../../../src/utils/sessionState.js", () => ({
  notifyPermissionModeChanged: harness.notifyPermissionModeChanged,
  notifySessionMetadataChanged: harness.notifySessionMetadataChanged,
}));

vi.mock("../../../src/utils/settings/settings.js", () => ({
  updateSettingsForSource: harness.updateSettingsForSource,
}));

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    expandedView: "none",
    mainLoopModel: null,
    settings: { env: { OLD_VALUE: "1" } },
    toolPermissionContext: { mode: "default" },
    tungstenPanelVisible: false,
    verbose: false,
    ...overrides,
  } as AppState;
}

describe("onChangeAppState coverage swarm", () => {
  beforeEach(() => {
    harness.applyConfigEnvironmentVariables.mockReset();
    harness.globalConfig = {
      showExpandedTodos: false,
      showSpinnerTree: false,
      tungstenPanelVisible: false,
      verbose: false,
    };
    harness.isAntEmployee.mockReset();
    harness.isAntEmployee.mockReturnValue(true);
    harness.logError.mockReset();
    harness.notifyPermissionModeChanged.mockReset();
    harness.notifySessionMetadataChanged.mockReset();
    harness.updateRuntimeState.mockReset();
    harness.setMainLoopModelOverride.mockReset();
    harness.updateSettingsForSource.mockReset();
  });

  test("hydrates string permission metadata and ignores absent metadata", () => {
    const previous = makeState({
      toolPermissionContext: {
        additionalDirectories: ["/tmp/workspace"],
        mode: "default",
      },
    });

    const hydrated = externalMetadataToAppState({
      permission_mode: "acceptEdits",
    })(previous);
    const unchanged = externalMetadataToAppState({})(previous);

    expect(hydrated.toolPermissionContext).toMatchObject({
      additionalDirectories: ["/tmp/workspace"],
      mode: "acceptEdits",
    });
    expect(unchanged.toolPermissionContext).toBe(previous.toolPermissionContext);
  });

  test("notifies raw permission mode changes while suppressing unchanged external metadata", () => {
    onChangeAppState({
      oldState: makeState({ toolPermissionContext: { mode: "default" } }),
      newState: makeState({ toolPermissionContext: { mode: "bubble" } }),
    });

    expect(harness.notifySessionMetadataChanged).not.toHaveBeenCalled();
    expect(harness.notifyPermissionModeChanged).toHaveBeenCalledWith("bubble");
  });

  test("writes selected models to canonical settings", () => {
    onChangeAppState({
      oldState: makeState({ mainLoopModel: null }),
      newState: makeState({ mainLoopModel: "gpt-5.4" }),
    });

    expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      { model: "gpt-5.4" },
    );
    expect(harness.setMainLoopModelOverride).toHaveBeenCalledWith("gpt-5.4");

    onChangeAppState({
      oldState: makeState({ mainLoopModel: "gpt-5.4" }),
      newState: makeState({ mainLoopModel: "gpt-5.4-mini" }),
    });
    expect(harness.updateSettingsForSource).toHaveBeenLastCalledWith(
      "userSettings",
      { model: "gpt-5.4-mini" },
    );
  });

  test("clears selected model settings", () => {
    onChangeAppState({
      oldState: makeState({ mainLoopModel: "gpt-5.4" }),
      newState: makeState({ mainLoopModel: null }),
    });

    expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      { model: undefined },
    );
    expect(harness.setMainLoopModelOverride).toHaveBeenCalledWith(null);
  });

  test("persists expanded view only when the stored config differs", () => {
    onChangeAppState({
      oldState: makeState({ expandedView: "none" }),
      newState: makeState({ expandedView: "teammates" }),
    });

    expect(harness.globalConfig).toMatchObject({
      showExpandedTodos: false,
      showSpinnerTree: true,
    });
    expect(harness.updateRuntimeState).toHaveBeenCalledTimes(1);

    harness.updateRuntimeState.mockReset();
    harness.globalConfig = {
      showExpandedTodos: false,
      showSpinnerTree: true,
    };

    onChangeAppState({
      oldState: makeState({ expandedView: "none" }),
      newState: makeState({ expandedView: "teammates" }),
    });

    expect(harness.updateRuntimeState).not.toHaveBeenCalled();
  });

  test("persists verbose and tungsten toggles only for changed mismatched config", () => {
    onChangeAppState({
      oldState: makeState({ verbose: false, tungstenPanelVisible: false }),
      newState: makeState({ verbose: true, tungstenPanelVisible: true }),
    });

    expect(harness.globalConfig).toMatchObject({
      tungstenPanelVisible: true,
      verbose: true,
    });
    expect(harness.updateRuntimeState).toHaveBeenCalledTimes(2);

    harness.updateRuntimeState.mockReset();
    harness.globalConfig = {
      tungstenPanelVisible: true,
      verbose: true,
    };

    onChangeAppState({
      oldState: makeState({ verbose: false, tungstenPanelVisible: false }),
      newState: makeState({ verbose: true, tungstenPanelVisible: true }),
    });

    expect(harness.updateRuntimeState).not.toHaveBeenCalled();

    harness.isAntEmployee.mockReturnValue(false);
    onChangeAppState({
      oldState: makeState({ tungstenPanelVisible: false }),
      newState: makeState({ tungstenPanelVisible: true }),
    });

    expect(harness.updateRuntimeState).not.toHaveBeenCalled();
  });

  test("does not reapply the shell environment when its canonical policy is unchanged", () => {
    const sharedPolicy = { set: { SHARED: "1" } };

    onChangeAppState({
      oldState: makeState({
        settings: { shell_environment_policy: sharedPolicy },
      }),
      newState: makeState({
        settings: { model: "gpt-5.4", shell_environment_policy: sharedPolicy },
      }),
    });

    expect(harness.applyConfigEnvironmentVariables).not.toHaveBeenCalled();
  });

  test("logs shell environment application errors without throwing", () => {
    const error = new Error("environment apply failed");
    harness.applyConfigEnvironmentVariables.mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      onChangeAppState({
        oldState: makeState(),
        newState: makeState({
          settings: {
            shell_environment_policy: { set: { UPDATED: "1" } },
          },
        }),
      }),
    ).not.toThrow();

    expect(harness.logError).toHaveBeenCalledWith(error);
    expect(harness.applyConfigEnvironmentVariables).toHaveBeenCalledTimes(1);
  });
});
