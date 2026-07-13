import { describe, expect, it } from "vitest";
import { writeDiffToTerminal, type Terminal } from "../../../src/tui/ink/terminal.js";
import { getClearTerminalSequence } from "../../../src/tui/ink/clearTerminal.js";
import { ERASE_SCREEN, ERASE_SCROLLBACK } from "../../../src/tui/ink/termio/csi.js";

// M-TUI-2 (core-todo.md): engine-internal full resets (resize / offscreen) emit
// getClearTerminalSequence() which includes ESC[3J, erasing the user's scrollback
// above the app. ESC[3J must be reserved for an explicit clear (reason 'clear').

function capture(): { terminal: Terminal; output: () => string } {
  const chunks: string[] = [];
  const stdout = {
    write: (s: string) => {
      chunks.push(String(s));
      return true;
    },
  };
  return {
    terminal: { stdout, stderr: stdout } as unknown as Terminal,
    output: () => chunks.join(""),
  };
}

describe("getClearTerminalSequence — scrollback control", () => {
  it("wipes scrollback only when asked", () => {
    expect(getClearTerminalSequence(true)).toContain(ERASE_SCROLLBACK);
    expect(getClearTerminalSequence(false)).not.toContain(ERASE_SCROLLBACK);
    // The visible screen is always cleared regardless.
    expect(getClearTerminalSequence(false)).toContain(ERASE_SCREEN);
  });
});

describe("writeDiffToTerminal — clearTerminal reason gates ESC[3J", () => {
  for (const reason of ["resize", "offscreen"] as const) {
    it(`preserves scrollback on an engine-internal '${reason}' reset`, () => {
      const { terminal, output } = capture();
      writeDiffToTerminal(terminal, [{ type: "clearTerminal", reason }], true);
      expect(output()).toContain(ERASE_SCREEN);
      expect(output()).not.toContain(ERASE_SCROLLBACK);
    });
  }

  it("erases scrollback on an explicit 'clear' reset", () => {
    const { terminal, output } = capture();
    writeDiffToTerminal(terminal, [{ type: "clearTerminal", reason: "clear" }], true);
    expect(output()).toContain(ERASE_SCROLLBACK);
  });
});
