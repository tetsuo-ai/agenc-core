import { describe, expect, it } from "vitest";
import {
  buildFrameText,
  maskSecret,
  shouldUseInteractiveOnboarding,
} from "./tui.js";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/gu;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

describe("interactive onboarding gating", () => {
  const ttyDeps = {
    stdin: { isTTY: true } as any,
    stdout: { isTTY: true } as any,
  };

  it("only enables the TUI for real human terminal sessions", () => {
    expect(shouldUseInteractiveOnboarding({}, ttyDeps)).toBe(true);
    expect(
      shouldUseInteractiveOnboarding({ "non-interactive": true }, ttyDeps),
    ).toBe(false);
    expect(shouldUseInteractiveOnboarding({ output: "json" }, ttyDeps)).toBe(
      false,
    );
    expect(
      shouldUseInteractiveOnboarding({ "output-format": "jsonl" }, ttyDeps),
    ).toBe(false);
    expect(
      shouldUseInteractiveOnboarding(
        {},
        {
          stdin: { isTTY: false } as any,
          stdout: { isTTY: true } as any,
        },
      ),
    ).toBe(false);
  });

  it("masks secrets without dropping the tail", () => {
    expect(maskSecret("xai-super-secret")).toMatch(/\*+cret$/);
    expect(maskSecret("123")).toBe("****");
  });

  it("fits the onboarding frame inside narrow terminals", () => {
    const rendered = buildFrameText({
      columns: 60,
      step: 1,
      totalSteps: 17,
      title: "Welcome",
      subtitle:
        "This wizard sets up your local xAI-powered AgenC agent, generates the core workspace files, and gives you a clean first-run starting point.",
      body: [
        "You will add an xAI API key, tune the agent identity and soul, confirm wallet/RPC basics, and review everything before it is written.",
        "Get your xAI API key from: https://console.x.ai/",
      ],
      footer: "Enter begin  Ctrl+C cancel",
    });
    const visibleLines = rendered.split("\n").map(stripAnsi);

    expect(visibleLines.length).toBeGreaterThan(4);
    expect(visibleLines.every((line) => line.length <= 60)).toBe(true);
    expect(visibleLines[0]).toMatch(/^\+-+\+$/u);
    expect(visibleLines.at(-1)).toMatch(/^\+-+\+$/u);
  });
});
