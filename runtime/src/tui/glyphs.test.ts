import { describe, expect, test } from "vitest";

import {
  resolveAgenCTuiGlyphMode,
  selectAgenCTuiGlyphs,
} from "./glyphs.js";

describe("AgenC TUI glyph selection", () => {
  test("uses unicode glyphs by default", () => {
    expect(resolveAgenCTuiGlyphMode({})).toBe("unicode");
    expect(selectAgenCTuiGlyphs({}).arrowDown).not.toBe("v");
    expect(selectAgenCTuiGlyphs({}).pointer).not.toBe(">");
    expect(selectAgenCTuiGlyphs({}).horizontal).toBe("─");
    expect(selectAgenCTuiGlyphs({}).responseGutter).toBe("⎿");
    expect(selectAgenCTuiGlyphs({}).titleStaticPrefix).toBe("✳");
  });

  test("uses ASCII glyphs when explicitly requested", () => {
    expect(resolveAgenCTuiGlyphMode({ AGENC_TUI_GLYPHS: "ascii" })).toBe(
      "ascii",
    );
    expect(selectAgenCTuiGlyphs({ AGENC_TUI_GLYPHS: "ascii" })).toEqual({
      arrowUp: "^",
      arrowDown: "v",
      enter: "Enter",
      horizontal: "-",
      modalDivider: "-",
      mcpResource: "*",
      pointer: ">",
      promptBypass: ">",
      responseGutter: "|_",
      separator: "-",
      statusDot: "*",
      titleAnimationFrames: ["*", "+"],
      titleStaticPrefix: "*",
    });
  });
});
