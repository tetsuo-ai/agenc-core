import { beforeEach, describe, expect, test, vi } from "vitest";

import { resolveSessionReasoningEffort } from "../../src/phases/stream-model.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import { defaultConfig } from "../../src/config/schema.js";

const settingsEffort = vi.hoisted(() => ({
  current: undefined as "low" | "medium" | "high" | "xhigh" | "max" | undefined,
}));

vi.mock("../../src/utils/effort.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/effort.js")>();
  return {
    ...actual,
    getInitialEffortSetting: () => settingsEffort.current,
  };
});

const GROK_4_6_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const GROK_4_5_LEVELS = ["low", "medium", "high"] as const;
const ZAI_GLM_53_LEVELS = ["low", "high", "max"] as const;
const META_SPARK_13_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

describe("resolveSessionReasoningEffort", () => {
  beforeEach(() => {
    settingsEffort.current = undefined;
  });

  test("explicit per-session effort wins as-is", () => {
    expect(resolveSessionReasoningEffort("low")).toBe("low");
    expect(resolveSessionReasoningEffort("medium")).toBe("medium");
    expect(resolveSessionReasoningEffort("high")).toBe("high");
    expect(resolveSessionReasoningEffort("xhigh")).toBe("xhigh");
  });

  test("an explicit 'none' opts the session out of the wire parameter", () => {
    expect(resolveSessionReasoningEffort("none")).toBeUndefined();
    settingsEffort.current = "max";
    expect(resolveSessionReasoningEffort("none", GROK_4_6_LEVELS)).toBeUndefined();
  });

  test("falls back to the persisted effortLevel and only emits wire values", () => {
    settingsEffort.current = "medium";
    expect(resolveSessionReasoningEffort(undefined)).toBe("medium");
    settingsEffort.current = undefined;
    expect(resolveSessionReasoningEffort(undefined)).toBeUndefined();
  });

  test("a persisted xhigh (stored as max) reaches the wire as xhigh on grok-4.6", () => {
    // config.toml `reasoning_effort = "xhigh"` is persisted as the settings
    // level `max`; before the fix it fell through the switch and no
    // `reasoning.effort` was sent at all.
    settingsEffort.current = "max";
    expect(resolveSessionReasoningEffort(undefined, GROK_4_6_LEVELS)).toBe(
      "xhigh",
    );
  });

  test("a persisted xhigh clamps to high on a model without xhigh", () => {
    settingsEffort.current = "max";
    expect(resolveSessionReasoningEffort(undefined, GROK_4_5_LEVELS)).toBe(
      "high",
    );
    // An empty catalog list cannot confirm xhigh support either.
    expect(resolveSessionReasoningEffort(undefined, [])).toBe("high");
  });

  test("an explicit session xhigh or max is clamped by the model's levels", () => {
    expect(resolveSessionReasoningEffort("xhigh", GROK_4_6_LEVELS)).toBe("xhigh");
    expect(resolveSessionReasoningEffort("max", GROK_4_6_LEVELS)).toBe("xhigh");
    expect(resolveSessionReasoningEffort("xhigh", GROK_4_5_LEVELS)).toBe("high");
    expect(resolveSessionReasoningEffort("max", GROK_4_5_LEVELS)).toBe("high");
    expect(resolveSessionReasoningEffort("high", GROK_4_5_LEVELS)).toBe("high");
  });

  test("preserves Z.ai's literal max effort instead of translating it to xhigh", () => {
    settingsEffort.current = "max";
    expect(resolveSessionReasoningEffort(undefined, ZAI_GLM_53_LEVELS)).toBe(
      "max",
    );
    expect(resolveSessionReasoningEffort("max", ZAI_GLM_53_LEVELS)).toBe(
      "max",
    );
    // A session snapshot may carry the historical persisted xhigh spelling.
    expect(resolveSessionReasoningEffort("xhigh", ZAI_GLM_53_LEVELS)).toBe(
      "max",
    );
  });

  test.each(["max", "xhigh"] as const)("preserves Spark 1.3 %s from session or settings", (effort) => {
    settingsEffort.current = effort;
    expect(resolveSessionReasoningEffort(undefined, META_SPARK_13_LEVELS)).toBe(effort);
    expect(resolveSessionReasoningEffort(effort, META_SPARK_13_LEVELS)).toBe(effort);
  });
});

describe("Gemini session reasoning effort", () => {
  const selection = { provider: "gemini", model: "gemini-3.1-pro-preview" };

  beforeEach(() => { settingsEffort.current = undefined; });

  test.each(["low", "medium", "high"] as const)("preserves configured and stamped %s", (effort) => {
    settingsEffort.current = effort;
    expect(resolveSessionReasoningEffort(undefined, GROK_4_5_LEVELS, selection)).toBe(effort);
    expect(resolveSessionReasoningEffort(effort, GROK_4_5_LEVELS, selection)).toBe(effort);
    expect(resolveSessionReasoningEffort("none", GROK_4_5_LEVELS, selection)).toBeUndefined();
  });

  test("leaves an unconfigured Gemini effort absent", () => {
    expect(resolveSessionReasoningEffort(undefined, GROK_4_5_LEVELS, selection)).toBeUndefined();
  });

  test("does not apply the daemon's built-in Grok default after a Gemini switch", () => {
    settingsEffort.current = "medium";
    const defaultSelection = { ...selection, effortSource: "default" };
    expect(resolveSessionReasoningEffort(undefined, GROK_4_5_LEVELS, defaultSelection)).toBeUndefined();
    expect(resolveSessionReasoningEffort("medium", GROK_4_5_LEVELS, defaultSelection)).toBe("medium");
    expect(resolveSessionReasoningEffort(undefined, GROK_4_5_LEVELS, { ...selection, effortSource: "user" })).toBe("medium");
  });

  test.each(["max", "xhigh"] as const)("never folds unsupported %s to high", (effort) => {
    expect(() => resolveSessionReasoningEffort(effort, GROK_4_5_LEVELS, selection)).toThrow(/reasoning effort/iu);
    settingsEffort.current = effort;
    expect(() => resolveSessionReasoningEffort(undefined, GROK_4_5_LEVELS, selection)).toThrow(/reasoning effort/iu);
  });
});

describe("sessionConfigurationFromAgenCConfig reasoning effort seeding", () => {
  test.each(["max", "xhigh"] as const)("retains configured Spark 1.3 %s", (effort) => {
    const configured = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), model_provider: "meta", reasoning_effort: effort },
      workspaceRoot: "/tmp/ws",
      model: "muse-spark-1.3",
    });
    expect(configured.collaborationMode.reasoningEffort).toBe(effort);
  });

  test("retains native max for other catalog providers", () => {
    for (const [provider, model] of [["zai", "glm-5.3"], ["kimi", "kimi-k3"]] as const) {
      const configured = sessionConfigurationFromAgenCConfig({
        config: { ...defaultConfig(), reasoning_effort: "max" },
        provider,
        workspaceRoot: "/tmp/ws",
        model,
      });
      expect(configured.collaborationMode.reasoningEffort).toBe("max");
    }
  });

  test.each(["muse-spark-1.2", "muse-spark-1.3-contributor", "muse-spark-1.3-unverified", "meta/muse-spark-1.3-unverified"])("keeps the legacy max alias for %s", (model) => {
    const configured = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), reasoning_effort: "max" },
      provider: "meta",
      workspaceRoot: "/tmp/ws",
      model,
    });
    expect(configured.collaborationMode.reasoningEffort).toBe("xhigh");
  });
  test("seeds collaborationMode.reasoningEffort from config.reasoning_effort", () => {
    const configured = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), reasoning_effort: "xhigh" },
      workspaceRoot: "/tmp/ws",
      model: "grok-4.6",
    });
    expect(configured.collaborationMode).toEqual({
      model: "grok-4.6",
      reasoningEffort: "xhigh",
    });
  });

  test("maps the persisted max alias to xhigh and leaves an unset effort absent", () => {
    const aliased = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), reasoning_effort: "max" },
      workspaceRoot: "/tmp/ws",
      model: "grok-4.6",
    });
    expect(aliased.collaborationMode.reasoningEffort).toBe("xhigh");

    const { reasoning_effort: _unset, ...withoutEffort } = defaultConfig();
    const unset = sessionConfigurationFromAgenCConfig({
      config: withoutEffort,
      workspaceRoot: "/tmp/ws",
      model: "grok-4.6",
    });
    expect(unset.collaborationMode).toEqual({ model: "grok-4.6" });
  });
});
