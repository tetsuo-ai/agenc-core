import React from "react";
import { describe, expect, it, vi } from "vitest";

// useInput flips the terminal into raw mode, which the non-TTY test stream
// does not support. The layout is what this file checks.
vi.mock("../../src/tui/ink/hooks/use-input.js", () => ({
  default: () => {},
}));

import { TerminalSizeContext } from "../../src/tui/ink/components/TerminalSizeContext.js";
import {
  WINDOWS_SANDBOX_CARD_COPY,
  WindowsSandboxDialog,
  windowsSandboxOptionLabel,
} from "../../src/permissions/WindowsSandboxDialog.js";
import { renderToString } from "../../src/utils/staticRender.js";

function renderCard(columns: number): Promise<string> {
  return renderToString(
    <TerminalSizeContext.Provider value={{ columns, rows: 30 }}>
      <WindowsSandboxDialog onContinue={() => {}} onQuit={() => {}} />
    </TerminalSizeContext.Provider>,
    { columns, rows: 30 },
  );
}

describe("WindowsSandboxDialog", () => {
  it("says there is no sandbox, that approvals stay, and offers quit or continue", async () => {
    const out = await renderCard(100);
    // Read the card as prose: drop the border and join wrapped lines.
    const flat = out.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
    expect(flat).toContain(WINDOWS_SANDBOX_CARD_COPY.title);
    expect(flat).toContain("AgenC has no sandbox on Windows yet.");
    expect(flat).toContain("run with your full Windows permissions");
    expect(flat).toContain("AgenC asks before each one.");
    expect(flat).toContain("[ Quit n ] [ Continue y ]");
    expect(flat).not.toContain("bypass");
  });

  it("keeps every line inside a narrow terminal", async () => {
    const out = await renderCard(50);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(50);
    }
  });

  it("labels the pressed button while its answer is saved", () => {
    expect(windowsSandboxOptionLabel("continue", null, false)).toBe("Continue");
    expect(windowsSandboxOptionLabel("quit", null, false)).toBe("Quit");
    expect(windowsSandboxOptionLabel("continue", "continue", true)).toBe("Saving...");
    expect(windowsSandboxOptionLabel("quit", "quit", true)).toBe("Quitting...");
    expect(windowsSandboxOptionLabel("quit", "continue", true)).toBe("Quit");
  });

  it("never uses an em dash in card copy", () => {
    expect(Object.values(WINDOWS_SANDBOX_CARD_COPY).join("\n")).not.toContain("—");
  });
});
