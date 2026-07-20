import { describe, expect, test } from "vitest";

import { resolveSessionReasoningEffort } from "../../src/phases/stream-model.js";

describe("resolveSessionReasoningEffort", () => {
  test("explicit per-session effort wins as-is", () => {
    expect(resolveSessionReasoningEffort("low")).toBe("low");
    expect(resolveSessionReasoningEffort("medium")).toBe("medium");
    expect(resolveSessionReasoningEffort("high")).toBe("high");
    expect(resolveSessionReasoningEffort("xhigh")).toBe("xhigh");
  });

  test("an explicit 'none' opts the session out of the wire parameter", () => {
    expect(resolveSessionReasoningEffort("none")).toBeUndefined();
  });

  test("falls back to the persisted effortLevel and only emits wire values", () => {
    // The persisted user settings of the machine running the tests drive the
    // fallback; the contract is that the result is always wire-sendable
    // (never "none"/"max") and never throws for a session without effort.
    const value = resolveSessionReasoningEffort(undefined);
    expect([undefined, "low", "medium", "high", "xhigh"]).toContain(value);
  });
});
