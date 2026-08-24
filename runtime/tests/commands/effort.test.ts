import { beforeEach, describe, expect, test, vi } from "vitest";

const settings = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock("../../src/utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({}),
  getSettingsForSource: () => ({}),
  updateSettingsForSource: settings.update,
}));

import { effortCommand } from "../../src/commands/effort.js";

function commandContext(model: string, argsRaw: string) {
  let appState: Record<string, unknown> = {};
  const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
    appState = updater(appState) as Record<string, unknown>;
  });
  return {
    context: {
      session: {
        sessionConfiguration: {
          provider: { slug: "grok" },
          collaborationMode: { model },
        },
      },
      argsRaw,
      cwd: "/repo",
      home: "/home/test",
      appState: {
        getAppState: () => appState,
        setAppState,
      },
    } as never,
    getAppState: () => appState,
  };
}

describe("/effort Grok catalog levels", () => {
  beforeEach(() => {
    settings.update.mockReset();
  });

  test("sets grok-4.6 xhigh through the canonical reasoning_effort setting", async () => {
    const { context, getAppState } = commandContext("grok-4.6", "xhigh");

    const result = await effortCommand.execute(context);

    expect(result).toMatchObject({ kind: "text" });
    if (result.kind === "text") {
      expect(result.text).toContain("xhigh effort set for grok-4.6");
    }
    expect(settings.update).toHaveBeenCalledWith("userSettings", {
      reasoning_effort: "xhigh",
    });
    expect(getAppState()).toMatchObject({ effortValue: "xhigh" });
  });

  test("keeps xhigh unavailable for grok-4.5", async () => {
    const { context } = commandContext("grok-4.5", "xhigh");

    const result = await effortCommand.execute(context);

    expect(result).toEqual({
      kind: "error",
      message:
        "grok-4.5 does not support 'xhigh' effort. Available: low, medium, high.",
    });
    expect(settings.update).not.toHaveBeenCalled();
  });
});
