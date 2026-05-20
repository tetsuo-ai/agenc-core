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
  clearApiKeyHelperCache: vi.fn(),
  clearAwsCredentialsCache: vi.fn(),
  clearGcpCredentialsCache: vi.fn(),
  globalConfig: {} as TestGlobalConfig,
  isAntEmployee: vi.fn(() => true),
  logError: vi.fn(),
  notifyPermissionModeChanged: vi.fn(),
  notifySessionMetadataChanged: vi.fn(),
  persistActiveProviderProfileModel: vi.fn(),
  saveGlobalConfig: vi.fn(),
  setMainLoopModelOverride: vi.fn(),
  updateSettingsForSource: vi.fn(),
}));

vi.mock("../../bootstrap/state.js", () => ({
  setMainLoopModelOverride: harness.setMainLoopModelOverride,
}));

vi.mock("../../utils/auth.js", () => ({
  clearApiKeyHelperCache: harness.clearApiKeyHelperCache,
  clearAwsCredentialsCache: harness.clearAwsCredentialsCache,
  clearGcpCredentialsCache: harness.clearGcpCredentialsCache,
}));

vi.mock("../../utils/buildConfig.js", () => ({
  isAntEmployee: harness.isAntEmployee,
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: () => harness.globalConfig,
  saveGlobalConfig: (updater: (current: TestGlobalConfig) => TestGlobalConfig) => {
    harness.saveGlobalConfig(updater);
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

vi.mock("../../utils/providerProfiles.js", () => ({
  persistActiveProviderProfileModel: harness.persistActiveProviderProfileModel,
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
    delete process.env.AGENC_PROVIDER_PROFILE_ENV_APPLIED;
    harness.applyConfigEnvironmentVariables.mockReset();
    harness.clearApiKeyHelperCache.mockReset();
    harness.clearAwsCredentialsCache.mockReset();
    harness.clearGcpCredentialsCache.mockReset();
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
    harness.persistActiveProviderProfileModel.mockReset();
    harness.saveGlobalConfig.mockReset();
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

  test("syncs changed app state to session listeners, settings, config, and auth caches", () => {
    process.env.AGENC_PROVIDER_PROFILE_ENV_APPLIED = "1";
    const oldState = makeState();
    const newState = makeState({
      expandedView: "tasks",
      mainLoopModel: "gpt-5.4",
      settings: { env: { NEW_VALUE: "1" } },
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
    expect(harness.persistActiveProviderProfileModel).toHaveBeenCalledWith(
      "gpt-5.4",
    );
    expect(harness.globalConfig).toMatchObject({
      showExpandedTodos: true,
      showSpinnerTree: false,
      tungstenPanelVisible: true,
      verbose: true,
    });
    expect(harness.saveGlobalConfig).toHaveBeenCalledTimes(3);
    expect(harness.clearApiKeyHelperCache).toHaveBeenCalledTimes(1);
    expect(harness.clearAwsCredentialsCache).toHaveBeenCalledTimes(1);
    expect(harness.clearGcpCredentialsCache).toHaveBeenCalledTimes(1);
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
    expect(harness.persistActiveProviderProfileModel).not.toHaveBeenCalled();
  });

  test("logs auth cache clearing failures without throwing", () => {
    const error = new Error("cache unavailable");
    harness.clearAwsCredentialsCache.mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      onChangeAppState({
        oldState: makeState(),
        newState: makeState({ settings: { env: { NEW_VALUE: "1" } } }),
      }),
    ).not.toThrow();

    expect(harness.logError).toHaveBeenCalledWith(error);
    expect(harness.applyConfigEnvironmentVariables).not.toHaveBeenCalled();
  });
});
