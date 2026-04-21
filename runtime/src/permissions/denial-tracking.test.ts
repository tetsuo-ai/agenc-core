/**
 * Tests for denial-tracking primitives (T11 Wave 1-B / I-3).
 */

import { describe, expect, it } from "vitest";
import {
  DENIAL_LIMITS,
  freshDenialTracking,
  handleDenialLimitExceeded,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from "./denial-tracking.js";

describe("DENIAL_LIMITS", () => {
  it("matches openclaude's live values (3 consecutive, 20 total)", () => {
    expect(DENIAL_LIMITS.maxConsecutive).toBe(3);
    expect(DENIAL_LIMITS.maxTotal).toBe(20);
  });
});

describe("state helpers", () => {
  it("freshDenialTracking starts at zero/zero", () => {
    expect(freshDenialTracking()).toEqual({
      consecutiveDenials: 0,
      totalDenials: 0,
    });
  });

  it("recordDenial increments both counters and returns a new object", () => {
    const a = freshDenialTracking();
    const b = recordDenial(a);
    const c = recordDenial(b);
    expect(b).toEqual({ consecutiveDenials: 1, totalDenials: 1 });
    expect(c).toEqual({ consecutiveDenials: 2, totalDenials: 2 });
    // Immutability
    expect(a).toEqual({ consecutiveDenials: 0, totalDenials: 0 });
    expect(b).not.toBe(c);
  });

  it("recordSuccess resets consecutive only; totalDenials is preserved", () => {
    let state = freshDenialTracking();
    state = recordDenial(state);
    state = recordDenial(state);
    expect(state.consecutiveDenials).toBe(2);
    expect(state.totalDenials).toBe(2);
    const after = recordSuccess(state);
    expect(after.consecutiveDenials).toBe(0);
    expect(after.totalDenials).toBe(2);
  });

  it("recordSuccess is a no-op identity when consecutive is already zero", () => {
    const state = freshDenialTracking();
    expect(recordSuccess(state)).toBe(state);
  });
});

describe("shouldFallbackToPrompting", () => {
  it("returns false when both counters are under caps", () => {
    expect(
      shouldFallbackToPrompting({ consecutiveDenials: 2, totalDenials: 19 }),
    ).toBe(false);
  });

  it("returns true when consecutive cap is hit", () => {
    expect(
      shouldFallbackToPrompting({ consecutiveDenials: 3, totalDenials: 3 }),
    ).toBe(true);
  });

  it("returns true when total cap is hit independently", () => {
    expect(
      shouldFallbackToPrompting({ consecutiveDenials: 1, totalDenials: 20 }),
    ).toBe(true);
  });
});

describe("handleDenialLimitExceeded", () => {
  it("CLI: consecutive cap -> fallback (soft)", () => {
    const state = { consecutiveDenials: 3, totalDenials: 3 };
    const res = handleDenialLimitExceeded(state, "cli");
    expect(res.kind).toBe("fallback");
    if (res.kind === "fallback") {
      expect(res.nextState).toBe(state);
      expect(res.reason).toMatch(/consecutive/);
    }
  });

  it("headless: total cap -> abort", () => {
    const state = { consecutiveDenials: 1, totalDenials: 20 };
    const res = handleDenialLimitExceeded(state, "headless");
    expect(res.kind).toBe("abort");
    if (res.kind === "abort") {
      expect(res.reason).toMatch(/20 total permission denials/);
    }
  });

  it("CLI: total cap -> reset consecutive and fall back", () => {
    const state = { consecutiveDenials: 5, totalDenials: 20 };
    const res = handleDenialLimitExceeded(state, "cli");
    expect(res.kind).toBe("reset");
    if (res.kind === "reset") {
      expect(res.nextState.consecutiveDenials).toBe(0);
      expect(res.nextState.totalDenials).toBe(20);
    }
  });

  it("headless: consecutive cap alone does not abort (no prompt path available)", () => {
    const state = { consecutiveDenials: 3, totalDenials: 3 };
    const res = handleDenialLimitExceeded(state, "headless");
    expect(res.kind).toBe("continue");
  });

  it("under both caps -> continue", () => {
    const state = { consecutiveDenials: 1, totalDenials: 1 };
    expect(handleDenialLimitExceeded(state, "cli").kind).toBe("continue");
    expect(handleDenialLimitExceeded(state, "headless").kind).toBe("continue");
  });

  it("headless total cap takes precedence over consecutive cap", () => {
    const state = { consecutiveDenials: 3, totalDenials: 20 };
    const res = handleDenialLimitExceeded(state, "headless");
    expect(res.kind).toBe("abort");
  });
});

describe("local (per-request) denial tracking pattern", () => {
  it("mutating a per-request state does not leak into another state", () => {
    const sessionState = freshDenialTracking();
    // openclaude's async-subagent pattern: clone into a local scope where
    // setAppState is a no-op.
    const localState = { ...sessionState };
    const after = recordDenial(localState);
    expect(after).not.toBe(localState);
    expect(sessionState).toEqual({ consecutiveDenials: 0, totalDenials: 0 });
    expect(after).toEqual({ consecutiveDenials: 1, totalDenials: 1 });
  });
});
