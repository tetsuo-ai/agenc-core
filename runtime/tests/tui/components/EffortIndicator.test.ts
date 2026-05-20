import { describe, expect, test, vi } from "vitest";

import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
} from "../../constants/figures.js";
import {
  effortLevelToSymbol,
  getEffortNotificationText,
} from "./EffortIndicator.js";

vi.mock("../../utils/effort.js", () => ({
  getDisplayedEffortLevel: (_model: string, effortValue: string | undefined) =>
    effortValue ?? "medium",
  modelSupportsEffort: (model: string) => model !== "basic-model",
}));

describe("EffortIndicator", () => {
  test("builds effort notification text for supported models", () => {
    expect(getEffortNotificationText("low", "reasoning-model")).toBe(
      `${EFFORT_LOW} low · /effort`,
    );
    expect(getEffortNotificationText(undefined, "reasoning-model")).toBe(
      `${EFFORT_MEDIUM} medium · /effort`,
    );
  });

  test("omits effort notification text for unsupported models", () => {
    expect(getEffortNotificationText("high", "basic-model")).toBeUndefined();
  });

  test("maps every effort level to a symbol", () => {
    expect(effortLevelToSymbol("low")).toBe(EFFORT_LOW);
    expect(effortLevelToSymbol("medium")).toBe(EFFORT_MEDIUM);
    expect(effortLevelToSymbol("high")).toBe(EFFORT_HIGH);
    expect(effortLevelToSymbol("max")).toBe(EFFORT_MAX);
  });

  test("falls back to the high symbol for unknown remote effort levels", () => {
    expect(effortLevelToSymbol("unknown" as never)).toBe(EFFORT_HIGH);
  });
});
