import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const effects = vi.hoisted(() => ({
  clearCwdEnvFiles: vi.fn(async () => undefined),
  executeCwdChangedHooks: vi.fn(async () => ({
    results: [
      {
        command: "cwd-effect",
        succeeded: false,
        output: "cwd hook failed",
        blocked: false,
      },
    ],
    watchPaths: [],
    systemMessages: ["cwd hook message"],
  })),
}));

vi.mock("../../src/utils/sessionEnvironment.js", () => ({
  clearCwdEnvFiles: effects.clearCwdEnvFiles,
}));

vi.mock("../../src/utils/hooks.js", () => ({
  executeCwdChangedHooks: effects.executeCwdChangedHooks,
}));

import {
  registerHookCallbacks,
  resetStateForTests,
} from "../../src/bootstrap/state.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";
import {
  onCwdChangedForHooks,
  setEnvHookNotifier,
} from "../../src/utils/hooks/cwdChangedHooks.js";

describe("CwdChanged simple-mode suppression", () => {
  const notifier = vi.fn();

  beforeEach(() => {
    resetStateForTests();
    effects.clearCwdEnvFiles.mockClear();
    effects.executeCwdChangedHooks.mockClear();
    notifier.mockClear();
    setEnvHookNotifier(notifier);
    registerHookCallbacks({
      CwdChanged: [
        {
          matcher: "*",
          hooks: [{ type: "callback", callback: async () => ({}) }],
        },
      ],
    } as never);
  });

  afterEach(() => {
    setEnvHookNotifier(null);
    resetStateForTests();
  });

  test("does not clear, dispatch, or notify for a simple-mode startup owner", async () => {
    await runWithAgentRuntimeOptions(
      resolveAgentRuntimeOptions({}, { simpleMode: true }),
      () => onCwdChangedForHooks("/old", "/new"),
    );

    expect(effects.clearCwdEnvFiles).not.toHaveBeenCalled();
    expect(effects.executeCwdChangedHooks).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
  });

  test("retains clear, dispatch, and notifier effects for a non-simple owner", async () => {
    await runWithAgentRuntimeOptions(
      resolveAgentRuntimeOptions({}, { simpleMode: false }),
      () => onCwdChangedForHooks("/old", "/new"),
    );

    expect(effects.clearCwdEnvFiles).toHaveBeenCalledOnce();
    expect(effects.executeCwdChangedHooks).toHaveBeenCalledWith(
      "/old",
      "/new",
    );
    expect(notifier.mock.calls).toEqual([
      ["cwd hook message", false],
      ["cwd hook failed", true],
    ]);
  });
});
