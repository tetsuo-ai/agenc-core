/**
 * Plan-state helper tests (T12 Wave 4-C).
 *
 * Covers the `isPlanActive` reducer used by the App root / Banner to
 * light up the `hasPlanActive` indicator from the same plan-event
 * stream that `<PlanProgress>` renders.
 */

import { describe, expect, test } from "vitest";

import { isPlanActive, type PlanEvent } from "./plan-state.js";

describe("isPlanActive", () => {
  test("returns false for an empty event list", () => {
    expect(isPlanActive([])).toBe(false);
  });

  test("returns true after a single plan_started event", () => {
    const events: PlanEvent[] = [
      {
        kind: "plan_started",
        planItemId: "turn-1-plan",
        title: "draft",
        timestamp: 1,
      },
    ];
    expect(isPlanActive(events)).toBe(true);
  });

  test("returns false after plan_started followed by plan_exited", () => {
    const events: PlanEvent[] = [
      {
        kind: "plan_started",
        planItemId: "turn-1-plan",
        title: "draft",
        timestamp: 1,
      },
      { kind: "plan_exited", timestamp: 2 },
    ];
    expect(isPlanActive(events)).toBe(false);
  });

  test("latest wins — re-entering plan mode after exit", () => {
    const events: PlanEvent[] = [
      {
        kind: "plan_started",
        planItemId: "turn-1-plan",
        title: "first",
        timestamp: 1,
      },
      { kind: "plan_exited", timestamp: 2 },
      {
        kind: "plan_started",
        planItemId: "turn-2-plan",
        title: "second",
        timestamp: 3,
      },
    ];
    expect(isPlanActive(events)).toBe(true);
  });
});
