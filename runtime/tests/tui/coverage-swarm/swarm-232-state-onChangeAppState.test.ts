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

vi.mock("../../../src/bootstrap/state.js", () => ({
  setMainLoopModelOverride: harness.setMainLoopModelOverride,
}));

vi.mock("../../../src/utils/auth.js", () => ({
  clearApiKeyHelperCache: harness.clearApiKeyHelperCache,
  clearAwsCredentialsCache: harness.clearAwsCredentialsCache,
  clearGcpCredentialsCache: harness.clearGcpCredentialsCache,
}));

vi.mock("../../../src/utils/buildConfig.js", () => ({
  isAntEmployee: harness.isAntEmployee,
}));

vi.mock("../../../src/utils/config.js", () => ({
  getGlobalConfig: () => harness.globalConfig,
  saveGlobalConfig: (updater: (current: TestGlobalConfig) => TestGlobalConfig) => {
    harness.saveGlobalConfig(updater);
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

vi.mock("../../../src/utils/providerProfiles.js", () => ({
  persistActiveProviderProfileModel: harness.persistActiveProviderProfileModel,
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
    delete process.env.AGENC_PROVIDER_PROFILE_ENV_APPLIED;
    harness.applyConfigEnvironmentVariables.mockReset();
    harness.clearApiKeyHelperCache.mockReset();
    harness.clearAwsCredentialsCache.mockReset();
    harness.clearGcpCredentialsCache.mockReset();
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
    harness.persistActiveProviderProfileModel.mockReset();
    harness.saveGlobalConfig.mockReset();
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

  test("writes selected models and persists provider profile only after profile env is applied", () => {
    onChangeAppState({
      oldState: makeState({ mainLoopModel: null }),
      newState: makeState({ mainLoopModel: "gpt-5.4" }),
    });

    expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      { model: "gpt-5.4" },
    );
    expect(harness.setMainLoopModelOverride).toHaveBeenCalledWith("gpt-5.4");
    expect(harness.persistActiveProviderProfileModel).not.toHaveBeenCalled();

    process.env.AGENC_PROVIDER_PROFILE_ENV_APPLIED = "1";
    onChangeAppState({
      oldState: makeState({ mainLoopModel: "gpt-5.4" }),
      newState: makeState({ mainLoopModel: "gpt-5.4-mini" }),
    });

    expect(harness.persistActiveProviderProfileModel).toHaveBeenCalledWith(
      "gpt-5.4-mini",
    );
  });

  test("clears selected model settings without provider profile writes", () => {
    onChangeAppState({
      oldState: makeState({ mainLoopModel: "gpt-5.4" }),
      newState: makeState({ mainLoopModel: null }),
    });

    expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      { model: undefined },
    );
    expect(harness.setMainLoopModelOverride).toHaveBeenCalledWith(null);
    expect(harness.persistActiveProviderProfileModel).not.toHaveBeenCalled();
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
    expect(harness.saveGlobalConfig).toHaveBeenCalledTimes(1);

    harness.saveGlobalConfig.mockReset();
    harness.globalConfig = {
      showExpandedTodos: false,
      showSpinnerTree: true,
    };

    onChangeAppState({
      oldState: makeState({ expandedView: "none" }),
      newState: makeState({ expandedView: "teammates" }),
    });

    expect(harness.saveGlobalConfig).not.toHaveBeenCalled();
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
    expect(harness.saveGlobalConfig).toHaveBeenCalledTimes(2);

    harness.saveGlobalConfig.mockReset();
    harness.globalConfig = {
      tungstenPanelVisible: true,
      verbose: true,
    };

    onChangeAppState({
      oldState: makeState({ verbose: false, tungstenPanelVisible: false }),
      newState: makeState({ verbose: true, tungstenPanelVisible: true }),
    });

    expect(harness.saveGlobalConfig).not.toHaveBeenCalled();

    harness.isAntEmployee.mockReturnValue(false);
    onChangeAppState({
      oldState: makeState({ tungstenPanelVisible: false }),
      newState: makeState({ tungstenPanelVisible: true }),
    });

    expect(harness.saveGlobalConfig).not.toHaveBeenCalled();
  });

  test("clears auth caches without reapplying env when settings env is unchanged", () => {
    const sharedEnv = { SHARED: "1" };

    onChangeAppState({
      oldState: makeState({ settings: { env: sharedEnv } }),
      newState: makeState({
        settings: { env: sharedEnv, apiKeyHelper: "/bin/helper" },
      }),
    });

    expect(harness.clearApiKeyHelperCache).toHaveBeenCalledTimes(1);
    expect(harness.clearAwsCredentialsCache).toHaveBeenCalledTimes(1);
    expect(harness.clearGcpCredentialsCache).toHaveBeenCalledTimes(1);
    expect(harness.applyConfigEnvironmentVariables).not.toHaveBeenCalled();
  });

  test("logs auth cache errors without throwing", () => {
    const error = new Error("cache clear failed");
    harness.clearApiKeyHelperCache.mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      onChangeAppState({
        oldState: makeState(),
        newState: makeState({ settings: { env: { UPDATED: "1" } } }),
      }),
    ).not.toThrow();

    expect(harness.logError).toHaveBeenCalledWith(error);
    expect(harness.clearAwsCredentialsCache).not.toHaveBeenCalled();
    expect(harness.applyConfigEnvironmentVariables).not.toHaveBeenCalled();
  });
});
