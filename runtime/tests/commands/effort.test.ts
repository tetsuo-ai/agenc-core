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
import { RUN_RUNTIME_REASONING_EFFORTS } from "../../src/contracts/run-contracts.js";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { listRegisteredModelCatalogEntries } from "../../src/llm/registry/model-catalog.js";
import { getEffortNotificationText } from "../../src/tui/components/EffortIndicator.js";
import {
  getAvailableEffortLevelsForContext,
  getNativeDefaultReasoningEffortForContext,
  getSessionEffortLabelForContext,
  modelSupportsEffortForContext,
} from "../../src/utils/effort.js";

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
    readonly effortValue?: string;
  } = {},
) {
  const provider = options.provider ?? "grok";
  let appState: Record<string, unknown> =
    options.effortValue === undefined ? {} : { effortValue: options.effortValue };
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

  test("clears the running session's effort, so it follows the native none default", async () => {
    const { context, getAppState } = commandContext("mistral-medium-latest", "default", {
      provider: "mistral",
      effortValue: "high",
    });
    const applyDaemonConfig = vi.fn(async () => ({ sessionId: "s1", applied: true, summary: "ok" }));
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = applyDaemonConfig;

    const result = await effortCommand.execute(context);

    // No level is pinned: a later model switch must not carry "none" over.
    expect(applyDaemonConfig).toHaveBeenCalledExactlyOnceWith({ reasoningEffort: null });
    expect(settings.update).toHaveBeenCalledWith("userSettings", { reasoning_effort: undefined });
    expect(getAppState().effortValue).toBeUndefined();
    expect(result).toEqual({
      kind: "text",
      text: "Effort follows the mistral-medium-latest default (off).",
    });
  });

  test("sends the native default to a daemon that cannot clear an effort", async () => {
    const { context, getAppState } = commandContext("mistral-medium-latest", "default", {
      provider: "mistral",
      effortValue: "high",
    });
    const applyDaemonConfig = vi.fn(async (params: { reasoningEffort: string | null }) => {
      if (params.reasoningEffort === null) {
        throw Object.assign(
          new Error("session.applyConfig param 'reasoningEffort' must be a string"),
          { code: -32602 },
        );
      }
      return { sessionId: "s1", applied: true, summary: "ok" };
    });
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = applyDaemonConfig;

    const result = await effortCommand.execute(context);

    expect(applyDaemonConfig.mock.calls).toEqual([
      [{ reasoningEffort: null }],
      [{ reasoningEffort: "none" }],
    ]);
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

describe("/effort default sends only a truthful default", () => {
  beforeEach(() => settings.update.mockClear());

  const authContext = (provider: string) => ({ ...TEST_REMOTE_AUTH_SESSION_CONTEXT, provider });

  test("a registered model without a native default is cleared too", async () => {
    const { context, getAppState } = commandContext("moonshotai/kimi-k3", "default", {
      provider: "nvidia-nim",
      effortValue: "low",
    });
    const applyDaemonConfig = vi.fn(async () => ({ sessionId: "s1", applied: true, summary: "ok" }));
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = applyDaemonConfig;

    const result = await effortCommand.execute(context);

    // Clearing needs no guessed tier, so this model can follow its default too.
    expect(applyDaemonConfig).toHaveBeenCalledExactlyOnceWith({ reasoningEffort: null });
    expect(result).toEqual({
      kind: "text",
      text: "Effort follows the moonshotai/kimi-k3 default.",
    });
    expect(getAppState().effortValue).toBeUndefined();
  });

  test("a daemon that cannot clear keeps the effort when no native default is known", async () => {
    const { context, getAppState } = commandContext("moonshotai/kimi-k3", "default", {
      provider: "nvidia-nim",
      effortValue: "low",
    });
    const applyDaemonConfig = vi.fn(async () => {
      throw Object.assign(new Error("invalid params"), { code: -32602 });
    });
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = applyDaemonConfig;

    const result = await effortCommand.execute(context);

    // A guessed medium is not one of this model's levels, so nothing else is sent.
    expect(applyDaemonConfig).toHaveBeenCalledExactlyOnceWith({ reasoningEffort: null });
    expect(result).toEqual({
      kind: "text",
      text: "Saved: new sessions use the moonshotai/kimi-k3 default. This session keeps its current effort.",
    });
    expect(getAppState().effortValue).toBe("low");
  });

  test("a refused reset leaves the session's effort in app state", async () => {
    const { context, getAppState } = commandContext("mistral-medium-latest", "default", {
      provider: "mistral",
      effortValue: "high",
    });
    (context as { session: Record<string, unknown> }).session.applyDaemonConfig = vi.fn(async () => {
      throw new Error("Reasoning effort and response detail can only change between turns");
    });

    expect(await effortCommand.execute(context)).toMatchObject({ kind: "error" });
    // The status line reads app state, and the session still runs at high.
    expect(getAppState().effortValue).toBe("high");
    expect(getSessionEffortLabelForContext("mistral-medium-latest", "high", authContext("mistral")))
      .toBe("high effort");
  });

  test("every surface reads effort off at a native none default", async () => {
    const mistral = authContext("mistral");
    expect(getEffortNotificationText(undefined, "mistral-medium-latest", mistral)).toBe(
      "effort off · /effort",
    );
    expect(getSessionEffortLabelForContext("mistral-medium-latest", undefined, mistral)).toBe(
      "effort off",
    );
    const { context } = commandContext("mistral-medium-latest", "", { provider: "mistral" });
    const result = await effortCommand.execute(context);
    expect(result.kind === "text" ? result.text.split("\n")[0] : result).toBe("effort off");
    // No guessed tier where no truthful default is known.
    expect(getSessionEffortLabelForContext("moonshotai/kimi-k3", undefined, authContext("nvidia-nim")))
      .toBeNull();
    expect(getSessionEffortLabelForContext("gemini-3.5-flash", undefined, authContext("gemini")))
      .toBe("medium effort");
  });

  test("across the catalog, /effort default clears and every level it sends is one the daemon accepts", async () => {
    const accepts = (provider: string, model: string, value: string) =>
      (RUN_RUNTIME_REASONING_EFFORTS as readonly string[]).includes(value) &&
      resolveReasoningEffort({ provider, model }).levels.includes(value);
    const problems: string[] = [];
    let checked = 0;
    for (const { provider, model } of listRegisteredModelCatalogEntries()) {
      const auth = authContext(provider);
      if (!modelSupportsEffortForContext(model, auth)) continue;
      checked += 1;
      // A daemon from before clearing refuses null; /effort then retries
      // with the native default, the last value it sent.
      const send = async (argsRaw: string, canClear = true) => {
        const { context } = commandContext(model, argsRaw, { provider, effortValue: "high" });
        const applyDaemonConfig = vi.fn(async (params: { reasoningEffort: string | null }) => {
          if (params.reasoningEffort === null && !canClear) {
            throw Object.assign(new Error("invalid params"), { code: -32602 });
          }
          return { sessionId: "s1", applied: true, summary: "ok" };
        });
        (context as { session: Record<string, unknown> }).session.applyDaemonConfig = applyDaemonConfig;
        await effortCommand.execute(context);
        return (applyDaemonConfig.mock.calls.at(-1)?.[0] as
          | { reasoningEffort?: string | null }
          | undefined)?.reasoningEffort;
      };
      const reset = await send("default");
      if (reset !== null) problems.push(`${provider}/${model} default sent ${reset}`);
      const legacyReset = await send("default", false);
      const native = getNativeDefaultReasoningEffortForContext(model, auth);
      if (
        legacyReset !== null &&
        (legacyReset !== native || legacyReset === undefined || !accepts(provider, model, legacyReset))
      ) {
        problems.push(`${provider}/${model} default sent ${legacyReset} to a daemon that cannot clear`);
      }
      for (const level of getAvailableEffortLevelsForContext(model, auth)) {
        const sent = await send(level);
        if (typeof sent === "string" && !accepts(provider, model, sent)) {
          problems.push(`${provider}/${model} ${level} sent ${sent}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });
});
