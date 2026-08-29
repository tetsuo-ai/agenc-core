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
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from "../remoteAuthSessionContext.fixture.js";

vi.mock("../../utils/effort.js", () => ({
  getDisplayedEffortLevelForContext: (_model: string, effortValue: string | undefined) =>
    effortValue ?? "medium",
  modelSupportsEffortForContext: (model: string) => model !== "basic-model",
}));

describe("EffortIndicator", () => {
  test("builds effort notification text for supported models", () => {
    expect(getEffortNotificationText("low", "reasoning-model", TEST_REMOTE_AUTH_SESSION_CONTEXT)).toBe(
      `${EFFORT_LOW} low · /effort`,
    );
    expect(getEffortNotificationText(undefined, "reasoning-model", TEST_REMOTE_AUTH_SESSION_CONTEXT)).toBe(
      `${EFFORT_MEDIUM} medium · /effort`,
    );
  });

  test("omits effort notification text for unsupported models", () => {
    expect(getEffortNotificationText("high", "basic-model", TEST_REMOTE_AUTH_SESSION_CONTEXT)).toBeUndefined();
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
