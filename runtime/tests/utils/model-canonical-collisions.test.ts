import { describe, expect, it } from "vitest";

import {
  firstPartyNameToCanonical,
  parseUserSpecifiedModel,
} from "../../src/utils/model/model.js";
import { modelSupportsAdaptiveThinking } from "../../src/utils/thinking.js";

// Minor model-capability/canonicalization fixes (core-todo.md):
//  - model.ts:500/:939 — ordered .includes('claude-opus-4-1') matched a future
//    claude-opus-4-10/-11, mislabeling it as 4.1.
//  - model.ts:812 — parseUserSpecifiedModel case 'best' dropped the [1m] suffix.
//  - thinking.ts:216 — modelSupportsAdaptiveThinking allowlist omitted opus-4-8.

describe("model canonicalization + capability minors", () => {
  it("does not collapse a future opus-4-10 onto opus-4-1", () => {
    // opus-4-1 stays 4-1; 4-10 must NOT map to 4-1 (falls through to bare opus-4).
    expect(firstPartyNameToCanonical("claude-opus-4-1" as never)).toBe("claude-opus-4-1");
    expect(firstPartyNameToCanonical("claude-opus-4-10" as never)).not.toBe(
      "claude-opus-4-1",
    );
    expect(firstPartyNameToCanonical("claude-opus-4-11" as never)).not.toBe(
      "claude-opus-4-1",
    );
    // Real current models still canonicalize correctly.
    expect(firstPartyNameToCanonical("claude-opus-4-8" as never)).toBe("claude-opus-4-8");
  });

  it("preserves the [1m] suffix for the 'best' alias", () => {
    const withTag = parseUserSpecifiedModel("best[1m]" as never);
    const withoutTag = parseUserSpecifiedModel("best" as never);
    expect(withTag).toBe(`${withoutTag}[1m]`);
    expect(withTag.endsWith("[1m]")).toBe(true);
  });

  it("enables adaptive thinking for opus-4-8", () => {
    expect(modelSupportsAdaptiveThinking("claude-opus-4-8")).toBe(true);
    // regression guard: 4-7/4-6 still supported.
    expect(modelSupportsAdaptiveThinking("claude-opus-4-7")).toBe(true);
  });
});
