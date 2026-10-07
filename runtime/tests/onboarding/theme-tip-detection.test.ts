import { describe, expect, it, vi } from "vitest";

// M-ONB-2: the onboarding theme tip asserted "your terminal
// background looks <x>" from getTerminalBackground(), which defaults to 'dark' when
// unmeasured — so a light-terminal user (no $COLORFGBG) was told dark reads best,
// the exact inverted advice. The tip now only gives a direction when detected.

const themeState = { name: "dark" as "dark" | "light", detected: false };

vi.mock("../../src/utils/terminalBackground.js", () => ({
  getTerminalBackground: () => themeState.name,
  isTerminalBackgroundDetected: () => themeState.detected,
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
    // Mentions BOTH directions rather than asserting the guessed dark.
    expect(tip).toBe('Tip: pick "light" on a light terminal and "dark" on a dark one.');
    expect(tip).not.toContain("looks dark");
  });

  it("gives a directional recommendation when the background is measured", () => {
    themeState.detected = true;
    themeState.name = "light";
    const tip = themeTip();
    expect(tip).toContain("your terminal looks light");
    expect(tip).toContain('"light" or "auto"');
  });
});
