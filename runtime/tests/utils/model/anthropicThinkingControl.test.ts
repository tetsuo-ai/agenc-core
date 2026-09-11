import { describe, expect, test } from "vitest";

import {
  anthropicAcceptsEffort,
  anthropicEffort,
  anthropicThinkingControl,
} from "../../../src/utils/model/anthropicThinkingControl.js";

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
});
