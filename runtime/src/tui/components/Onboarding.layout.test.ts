import { describe, expect, test } from "vitest";

import {
  calculateOnboardingBodyWidth,
  shouldShowOnboardingWelcomeBanner,
} from "./Onboarding.layout.js";

describe("Onboarding layout budget", () => {
  test.each([
    [0, 1],
    [3, 1],
    [20, 16],
    [72, 68],
    [100, 70],
  ])("clamps body width for terminal width %i", (columns, expected) => {
    expect(calculateOnboardingBodyWidth(columns)).toBe(expected);
  });

  test.each([
    [0, false],
    [13, false],
    [14, true],
    [30, true],
  ])("controls welcome banner visibility for terminal height %i", (rows, expected) => {
    expect(shouldShowOnboardingWelcomeBanner(rows)).toBe(expected);
  });
});
