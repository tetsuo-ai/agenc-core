import { describe, expect, test } from "vitest";

import {
  anthropicAcceptsEffort,
  anthropicAcceptsSamplingParameters,
  anthropicEffort,
  anthropicEffortLevels,
  anthropicManualBudgetTokens,
  anthropicThinkingControl,
} from "../../../src/utils/model/anthropicThinkingControl.js";
import { isAlwaysOnThinkingAnthropicModel } from "../../../src/utils/model/alwaysOnThinking.js";

describe("anthropicThinkingControl", () => {
  test("classifies every generation the way the Messages API answered on 2026-09-11", () => {
    expect(anthropicThinkingControl("claude-fable-5-1")).toBe("always_on");
    expect(anthropicThinkingControl("claude-fable-5")).toBe("always_on");
    expect(anthropicThinkingControl("us.anthropic.agenc-fable-5-1-v1")).toBe("always_on");
    for (const model of [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "us.anthropic.agenc-opus-4-8-v1",
      "claude-opus-4.8",
    ]) {
      expect(anthropicThinkingControl(model), model).toBe("adaptive");
    }
    for (const model of [
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-3-7-sonnet-20250219",
    ]) {
      expect(anthropicThinkingControl(model), model).toBe("budget");
    }
  });

  // platform.claude.com, 2026-09-22: Opus 5.5 is "Adaptive only, Always on,
  // rejects enabled and disabled" (thinking troubleshooting table), takes all
  // five effort levels with medium as the default (effort doc), and rejects
  // sampling parameters like every model from Opus 4.7 on.
  test("Opus 5.5 is always-on while Opus 5 and its snapshots stay adaptive", () => {
    for (const model of [
      "claude-opus-5-5",
      "anthropic.claude-opus-5-5",
      "us.anthropic.agenc-opus-5-5-v1",
      "anthropic/claude-opus-5-5",
      "claude-opus-5.5",
      "claude-opus-5-5[1m]",
    ]) {
      expect(isAlwaysOnThinkingAnthropicModel(model), model).toBe(true);
      expect(anthropicThinkingControl(model), model).toBe("always_on");
      expect(anthropicAcceptsSamplingParameters(model), model).toBe(false);
      expect(anthropicAcceptsEffort(model), model).toBe(true);
    }
    for (const model of [
      "claude-opus-5",
      "claude-opus-5-20260601",
      "us.anthropic.agenc-opus-5-v1",
      "claude-opus-5-50",
    ]) {
      expect(isAlwaysOnThinkingAnthropicModel(model), model).toBe(false);
    }
    expect(anthropicThinkingControl("claude-opus-5")).toBe("adaptive");
    expect(anthropicThinkingControl("claude-opus-5-20260601")).toBe("adaptive");
  });

  test("Opus 5.5 offers all five effort levels", () => {
    const all = ["low", "medium", "high", "xhigh", "max"];
    expect(anthropicEffortLevels("claude-opus-5-5")).toEqual(all);
    expect(anthropicEffortLevels("us.anthropic.agenc-opus-5-5-v1")).toEqual(all);
    expect(anthropicEffortLevels("claude-opus-5.5")).toEqual(all);
    // The neighbours keep their own rows.
    expect(anthropicEffortLevels("claude-opus-5")).toEqual(all);
    expect(anthropicEffortLevels("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
  });

  test("effort is accepted on the always-on and adaptive families and on Opus 4.5 only", () => {
    expect(anthropicAcceptsEffort("claude-fable-5-1")).toBe(true);
    expect(anthropicAcceptsEffort("claude-sonnet-5")).toBe(true);
    expect(anthropicAcceptsEffort("claude-opus-4-5-20251101")).toBe(true);
    expect(anthropicAcceptsEffort("claude-sonnet-4-5-20250929")).toBe(false);
    expect(anthropicAcceptsEffort("claude-haiku-4-5")).toBe(false);
  });

  test("maps the runtime ladder onto Claude's", () => {
    expect(anthropicEffort("minimal")).toBe("low");
    expect(anthropicEffort("low")).toBe("low");
    expect(anthropicEffort("xhigh")).toBe("xhigh");
    expect(anthropicEffort("max")).toBe("max");
    expect(anthropicEffort("none")).toBeUndefined();
    expect(anthropicEffort(undefined)).toBeUndefined();
  });

  test("manual budgets clamp below max_tokens and reject caps under 1025", () => {
    expect(anthropicManualBudgetTokens("xhigh", 5000)).toBe(4096);
    expect(anthropicManualBudgetTokens("low", 3000)).toBe(2048);
    expect(anthropicManualBudgetTokens("high", 4096)).toBe(4095);
    expect(() => anthropicManualBudgetTokens("high", 1024)).toThrow(
      "budget_tokens >= 1024 and below max_tokens (1024)",
    );
  });
});
