import { describe, expect, test } from "vitest";

import {
  ANTHROPIC_FAST_MODE_BETA_HEADER,
  anthropicFastModeRequested,
  anthropicSupportsFastMode,
} from "../../../../src/llm/providers/anthropic/fast-mode.js";

describe("anthropic fast mode", () => {
  test("names the beta header the docs require", () => {
    expect(ANTHROPIC_FAST_MODE_BETA_HEADER).toBe("fast-mode-2026-02-01");
  });

  test.each([
    "claude-opus-5",
    "claude-opus-4-8",
    "anthropic/claude-opus-5",
    " Claude-Opus-4-8 ",
    "claude-opus-5-20260601",
  ])("accepts %s", (model) => {
    expect(anthropicSupportsFastMode(model)).toBe(true);
  });

  test.each([
    "claude-sonnet-5",
    "claude-fable-5-1",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-8-preview",
    "claude-haiku-4.5",
  ])("rejects %s", (model) => {
    expect(anthropicSupportsFastMode(model)).toBe(false);
  });

  test("only the priority service tier asks for fast mode", () => {
    expect(anthropicFastModeRequested({ serviceTier: "priority" })).toBe(true);
    expect(anthropicFastModeRequested({ serviceTier: "flex" })).toBe(false);
    expect(anthropicFastModeRequested({})).toBe(false);
    expect(anthropicFastModeRequested(undefined)).toBe(false);
  });
});
