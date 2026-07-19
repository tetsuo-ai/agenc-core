import { describe, expect, test } from "vitest";

import {
  resolveAgenCTuiGlyphMode,
  selectAgenCTuiGlyphs,
} from "./glyphs.js";

describe("AgenC TUI glyph selection", () => {
  test("uses unicode glyphs by default", () => {
    expect(resolveAgenCTuiGlyphMode({})).toBe("unicode");
    expect(selectAgenCTuiGlyphs({}).arrowDown).not.toBe("v");
    expect(selectAgenCTuiGlyphs({}).arrowLeft).not.toBe("<");
    expect(selectAgenCTuiGlyphs({}).arrowRight).not.toBe(">");
    expect(selectAgenCTuiGlyphs({}).pointer).not.toBe(">");
    expect(selectAgenCTuiGlyphs({}).ellipsis).toBe("…");
    expect(selectAgenCTuiGlyphs({}).horizontal).toBe("─");
    expect(selectAgenCTuiGlyphs({}).ideSelection).toBe("⧉");
    expect(selectAgenCTuiGlyphs({}).responseGutter).toBe("⎿");
    expect(selectAgenCTuiGlyphs({}).spinnerFrames).toEqual([
      "·",
      "✢",
      "✳",
      "✶",
      "✻",
      "✽",
    ]);
    expect(selectAgenCTuiGlyphs({}).spinnerReducedMotionDot).toBe("●");
    expect(selectAgenCTuiGlyphs({}).thinkingPrefix).toBe("∴");
    expect(selectAgenCTuiGlyphs({}).redactedThinkingPrefix).toBe("✻");
    expect(selectAgenCTuiGlyphs({}).statusError).toBe("✗");
    expect(selectAgenCTuiGlyphs({}).statusSuccess).toBe("✓");
    expect(selectAgenCTuiGlyphs({}).titleStaticPrefix).toBe("✳");
    expect(selectAgenCTuiGlyphs({}).treeBranch).toBe("├─");
    expect(selectAgenCTuiGlyphs({}).treeContinuation).toBe("│");
    expect(selectAgenCTuiGlyphs({}).treeLast).toBe("└─");
    expect(selectAgenCTuiGlyphs({}).treeSelectedBranch).toBe("╞═");
    expect(selectAgenCTuiGlyphs({}).voiceCursorBars).toBe(" ▁▂▃▄▅▆▇█");
  });

  test("uses ASCII glyphs when explicitly requested", () => {
    expect(resolveAgenCTuiGlyphMode({ AGENC_TUI_GLYPHS: "ascii" })).toBe(
      "ascii",
    );
    expect(selectAgenCTuiGlyphs({ AGENC_TUI_GLYPHS: "ascii" })).toEqual({
      arrowUp: "^",
      arrowDown: "v",
      arrowLeft: "<",
      arrowRight: ">",
      enter: "Enter",
      ellipsis: "...",
      horizontal: "-",
      ideSelection: "[]",
      modalDivider: "-",
      mcpResource: "*",
      pointer: ">",
      promptBypass: ">",
      responseGutter: "|_",
      redactedThinkingPrefix: "*",
      separator: "-",
      statusError: "ERR",
      statusSuccess: "OK",
      spinnerFrames: ["-", "\\", "|", "/"],
      spinnerReducedMotionDot: "*",
      statusDot: "*",
      thinkingEllipsis: "...",
      thinkingPrefix: "",
      titleAnimationFrames: ["*", "+"],
      titleStaticPrefix: "*",
      treeBranch: "|-",
      treeContinuation: "|",
      treeLast: "`-",
      treeRoot: ".-",
      treeSelectedBranch: "|>",
      treeSelectedLast: "`>",
      treeSelectedRoot: ".>",
      folderClosed: "[+]",
      folderOpen: "[-]",
      voiceCursorBars: " .:-=+*#@",
    });
  });
});
