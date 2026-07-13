import { describe, expect, it } from "vitest";
import { optionsUpdatePlan } from "../../../../src/tui/components/CustomSelect/use-select-navigation.js";

// core-todo.md use-select-navigation.ts:549 — when a parent passes a
// fresh-but-equal `options` array each render, lastOptions was never refreshed
// (setLastOptions only ran on a reset), so the O(n) optionsNavigateEqual scan
// ran every render. lastOptions is now refreshed even on structural equality.

const opt = (value: string) => ({ value, label: value }) as never;

describe("optionsUpdatePlan", () => {
  it("does nothing when the reference is unchanged", () => {
    const a = [opt("x"), opt("y")];
    expect(optionsUpdatePlan(a, a)).toEqual({ reset: false, updateLast: false });
  });

  it("refreshes lastOptions WITHOUT resetting for a fresh-but-equal array", () => {
    const a = [opt("x"), opt("y")];
    const b = [opt("x"), opt("y")]; // different reference, equal content
    // updateLast MUST be true so the next same-reference render short-circuits.
    expect(optionsUpdatePlan(b, a)).toEqual({ reset: false, updateLast: true });
  });

  it("resets and refreshes when the contents changed", () => {
    const a = [opt("x"), opt("y")];
    const c = [opt("x"), opt("z")];
    expect(optionsUpdatePlan(c, a)).toEqual({ reset: true, updateLast: true });
  });
});
