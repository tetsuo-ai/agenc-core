import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  externalMetadataToAppState,
  onChangeAppState,
} from "./onChangeAppState.js";
import type { AppState } from "./AppStateStore.js";

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

vi.mock("../../bootstrap/state.js", () => ({
  setMainLoopModelOverride: harness.setMainLoopModelOverride,
}));

vi.mock("../../utils/buildConfig.js", () => ({
  isAntEmployee: harness.isAntEmployee,
}));

vi.mock("../../utils/config.js", () => ({
  getRuntimeState: () => harness.globalConfig,
  updateRuntimeState: (updater: (current: TestGlobalConfig) => TestGlobalConfig) => {
    harness.updateRuntimeState(updater);
    harness.globalConfig = updater(harness.globalConfig);
  },
}));

vi.mock("../../utils/errors.js", () => ({
  toError: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
}));

vi.mock("../../utils/log.js", () => ({
  logError: harness.logError,
}));

vi.mock("../../utils/managedEnv.js", () => ({
  applyConfigEnvironmentVariables: harness.applyConfigEnvironmentVariables,
}));

vi.mock("../../utils/permissions/PermissionMode.js", () => ({
  permissionModeFromString: (mode: string) =>
    mode === "plan" || mode === "acceptEdits" ? mode : "default",
  toExternalPermissionMode: (mode: string) =>
    mode === "bubble" || mode === "auto" ? "default" : mode,
}));

vi.mock("../../utils/sessionState.js", () => ({
  notifyPermissionModeChanged: harness.notifyPermissionModeChanged,
  notifySessionMetadataChanged: harness.notifySessionMetadataChanged,
}));

vi.mock("../../utils/settings/settings.js", () => ({
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

describe("onChangeAppState coverage", () => {
  beforeEach(() => {
    harness.applyConfigEnvironmentVariables.mockReset();
    harness.globalConfig = {
      showExpandedTodos: false,
      showSpinnerTree: true,
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

  test("hydrates permission mode from external metadata", () => {
    const previous = makeState({
      toolPermissionContext: {
        additionalDirectories: ["/tmp/project"],
        mode: "default",
      },
    });

    const updated = externalMetadataToAppState({ permission_mode: "plan" })(
      previous,
    );
    const unchanged = externalMetadataToAppState({ permission_mode: null })(
      previous,
    );

    expect(updated.toolPermissionContext).toMatchObject({
      additionalDirectories: ["/tmp/project"],
      mode: "plan",
    });
    expect(unchanged.toolPermissionContext).toBe(previous.toolPermissionContext);
  });

  test("syncs changed app state to session listeners, settings, config, and shell environment", () => {
    const oldState = makeState();
    const newState = makeState({
      expandedView: "tasks",
      mainLoopModel: "gpt-5.4",
      settings: { shell_environment_policy: { set: { NEW_VALUE: "1" } } },
      toolPermissionContext: { mode: "plan" },
      tungstenPanelVisible: true,
      verbose: true,
    });

    onChangeAppState({ newState, oldState });

    expect(harness.notifySessionMetadataChanged).toHaveBeenCalledWith({
      permission_mode: "plan",
    });
    expect(harness.notifyPermissionModeChanged).toHaveBeenCalledWith("plan");
    expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      { model: "gpt-5.4" },
    );
    expect(harness.setMainLoopModelOverride).toHaveBeenCalledWith("gpt-5.4");
    expect(harness.globalConfig).toMatchObject({
      showExpandedTodos: true,
      showSpinnerTree: false,
      tungstenPanelVisible: true,
      verbose: true,
    });
    expect(harness.updateRuntimeState).toHaveBeenCalledTimes(3);
    expect(harness.applyConfigEnvironmentVariables).toHaveBeenCalledTimes(1);
  });

  test("clears the model preference without reporting unchanged external permission metadata", () => {
    const oldState = makeState({
      mainLoopModel: "gpt-5.4",
      toolPermissionContext: { mode: "default" },
    });
    const newState = makeState({
      mainLoopModel: null,
      toolPermissionContext: { mode: "bubble" },
    });

    onChangeAppState({ newState, oldState });

    expect(harness.notifySessionMetadataChanged).not.toHaveBeenCalled();
    expect(harness.notifyPermissionModeChanged).toHaveBeenCalledWith("bubble");
    expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      { model: undefined },
    );
    expect(harness.setMainLoopModelOverride).toHaveBeenCalledWith(null);
  });

  test("logs shell environment application failures without throwing", () => {
    const error = new Error("environment unavailable");
    harness.applyConfigEnvironmentVariables.mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      onChangeAppState({
        oldState: makeState(),
        newState: makeState({
          settings: {
            shell_environment_policy: { set: { NEW_VALUE: "1" } },
          },
        }),
      }),
    ).not.toThrow();

    expect(harness.logError).toHaveBeenCalledWith(error);
    expect(harness.applyConfigEnvironmentVariables).toHaveBeenCalledTimes(1);
  });
});
