import { describe, expect, it, vi } from "vitest";

// M-ONB-2 (core-todo.md): the onboarding theme tip asserted "your terminal
// background looks <x>" from getSystemThemeName(), which defaults to 'dark' when
// unmeasured — so a light-terminal user (no $COLORFGBG) was told dark reads best,
// the exact inverted advice. The tip now only gives a direction when detected.

const themeState = { name: "dark" as "dark" | "light", detected: false };

vi.mock("../../src/utils/systemTheme.js", () => ({
  getSystemThemeName: () => themeState.name,
  isSystemThemeDetected: () => themeState.detected,
}));

const { detailLinesForStep } = await import("../../src/onboarding/Onboarding.js");

function themeTip(): string {
  const state = { currentStepId: "theme", selectedTheme: "dark" } as never;
  const lines = detailLinesForStep(state, {} as never);
  const tip = lines.find((line) => line.startsWith("Tip:"));
  if (tip === undefined) throw new Error("no theme tip line produced");
  return tip;
}

describe("onboarding theme tip", () => {
  it("gives no directional advice when the background is undetected", () => {
    themeState.detected = false;
    themeState.name = "dark"; // the defaulted guess
    const tip = themeTip();
    expect(tip).toContain("couldn't detect");
    // Mentions BOTH directions rather than asserting the guessed dark.
    expect(tip).toContain('"light"');
    expect(tip).toContain('"dark"');
    expect(tip).not.toContain("looks dark");
  });

  it("gives a directional recommendation when the background is measured", () => {
    themeState.detected = true;
    themeState.name = "light";
    const tip = themeTip();
    expect(tip).toContain("looks light");
    expect(tip).toContain('"light" or "system"');
  });
});
