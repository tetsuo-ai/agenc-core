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
  });

  test("uses ASCII glyphs when explicitly requested", () => {
    expect(resolveAgenCTuiGlyphMode({ AGENC_TUI_GLYPHS: "ascii" })).toBe(
      "ascii",
    );
    expect(selectAgenCTuiGlyphs({ AGENC_TUI_GLYPHS: "ascii" })).toEqual({
      arrowDown: "v",
      pointer: ">",
    });
  });
});
