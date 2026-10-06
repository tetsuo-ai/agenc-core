import { beforeEach, describe, expect, test, vi } from "vitest";
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from "../tui/remoteAuthSessionContext.fixture.js";

const settings = vi.hoisted(() => ({
  update: vi.fn(async () => ({ error: null })),
}));

vi.mock("../../src/utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({}),
  getSettingsForSource: () => ({}),
  updateSettingsForSource: settings.update,
}));

import { effortCommand } from "../../src/commands/effort.js";

function commandContext(
  model: string,
  argsRaw: string,
  options: {
    readonly provider?: string;
    readonly serviceSelection?: {
      readonly provider?: unknown;
      readonly model?: unknown;
    };
    readonly pendingSelection?: {
      readonly provider: string;
      readonly model: string;
    };
  } = {},
) {
  const provider = options.provider ?? "grok";
  let appState: Record<string, unknown> = {};
  const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
    appState = updater(appState) as Record<string, unknown>;
  });
  return {
    context: {
      session: {
        pendingProviderSwitch: options.pendingSelection ?? null,
        services: {
          configStore: {
            homeContext: TEST_REMOTE_AUTH_SESSION_CONTEXT.home,
          },
          providerEnvironment: TEST_REMOTE_AUTH_SESSION_CONTEXT.environment,
          providerService: {
            current: () =>
              options.serviceSelection ?? { provider, model },
            environment: () => TEST_REMOTE_AUTH_SESSION_CONTEXT.environment,
          },
        },
        sessionConfiguration: {
          provider: { slug: provider },
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

describe("/effort Gemini catalog levels", () => {
  beforeEach(() => settings.update.mockClear());

  test("displays the exact Pro levels and provider default", async () => {
    const { context } = commandContext("gemini-3.1-pro-preview", "", { provider: "gemini" });
    const result = await effortCommand.execute(context);
    expect(result).toMatchObject({ kind: "text" });
    if (result.kind === "text") {
      expect(result.text).toContain("high effort");
      expect(result.text).toContain("low, medium, high");
    }
  });

  test.each(["low", "medium", "high"])("sets Pro %s without translation", async (level) => {
    const { context, getAppState } = commandContext("gemini-3.1-pro-preview", level, { provider: "gemini" });
    expect(await effortCommand.execute(context)).toMatchObject({ kind: "text" });
    expect(settings.update).toHaveBeenCalledWith("userSettings", { reasoning_effort: level });
    expect(getAppState()).toMatchObject({ effortValue: level });
  });

  test.each(["minimal", "xhigh", "max"])("rejects unsupported Pro %s", async (level) => {
    const { context } = commandContext("gemini-3.1-pro-preview", level, { provider: "gemini" });
    const result = await effortCommand.execute(context);
    expect(result).toMatchObject({ kind: "error" });
    if (result.kind === "error") expect(result.message).toContain("Available: low, medium, high");
    expect(settings.update).not.toHaveBeenCalled();
  });

  test("allows minimal on Flash and resets to its documented default", async () => {
    const { context } = commandContext("gemini-3.5-flash", "minimal", { provider: "gemini" });
    expect(await effortCommand.execute(context)).toMatchObject({ kind: "text" });
    expect(settings.update).toHaveBeenLastCalledWith("userSettings", { reasoning_effort: "minimal" });
    const reset = commandContext("gemini-3.5-flash", "default", { provider: "gemini" });
    const result = await effortCommand.execute(reset.context);
    expect(result).toMatchObject({ kind: "text" });
    if (result.kind === "text") expect(result.text).toContain("default (medium)");
    expect(settings.update).toHaveBeenLastCalledWith("userSettings", { reasoning_effort: undefined });
  });

  test.each(["gemini-2.5-flash", "gemini-3.1-pro-preview-unverified"])("does not offer level controls for %s", async (model) => {
    const { context } = commandContext(model, "low", { provider: "gemini" });
    expect(await effortCommand.execute(context)).toMatchObject({ kind: "error" });
    expect(settings.update).not.toHaveBeenCalled();
  });
});

describe("/effort Grok catalog levels", () => {
  beforeEach(() => {
    settings.update.mockClear();
  });

  test("sets grok-4.6 xhigh through the canonical reasoning_effort setting", async () => {
    const { context, getAppState } = commandContext("grok-4.6", "xhigh");

    const result = await effortCommand.execute(context);

    expect(result).toMatchObject({ kind: "text" });
    if (result.kind === "text") {
      expect(result.text).toContain("xhigh effort for grok-4.6");
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

  test.each(["max", "xhigh"])("persists Spark 1.3 %s without aliasing it", async (effort) => {
    const { context, getAppState } = commandContext("muse-spark-1.3", effort, { provider: "meta" });
    expect(await effortCommand.execute(context)).toMatchObject({ kind: "text" });
    expect(settings.update).toHaveBeenCalledWith("userSettings", { reasoning_effort: effort });
    expect(getAppState()).toMatchObject({ effortValue: effort });
  });

  test.each(["muse-spark-1.2", "muse-spark-1.3-contributor", "muse-spark-1.3-unverified", "meta/muse-spark-1.3-unverified"])("does not offer literal max to %s", async (model) => {
    const { context } = commandContext(model, "max", { provider: "meta" });
    expect(await effortCommand.execute(context)).toMatchObject({ kind: "error" });
    expect(settings.update).not.toHaveBeenCalled();
  });

  test("ignores a provider-only service result instead of mixing authorities", async () => {
    const { context } = commandContext("private-model", "", {
      provider: "grok",
      serviceSelection: { provider: "anthropic" },
    });

    const result = await effortCommand.execute(context);

    expect(result).toEqual({
      kind: "text",
      text: "private-model does not support effort levels.",
    });
  });

  test("validates effort against the complete pair staged for the next turn", async () => {
    const { context } = commandContext("grok-4.5", "xhigh", {
      provider: "grok",
      pendingSelection: { provider: "openai", model: "gpt-5.2" },
    });

    const result = await effortCommand.execute(context);

    expect(result).toMatchObject({ kind: "text" });
    if (result.kind === "text") {
      expect(result.text).toContain("xhigh effort for gpt-5.2");
    }
    expect(settings.update).toHaveBeenCalledWith("userSettings", {
      reasoning_effort: "xhigh",
    });
  });
});

describe("/effort picker and live session", () => {
  beforeEach(() => settings.update.mockClear());

  test("opens a picker of the current model's levels", async () => {
    const { context } = commandContext("gemini-3.1-pro-preview", "", { provider: "gemini" });
    const setToolJSX = vi.fn();
    (context as { appState: Record<string, unknown> }).appState.setToolJSX = setToolJSX;

    const result = await effortCommand.execute(context);

    expect(result).toMatchObject({ kind: "skip" });
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({ isLocalJSXCommand: true }),
    );
  });

  test("applies the chosen level to the running session", async () => {
    const { context } = commandContext("gemini-3.1-pro-preview", "high", { provider: "gemini" });
    const applyDaemonConfig = vi.fn(async () => ({ sessionId: "s1", applied: true, summary: "ok" }));
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = applyDaemonConfig;

    const result = await effortCommand.execute(context);

    expect(result).toMatchObject({ kind: "text" });
    expect(applyDaemonConfig).toHaveBeenCalledWith({ reasoningEffort: "high" });
    expect(settings.update).toHaveBeenCalledWith("userSettings", { reasoning_effort: "high" });
  });

  test("keeps the saved choice when the first conversation has not started", async () => {
    const { context } = commandContext("gemini-3.1-pro-preview", "low", { provider: "gemini" });
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = vi.fn(async () => ({
      sessionId: "pending",
      applied: false,
      summary: "No live session exists; the first conversation will use the current config.",
    }));

    const result = await effortCommand.execute(context);

    expect(result).toMatchObject({ kind: "text" });
  });

  test("reports a save failure instead of claiming success", async () => {
    settings.update.mockResolvedValueOnce({ error: new Error("read-only settings") });
    const { context } = commandContext("gemini-3.1-pro-preview", "low", { provider: "gemini" });

    const result = await effortCommand.execute(context);

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind === "error") expect(result.message).toContain("read-only settings");
  });
});

describe("/effort default with a native none default", () => {
  beforeEach(() => settings.update.mockClear());

  test("sends the native none to the running session and says effort is off", async () => {
    const { context, getAppState } = commandContext("mistral-medium-latest", "default", {
      provider: "mistral",
    });
    const applyDaemonConfig = vi.fn(async () => ({ sessionId: "s1", applied: true, summary: "ok" }));
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = applyDaemonConfig;

    const result = await effortCommand.execute(context);

    // Never a guessed tier: the daemon only accepts none or high here.
    expect(applyDaemonConfig).toHaveBeenCalledExactlyOnceWith({ reasoningEffort: "none" });
    expect(settings.update).toHaveBeenCalledWith("userSettings", { reasoning_effort: undefined });
    expect(getAppState().effortValue).toBeUndefined();
    expect(result).toEqual({
      kind: "text",
      text: "Effort follows the mistral-medium-latest default (off).",
    });
  });

  test("a busy session that refuses the reset is reported, not claimed", async () => {
    const { context } = commandContext("mistral-medium-latest", "default", { provider: "mistral" });
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = vi.fn(async () => {
      throw new Error("Reasoning effort and response detail can only change between turns");
    });

    const result = await effortCommand.execute(context);

    expect(result).toEqual({
      kind: "error",
      message:
        "Saved for new sessions. This session did not take it: Reasoning effort and response detail can only change between turns",
    });
  });

  test("a session that answers not applied is reported too", async () => {
    const { context } = commandContext("mistral-medium-latest", "high", { provider: "mistral" });
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = vi.fn(async () => ({
      sessionId: "s1",
      applied: false,
      summary: "a turn is running",
    }));

    const result = await effortCommand.execute(context);

    expect(result).toEqual({
      kind: "error",
      message: "Saved for new sessions. This session did not take it: a turn is running",
    });
  });
});
