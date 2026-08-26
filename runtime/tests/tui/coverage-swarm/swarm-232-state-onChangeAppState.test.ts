import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AppState } from "../../../src/tui/state/AppStateStore.js";
import { onChangeAppState } from "../../../src/tui/state/onChangeAppState.js";

const harness = vi.hoisted(() => ({
  applyConfigEnvironmentVariables: vi.fn(),
  logError: vi.fn(),
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
    harness.logError.mockReset();
  });

  test("keeps projected model and effort changes out of durable settings authority", () => {
    onChangeAppState({
      oldState: makeState({ effortValue: undefined, mainLoopModel: null }),
      newState: makeState({ effortValue: "high", mainLoopModel: "gpt-5.4" }),
    });
    expect(harness.applyConfigEnvironmentVariables).not.toHaveBeenCalled();
    expect(harness.logError).not.toHaveBeenCalled();
  });

  test("keeps transient presentation state out of durable settings", () => {
    onChangeAppState({
      oldState: makeState({
        expandedView: "none",
        tungstenPanelVisible: false,
        verbose: false,
      }),
      newState: makeState({
        expandedView: "teammates",
        tungstenPanelVisible: true,
        verbose: true,
      }),
    });

    expect(harness.applyConfigEnvironmentVariables).not.toHaveBeenCalled();
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
