import { describe, expect, it } from "vitest";

import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import {
  getAvailableEffortLevelsForContext,
  getDefaultEffortForModelForContext,
} from "../../src/utils/effort.js";

// The TUI offers what Core's own resolver accepts, the same source the wire
// layer validates against.
const context = (provider: string) => ({ provider, home: "/home/test" }) as never;

describe("effort levels follow Core", () => {
  it.each([
    ["deepseek", "deepseek-flash"],
    ["grok", "grok-4.6"],
    ["anthropic", "claude-opus-5-5"],
  ])("%s/%s offers Core's levels and default", (provider, model) => {
    const core = resolveReasoningEffort({ provider, model });

    expect(getAvailableEffortLevelsForContext(model, context(provider))).toEqual(core.levels);
    expect(getDefaultEffortForModelForContext(model, context(provider))).toBe(core.defaultLevel);
  });
});
