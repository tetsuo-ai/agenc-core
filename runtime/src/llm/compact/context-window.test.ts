import { describe, expect, it } from "vitest";

import {
  AUTOCOMPACT_BUFFER_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
  buildCurrentContextUsageSnapshot,
  getAutoCompactThresholdTokens,
  getEffectiveContextWindowSize,
} from "./context-window.js";

describe("context-window helpers", () => {
  it("reserves output headroom before computing autocompact thresholds", () => {
    const effective = getEffectiveContextWindowSize(2_000_000, 131_072);
    expect(effective).toBe(1_980_000);
    expect(
      getAutoCompactThresholdTokens({
        contextWindowTokens: 2_000_000,
        maxOutputTokens: 131_072,
      }),
    ).toBe(effective! - AUTOCOMPACT_BUFFER_TOKENS);
  });

  it("assesses pressure from current-view tokens instead of cumulative session totals", () => {
    const snapshot = buildCurrentContextUsageSnapshot({
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "x".repeat(40_000) },
      ],
      contextWindowTokens: 64_000,
      maxOutputTokens: 4_096,
    });

    expect(snapshot.currentTokens).toBeGreaterThan(0);
    expect(snapshot.effectiveContextWindowTokens).toBe(59_904);
    expect(snapshot.autocompactThresholdTokens).toBe(46_904);
    expect(snapshot.blockingThresholdTokens).toBe(
      snapshot.effectiveContextWindowTokens! - MANUAL_COMPACT_BUFFER_TOKENS,
    );
    expect(snapshot.isAboveAutocompactThreshold).toBe(false);
  });
});
