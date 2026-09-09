import { describe, expect, it } from "vitest";

import {
  freshDenialTracking,
  recordDenial,
  recordSuccess,
} from "../../src/permissions/denial-tracking.js";

/**
 * A run with nobody attached learns a road is closed only from the result it
 * just got. When a call fails it re-issues a variant, and because the variant
 * produces a different result hash the behavioural backstop's unchanged-result
 * invariant never trips. Refusals and execution failures therefore share one
 * streak, and a success clears it.
 *
 * This pins the counting contract the execution seam depends on. The seam
 * itself (noteUnproductiveCall in tools/execution.ts) appends its instruction
 * once the streak reaches three.
 */
describe("unattended unproductive-call streak", () => {
  const LIMIT = 3;

  it("reaches the limit only after three consecutive unproductive calls", () => {
    let state = freshDenialTracking();
    expect(state.consecutiveDenials).toBe(0);
    state = recordDenial(state);
    expect(state.consecutiveDenials).toBeLessThan(LIMIT);
    state = recordDenial(state);
    expect(state.consecutiveDenials).toBeLessThan(LIMIT);
    state = recordDenial(state);
    expect(state.consecutiveDenials).toBeGreaterThanOrEqual(LIMIT);
  });

  it("clears the streak on a call that got somewhere", () => {
    // Otherwise a long report that hits one refusal mid-way would start
    // telling itself to stop.
    let state = recordDenial(recordDenial(freshDenialTracking()));
    state = recordSuccess(state);
    expect(state.consecutiveDenials).toBe(0);
    state = recordDenial(state);
    expect(state.consecutiveDenials).toBeLessThan(LIMIT);
  });

  it("keeps the lifetime total across a cleared streak", () => {
    // The streak is about the road just taken; the total still catches a run
    // that alternates a success with a wall.
    let state = freshDenialTracking();
    for (let i = 0; i < 4; i += 1) state = recordSuccess(recordDenial(state));
    expect(state.consecutiveDenials).toBe(0);
    expect(state.totalDenials).toBe(4);
  });
});
